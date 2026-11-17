import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { availableParallelism, freemem, loadavg } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  AGENT_PROTOCOL,
  CHARACTERS,
  DECISION_TICKS,
  ENGINE_ID,
  GAME_MAX_TICKS,
  INSTRUCTIONS,
  LIMITS,
  LOCAL_PROTOCOL,
  TICK_HZ,
  matchCharacters,
  type AgentMode,
  type CharacterId,
} from './contract';
import {
  MatchFailure,
  runAgentMatch,
  verifyAgentReplay,
  type AgentReplayFile,
  type Contestant,
  type MatchJob,
  type MatchResult,
  type TraceLine,
} from './match';
import { AgentRuntime } from './runtime';
import { createStrategy, validCodeSize } from './sandbox';
import { BUILTIN_STRATEGIES, STARTER_STRATEGY, isDifficulty } from './strategies';

const HELP = `boomerang-agent — headless Boomerang Garden matches for decide(observation, memory) strategies
Engine ${ENGINE_ID} · protocol ${AGENT_PROTOCOL} · ${TICK_HZ} Hz, decide every ${DECISION_TICKS} frames

Commands
  contract                         Print the JSON agent contract
  init <dir>                       Create strategy.js, baseline.js, seeds.json and AGENTS.md
  check <strategy>                 Compile in the sandbox and play a short bounded smoke run
  test <strategy>                  Play one match and save result, replay and web replay
  batch <strategy> --games N       N seeds, each played from both seats
  compare <baseline> <candidate>   Same seeds, seats and opponent for both; paired summary
  replay <file.replay.json>        Re-simulate a replay and verify every frame hash
  serve [--connect]                Drive the runtime over JSON lines on stdio; --connect
                                   joins a MUNDI local runner (MUNDI_LOCAL_PORT/TOKEN)

<strategy> is a .js file or a built-in: starter, house, bot:easy|normal|hard|impossible
(bot:* is the web game's own AI at the same 6-frame cadence; it reads the full state).

Options
  --opponent <strategy>   Opponent (default house)
  --mode round|match      One round, or first to 14 net kills (default round)
  --seed N                Seed for test (default 1)
  --seeds a,b,c           Explicit seeds for batch/compare
  --seed-base N           First seed for --games (default 1000)
  --characters A,B        Two of ${CHARACTERS.join(', ')}
  --seat 0|1              Seat of the strategy in test (default 0)
  --out DIR               Output directory (default runs/<command>-<time>); must be empty
  --trace                 Write each decision's observations and actions (*.trace.jsonl)
  --web-replay            Save a browser replay too (always on for test)
  --jobs N                Parallel matches for batch/compare (default 1, at most 4)
  --max-ticks N           Simulation budget per match (default ${GAME_MAX_TICKS})
`;

type Flags = Record<string, string | true>;
const VALUE_FLAGS = new Set([
  '--opponent',
  '--mode',
  '--seed',
  '--seeds',
  '--seed-base',
  '--games',
  '--characters',
  '--seat',
  '--out',
  '--jobs',
  '--max-ticks',
]);
const BOOLEAN_FLAGS = new Set(['--trace', '--web-replay', '--connect', '--help']);

function parse(argv: string[]): { command: string; args: string[]; flags: Flags } {
  const [command = 'help', ...rest] = argv;
  const args: string[] = [],
    flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    if (VALUE_FLAGS.has(item)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${item} needs a value`);
      flags[item] = value;
    } else if (BOOLEAN_FLAGS.has(item)) flags[item] = true;
    else if (item.startsWith('--')) throw new Error(`Unknown option ${item}`);
    else args.push(item);
  }
  return { command, args, flags };
}

const say = (value: unknown) =>
  process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function integerFlag(flags: Flags, name: string, fallback: number, min: number, max: number) {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
const modeFlag = (flags: Flags): AgentMode => {
  const mode = flags['--mode'] ?? 'round';
  if (mode !== 'round' && mode !== 'match') throw new Error('--mode must be round or match');
  return mode;
};
const charactersFlag = (flags: Flags): [CharacterId, CharacterId] =>
  matchCharacters(
    typeof flags['--characters'] === 'string' ? flags['--characters'].split(',') : undefined,
  );

async function contestant(spec: string): Promise<Contestant> {
  if (spec.startsWith('bot:')) {
    const difficulty = spec.slice(4);
    if (!isDifficulty(difficulty)) throw new Error(`Unknown bot difficulty: ${difficulty}`);
    return { kind: 'bot', name: spec, difficulty };
  }
  const builtin = BUILTIN_STRATEGIES[spec];
  const code = builtin ?? (await readFile(resolve(spec), 'utf8'));
  if (!validCodeSize(code))
    throw new Error(`${spec}: strategy is empty or larger than ${LIMITS.codeBytes} bytes`);
  return {
    kind: 'code',
    name: builtin ? spec : basename(spec),
    code,
    hash: sha(code).slice(0, 16),
  };
}

async function outputDirectory(flags: Flags, command: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = resolve(
    typeof flags['--out'] === 'string' ? flags['--out'] : join('runs', `${command}-${stamp}`),
  );
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length)
    throw new Error(`${directory} is not empty; choose a new --out directory`);
  return directory;
}

/** Same spirit as the MUNDI runner: start small, never overload a shared machine. */
function plannedJobs(flags: Flags, matches: number): number {
  const requested = integerFlag(flags, '--jobs', 1, 1, 4);
  if (requested === 1) return 1;
  const cores = availableParallelism();
  const load = loadavg()[0] / cores;
  const memory = freemem() / 1024 ** 3;
  if (load > 0.8)
    throw new Error(`System load is ${(load * 100).toFixed(0)}%; refusing --jobs > 1`);
  const byCores = Math.max(1, Math.floor(cores / 2));
  const byMemory = Math.max(1, Math.floor((memory - 2) / 1));
  const jobs = Math.min(requested, byCores, byMemory, matches);
  if (jobs < requested)
    process.stderr.write(
      `Using ${jobs} job(s): ${cores} cores, ${memory.toFixed(1)} GiB free, load ${(load * 100).toFixed(0)}%\n`,
    );
  return jobs;
}

interface JobOptions {
  directory: string;
  trace: boolean;
  webReplay: boolean;
}
interface JobOutcome {
  id: string;
  ok: boolean;
  result?: MatchResult;
  error?: { message: string; side: number | null; tick: number; round: number };
}

async function executeJob(job: MatchJob, options: JobOptions, signal?: AbortSignal) {
  const base = join(options.directory, job.id);
  let trace: ReturnType<typeof createWriteStream> | null = null;
  try {
    if (options.trace) {
      trace = createWriteStream(`${base}.trace.jsonl`, { flags: 'wx' });
      trace.write(
        JSON.stringify({
          type: 'header',
          engine: ENGINE_ID,
          seed: job.seed,
          mode: job.mode,
          characters: job.characters,
          versions: job.contestants.map((c) => (c.kind === 'bot' ? `bot:${c.difficulty}` : c.hash)),
        }) + '\n',
      );
    }
    const { result, replay, webReplay } = await runAgentMatch(
      { ...job, webReplay: options.webReplay },
      {
        signal,
        trace: trace ? (line: TraceLine) => trace!.write(JSON.stringify(line) + '\n') : undefined,
      },
    );
    await writeFile(`${base}.result.json`, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    await writeFile(`${base}.replay.json`, JSON.stringify(replay) + '\n', { flag: 'wx' });
    if (webReplay)
      await writeFile(`${base}.web-replay.json`, JSON.stringify(webReplay) + '\n', { flag: 'wx' });
    return { id: job.id, ok: true, result } satisfies JobOutcome;
  } catch (error) {
    const failure =
      error instanceof MatchFailure
        ? { message: error.message, side: error.side, tick: error.tick, round: error.round }
        : { message: String((error as Error)?.message ?? error), side: null, tick: -1, round: -1 };
    await writeFile(`${base}.failed.json`, JSON.stringify(failure, null, 2) + '\n').catch(() => {});
    return { id: job.id, ok: false, error: failure } satisfies JobOutcome;
  } finally {
    if (trace) await new Promise((done) => trace!.end(done));
  }
}

async function runJobs(
  jobs: MatchJob[],
  options: JobOptions,
  parallel: number,
): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];
  const controller = new AbortController();
  const interrupt = () => {
    process.stderr.write('\nCancelling; finished matches are kept.\n');
    controller.abort();
  };
  process.once('SIGINT', interrupt);
  let next = 0,
    finished = 0;
  const progress = (outcome: JobOutcome) => {
    outcomes.push(outcome);
    finished++;
    const r = outcome.result;
    process.stderr.write(
      `[${finished}/${jobs.length}] ${outcome.id} ` +
        (r
          ? `${r.names[0]} ${r.scores[0]}:${r.scores[1]} ${r.names[1]} · ${r.reason} · ${r.rounds} round(s) · ${(r.wallMs / 1000).toFixed(1)}s\n`
          : `failed: ${outcome.error?.message}\n`),
    );
  };
  try {
    if (parallel <= 1) {
      for (const job of jobs) {
        if (controller.signal.aborted) break;
        progress(await executeJob(job, options, controller.signal));
      }
    } else {
      await Promise.all(
        Array.from({ length: parallel }, async () => {
          while (next < jobs.length && !controller.signal.aborted) {
            const job = jobs[next++];
            const worker = new Worker(new URL(import.meta.url), {
              workerData: { job, options },
              resourceLimits: { maxOldGenerationSizeMb: 512 },
            });
            const stop = () => void worker.terminate();
            controller.signal.addEventListener('abort', stop, { once: true });
            const outcome = await new Promise<JobOutcome>((done) => {
              worker.once('message', done);
              worker.once('error', (error) =>
                done({
                  id: job.id,
                  ok: false,
                  error: { message: error.message, side: null, tick: -1, round: -1 },
                }),
              );
              worker.once('exit', (code) =>
                done({
                  id: job.id,
                  ok: false,
                  error: { message: `worker exited (${code})`, side: null, tick: -1, round: -1 },
                }),
              );
            });
            controller.signal.removeEventListener('abort', stop);
            await worker.terminate();
            progress(outcome);
          }
        }),
      );
    }
  } finally {
    process.off('SIGINT', interrupt);
  }
  return outcomes.sort((a, b) => a.id.localeCompare(b.id));
}

function seedList(flags: Flags, fallbackGames: number): number[] {
  if (typeof flags['--seeds'] === 'string')
    return flags['--seeds'].split(',').map((item) => {
      const seed = Number(item);
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
        throw new Error(`Invalid seed: ${item}`);
      return seed;
    });
  const games = integerFlag(flags, '--games', fallbackGames, 1, 500);
  const base = integerFlag(flags, '--seed-base', 1000, 0, 0xffffffff - 500);
  return Array.from({ length: games }, (_, i) => base + i);
}

interface Tally {
  name: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  failed: number;
  netKills: number;
}
function tally(
  name: string,
  side: (job: MatchJob) => number,
  jobs: MatchJob[],
  outcomes: JobOutcome[],
): Tally {
  const sum: Tally = { name, games: 0, wins: 0, draws: 0, losses: 0, failed: 0, netKills: 0 };
  for (const job of jobs) {
    const outcome = outcomes.find((o) => o.id === job.id);
    if (!outcome?.ok || !outcome.result) {
      sum.failed++;
      continue;
    }
    const me = side(job),
      r = outcome.result;
    sum.games++;
    sum.netKills += r.scores[me] - r.scores[1 - me];
    if (r.winner === null) sum.draws++;
    else if (r.winner === me) sum.wins++;
    else sum.losses++;
  }
  return sum;
}

const describe = (t: Tally) =>
  `${t.name}: ${t.wins}W ${t.draws}D ${t.losses}L over ${t.games} match(es)` +
  (t.failed ? `, ${t.failed} failed` : '') +
  `, net kills ${t.netKills >= 0 ? '+' : ''}${t.netKills}`;

async function matchSeries(
  command: 'batch' | 'compare',
  candidates: { spec: string; contestant: Contestant }[],
  flags: Flags,
) {
  const opponentSpec = typeof flags['--opponent'] === 'string' ? flags['--opponent'] : 'house';
  const opponent = await contestant(opponentSpec);
  const mode = modeFlag(flags),
    characters = charactersFlag(flags);
  const seeds = seedList(flags, command === 'batch' ? 10 : 10);
  const maxTicks = integerFlag(flags, '--max-ticks', GAME_MAX_TICKS, 600, GAME_MAX_TICKS);
  const jobs: MatchJob[] = [];
  const seatOf = new Map<string, number>();
  candidates.forEach((candidate, c) => {
    for (const seed of seeds)
      for (const seat of [0, 1]) {
        const id = `${command === 'compare' ? `c${c}-` : ''}s${seed}-seat${seat}`;
        seatOf.set(id, seat);
        const contestants: [Contestant, Contestant] =
          seat === 0 ? [candidate.contestant, opponent] : [opponent, candidate.contestant];
        jobs.push({ id, seed, mode, characters, contestants, maxTicks });
      }
  });
  const directory = await outputDirectory(flags, command);
  const parallel = plannedJobs(flags, jobs.length);
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(
      {
        format: 'boomerang-agent-batch-v1',
        engine: ENGINE_ID,
        command,
        mode,
        characters,
        seeds,
        opponent: {
          spec: opponentSpec,
          version: opponent.kind === 'bot' ? opponentSpec : opponent.hash,
        },
        candidates: candidates.map((c) => ({
          spec: c.spec,
          version: c.contestant.kind === 'bot' ? c.spec : c.contestant.hash,
        })),
        maxTicks,
        jobs: jobs.map((job) => ({ id: job.id, seed: job.seed, seat: seatOf.get(job.id) })),
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  const outcomes = await runJobs(
    jobs,
    { directory, trace: flags['--trace'] === true, webReplay: flags['--web-replay'] === true },
    parallel,
  );
  const summaries = candidates.map((candidate, c) => {
    const own = jobs.filter((job) => (command === 'compare' ? job.id.startsWith(`c${c}-`) : true));
    return tally(candidate.spec, (job) => seatOf.get(job.id)!, own, outcomes);
  });
  const report: Record<string, unknown> = {
    engine: ENGINE_ID,
    command,
    mode,
    opponent: opponentSpec,
    seeds: seeds.length,
    summaries,
  };
  if (command === 'compare') {
    // Paired by seed: each candidate's mean net kills over both seats.
    const perSeed = seeds.map((seed) => {
      const net = [0, 1].map((c) => {
        let total = 0,
          complete = true;
        for (const seat of [0, 1]) {
          const r = outcomes.find((o) => o.id === `c${c}-s${seed}-seat${seat}`)?.result;
          if (!r) complete = false;
          else total += r.scores[seat] - r.scores[1 - seat];
        }
        return complete ? total / 2 : null;
      });
      return { seed, baseline: net[0], candidate: net[1] };
    });
    const paired = perSeed.filter((s) => s.baseline !== null && s.candidate !== null);
    const deltas = paired.map((s) => s.candidate! - s.baseline!);
    const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
    report.paired = {
      seeds: paired.length,
      meanDelta: mean,
      better: deltas.filter((d) => d > 0).length,
      same: deltas.filter((d) => d === 0).length,
      worse: deltas.filter((d) => d < 0).length,
      evidence:
        paired.length < 5
          ? 'insufficient: fewer than five complete seeds'
          : 'descriptive only; validate on held-out seeds before adopting',
      perSeed,
    };
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  for (const summary of summaries) say(describe(summary));
  if (report.paired) {
    const p = report.paired as {
      seeds: number;
      meanDelta: number;
      better: number;
      same: number;
      worse: number;
      evidence: string;
    };
    say(
      `paired (${p.seeds} seeds): candidate − baseline = ${p.meanDelta >= 0 ? '+' : ''}${p.meanDelta.toFixed(2)} net kills/match · better ${p.better}, same ${p.same}, worse ${p.worse} · ${p.evidence}`,
    );
  }
  say(`report: ${join(directory, 'report.json')}`);
}

async function check(spec: string) {
  const subject = await contestant(spec);
  if (subject.kind !== 'code') throw new Error('check expects a strategy file or built-in name');
  const runtime = new AgentRuntime();
  runtime.reset({ seed: 1, mode: 'round' });
  const strategy = await createStrategy(subject.code, 1);
  const first = strategy.decide(runtime.observe(0));
  strategy.dispose();
  // A bounded smoke run: one round against the house strategy, at most 4000 decisions.
  const { result } = await runAgentMatch({
    id: 'check',
    seed: 1,
    mode: 'round',
    characters: ['Avocado', 'Watermelon'],
    contestants: [subject, await contestant('house')],
    maxTicks: 4000 * DECISION_TICKS,
  });
  say({
    ok: true,
    strategy: subject.name,
    version: subject.hash,
    bytes: Buffer.byteLength(subject.code),
    firstAction: first,
    smoke: {
      status: result.status,
      scores: result.scores,
      decisions: result.decisions,
      slowestDecisionMs: result.timing.slowestDecisionMs[0],
    },
    note: 'A sandbox smoke check, not evidence of strength.',
  });
}

async function test(spec: string, flags: Flags) {
  const seat = integerFlag(flags, '--seat', 0, 0, 1);
  const subject = await contestant(spec);
  const opponent = await contestant(
    typeof flags['--opponent'] === 'string' ? flags['--opponent'] : 'house',
  );
  const job: MatchJob = {
    id: `s${integerFlag(flags, '--seed', 1, 0, 0xffffffff)}-seat${seat}`,
    seed: integerFlag(flags, '--seed', 1, 0, 0xffffffff),
    mode: modeFlag(flags),
    characters: charactersFlag(flags),
    contestants: seat === 0 ? [subject, opponent] : [opponent, subject],
    maxTicks: integerFlag(flags, '--max-ticks', GAME_MAX_TICKS, 600, GAME_MAX_TICKS),
  };
  const directory = await outputDirectory(flags, 'test');
  const [outcome] = await runJobs(
    [job],
    { directory, trace: flags['--trace'] === true, webReplay: true },
    1,
  );
  if (!outcome.ok) throw new Error(`Match failed: ${JSON.stringify(outcome.error)}`);
  const r = outcome.result!;
  say({
    result: `${r.names[0]} ${r.scores[0]}:${r.scores[1]} ${r.names[1]}`,
    winner: r.winner === null ? null : r.names[r.winner],
    reason: r.reason,
    rounds: r.rounds,
    simulationSeconds: Math.round(r.simulationSeconds * 10) / 10,
    wallMs: r.wallMs,
    files: directory,
    watch:
      'In the game open 音乐 · 历史回放 · 倍速 → 导入录像 and pick the *.web-replay.json file.',
  });
}

async function init(directory: string) {
  const target = resolve(directory);
  await mkdir(target, { recursive: true });
  if ((await readdir(target)).length) throw new Error(`${target} is not empty`);
  const seeds = {
    train: Array.from({ length: 20 }, (_, i) => 1000 + i),
    validation: Array.from({ length: 10 }, (_, i) => 9000 + i),
  };
  await writeFile(join(target, 'strategy.js'), STARTER_STRATEGY, { flag: 'wx' });
  await writeFile(join(target, 'baseline.js'), STARTER_STRATEGY, { flag: 'wx' });
  await writeFile(join(target, 'seeds.json'), JSON.stringify(seeds, null, 2) + '\n', {
    flag: 'wx',
  });
  await writeFile(
    join(target, 'AGENTS.md'),
    `# Boomerang Garden agent workspace

Edit only \`strategy.js\`. Keep \`function decide(observation, memory)\` and return \`{ action, memory }\`.
\`baseline.js\` is the starting point to compare against; do not overwrite it.

${INSTRUCTIONS}

## Workflow

1. \`npm run agent -- check strategy.js\` — sandbox smoke check (not a strength test).
2. \`npm run agent -- test strategy.js --opponent house\` — one round; to watch it, open 音乐 · 历史回放 · 倍速 → 导入录像 in the game and pick the *.web-replay.json.
3. \`npm run agent -- compare baseline.js strategy.js --seeds ${seeds.train.slice(0, 10).join(',')}\` — tune on training seeds.
4. Confirm on held-out seeds: \`npm run agent -- compare baseline.js strategy.js --seeds ${seeds.validation.join(',')}\`.
5. Report the numbers you actually ran. Never claim an unrun test passed.

Engine: ${ENGINE_ID}. The observation and action API match the MUNDI Godot adapter (arkena.game.v1), so the same strategy file runs there; results do not transfer between engines.
`,
    { flag: 'wx' },
  );
  say({ directory: target, engine: ENGINE_ID });
}

/** JSON lines: arkena.game.v1 methods plus MUNDI's advance. */
function dispatch(runtime: AgentRuntime, method: string, params: Record<string, unknown> = {}) {
  const both = () => ({
    frame: runtime.snapshot(),
    observations: [runtime.observe(0), runtime.observe(1)],
  });
  switch (method) {
    case 'reset':
      runtime.reset(params as never);
      return both();
    case 'advance':
      runtime.step(params.actions as unknown[], DECISION_TICKS);
      return both();
    case 'step':
      return runtime.step(params.actions as unknown[], Number(params.frames ?? DECISION_TICKS));
    case 'observe':
      return runtime.observe(Number(params.player));
    case 'snapshot':
      return runtime.snapshot();
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

async function serve(flags: Flags) {
  const runtime = new AgentRuntime();
  const hello = {
    hello: LOCAL_PROTOCOL,
    protocol: AGENT_PROTOCOL,
    engine: ENGINE_ID,
    tickHz: TICK_HZ,
    decisionTicks: DECISION_TICKS,
  };
  if (flags['--connect']) {
    // The MUNDI local driver role: connect back, authenticate, then reset/advance/snapshot/quit.
    const port = Number(process.env.MUNDI_LOCAL_PORT);
    if (!Number.isInteger(port) || port <= 0) throw new Error('MUNDI_LOCAL_PORT is not set');
    const socket = connect({ host: '127.0.0.1', port });
    socket.setNoDelay(true);
    await new Promise<void>((done, fail) => socket.once('connect', done).once('error', fail));
    socket.write(
      JSON.stringify({
        hello: LOCAL_PROTOCOL,
        token: process.env.MUNDI_LOCAL_TOKEN ?? '',
        engine: ENGINE_ID,
      }) + '\n',
    );
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length > 1048576) break;
      const request = JSON.parse(line) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (request.method === 'quit') {
        socket.end(JSON.stringify({ id: request.id, result: true }) + '\n');
        break;
      }
      try {
        if (!['reset', 'advance', 'snapshot'].includes(request.method))
          throw new Error('Unknown local runtime method');
        if (request.method !== 'snapshot') dispatch(runtime, request.method, request.params);
        const result = {
          frame: runtime.snapshot(),
          observations: [runtime.observe(0), runtime.observe(1)],
        };
        socket.write(JSON.stringify({ id: request.id, result }) + '\n');
      } catch (error) {
        socket.write(JSON.stringify({ id: request.id, error: (error as Error).message }) + '\n');
      }
    }
    runtime.dispose();
    return;
  }
  process.stdout.write(JSON.stringify(hello) + '\n');
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let id: unknown = null;
    try {
      if (line.length > 1048576) throw new Error('Request line is larger than 1 MiB');
      const request = JSON.parse(line) as {
        id: unknown;
        method: string;
        params?: Record<string, unknown>;
      };
      id = request.id;
      if (request.method === 'dispose' || request.method === 'quit') {
        process.stdout.write(JSON.stringify({ id, result: true }) + '\n');
        break;
      }
      process.stdout.write(
        JSON.stringify({ id, result: dispatch(runtime, request.method, request.params) }) + '\n',
      );
    } catch (error) {
      process.stdout.write(JSON.stringify({ id, error: (error as Error).message }) + '\n');
    }
  }
  runtime.dispose();
}

async function main(argv: string[]) {
  const { command, args, flags } = parse(argv);
  const arity = (count: number) => {
    if (args.length !== count)
      throw new Error(`${command} expects ${count} argument(s); see --help`);
  };
  if (flags['--help'] || command === 'help' || command === '--help') return say(HELP);
  switch (command) {
    case 'contract':
      arity(0);
      return say({
        format: 'boomerang-agent-contract-v1',
        protocol: AGENT_PROTOCOL,
        localProtocol: LOCAL_PROTOCOL,
        engine: ENGINE_ID,
        tickHz: TICK_HZ,
        decisionTicks: DECISION_TICKS,
        maxTicks: GAME_MAX_TICKS,
        limits: LIMITS,
        characters: CHARACTERS,
        modes: ['round', 'match'],
        instructions: INSTRUCTIONS,
        starter: STARTER_STRATEGY,
      });
    case 'init':
      arity(1);
      return init(args[0]);
    case 'check':
      arity(1);
      return check(args[0]);
    case 'test':
      arity(1);
      return test(args[0], flags);
    case 'batch':
      arity(1);
      return matchSeries(
        'batch',
        [{ spec: args[0], contestant: await contestant(args[0]) }],
        flags,
      );
    case 'compare':
      arity(2);
      return matchSeries(
        'compare',
        await Promise.all(args.map(async (spec) => ({ spec, contestant: await contestant(spec) }))),
        flags,
      );
    case 'replay': {
      arity(1);
      const file = JSON.parse(await readFile(resolve(args[0]), 'utf8')) as AgentReplayFile;
      return say(verifyAgentReplay(file));
    }
    case 'serve':
      arity(0);
      return serve(flags);
    default:
      throw new Error(`Unknown command: ${command}; see --help`);
  }
}

if (isMainThread) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
} else {
  const { job, options } = workerData as { job: MatchJob; options: JobOptions };
  executeJob(job, options).then((outcome) => parentPort!.postMessage(outcome));
}
