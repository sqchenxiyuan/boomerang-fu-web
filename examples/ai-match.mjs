import { runAIMatch, createHttpAgent, ReplayPlayer } from '@boomerang-garden/sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    matches: { type: 'string', default: '1' },
    seed: { type: 'string', default: '8751' },
    bots: { type: 'string', default: '2' },
    map: { type: 'string', default: 'courtyard' },
    score: { type: 'string', default: '5' },
    ticks: { type: 'string', default: '108000' },
    'action-ticks': { type: 'string', default: '6' },
    timeout: { type: 'string', default: '2000' },
    'agent-0': { type: 'string' },
    'agent-1': { type: 'string' },
    'agent-2': { type: 'string' },
    'agent-3': { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'node ai-match.mjs --matches 3 --seed 8751 --bots 4 --map courtyard --score 5 --out replays\nOptional: --agent-0 http://127.0.0.1:8787/action --action-ticks 6 --timeout 2000 --ticks 108000\nAgent credentials, if needed: GARDEN_AGENT_TOKEN in the host environment (never in observations/replays).',
  );
} else {
  const count = Number(values.matches),
    seed = Number(values.seed);
  if (!Number.isInteger(count) || count < 1 || count > 1000)
    throw new RangeError('matches must be 1..1000');
  const agents = {};
  for (let id = 0; id < 4; id++)
    if (values[`agent-${id}`])
      agents[id] = createHttpAgent(
        values[`agent-${id}`],
        process.env.GARDEN_AGENT_TOKEN
          ? { Authorization: `Bearer ${process.env.GARDEN_AGENT_TOKEN}` }
          : {},
      );
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const directory = values.out ? resolve(values.out) : null;
  if (directory) await mkdir(directory, { recursive: true });
  for (let index = 0; index < count && !controller.signal.aborted; index++) {
    const result = await runAIMatch({
      match: {
        mode: 'bots',
        bots: Number(values.bots),
        mapId: values.map,
        seed: seed + index,
        scoreGoal: Number(values.score),
      },
      agents,
      maxTicks: Number(values.ticks),
      actionTicks: Number(values['action-ticks']),
      timeoutMs: Number(values.timeout),
      signal: controller.signal,
      record: !!directory,
    });
    let replayPath = null;
    if (result.recording) {
      const replay = new ReplayPlayer(result.recording);
      replay.seek(replay.durationTicks); // Verify before writing an artifact.
      replayPath = resolve(directory, `match-${seed + index}-${Date.now()}-${index}.bgr.gz`);
      await writeFile(replayPath, gzipSync(JSON.stringify(result.recording)), { flag: 'wx' });
    }
    console.log(
      JSON.stringify({
        seed: seed + index,
        reason: result.reason,
        ticks: result.ticks,
        simulationSeconds: result.simulationSeconds,
        wallSeconds: result.wallSeconds,
        simulationRate: result.simulationRate,
        winner: result.state.matchWinnerId,
        scores: result.state.actors.map((actor) => actor.score),
        agentErrors: result.agentErrors.length,
        replayPath,
      }),
    );
  }
}
