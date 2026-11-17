import type { Difficulty } from '../core/types';
import type { ReplayData } from '../sdk/recording';
import {
  DECISION_TICKS,
  ENGINE_ID,
  GAME_MAX_TICKS,
  type AgentAction,
  type AgentFrame,
  type AgentMode,
  type AgentObservation,
  type CharacterId,
} from './contract';
import { AgentRuntime } from './runtime';
import { createStrategy, type Strategy } from './sandbox';
import { NativeBot } from './strategies';

/*
 * One headless match: both sides decide from the same pre-step observations,
 * then the runtime advances exactly six frames. Mirrors the MUNDI local runner;
 * strategy failures and budget exhaustion never invent a winner.
 */
export type Contestant =
  | { kind: 'code'; name: string; code: string; hash: string }
  | { kind: 'bot'; name: string; difficulty: Difficulty };

export interface MatchJob {
  id: string;
  seed: number;
  mode: AgentMode;
  characters: [CharacterId, CharacterId];
  contestants: [Contestant, Contestant];
  maxTicks?: number;
  /** Also produce a native web replay for the browser replay studio. */
  webReplay?: boolean;
}

export interface MatchEvent {
  type: 'round' | 'score' | 'death';
  tick: number;
  round?: number;
  map?: string;
  scores?: [number, number];
  side?: number;
}

export interface MatchResult {
  id: string;
  engine: string;
  status: 'completed' | 'tick-limit';
  seed: number;
  mode: AgentMode;
  characters: [CharacterId, CharacterId];
  names: [string, string];
  versions: [string, string];
  scores: [number, number];
  winner: 0 | 1 | null;
  reason: AgentFrame['reason'] | 'tick-limit';
  rounds: number;
  ticks: number;
  decisions: number;
  simulationSeconds: number;
  wallMs: number;
  timing: { decideMs: [number, number]; advanceMs: number; slowestDecisionMs: [number, number] };
  events: MatchEvent[];
  frameDigest: string;
  actionDigest: string;
}

export interface ActionLog {
  format: 'boomerang-web-actions-v1';
  engine: string;
  seed: number;
  mode: AgentMode;
  characters: [CharacterId, CharacterId];
  map: string;
  /** One pair per six-frame decision. */
  actions: [AgentAction, AgentAction][];
  /** FNV-1a of each frame after reset and after every decision. */
  frameHashes: string[];
  final: AgentFrame;
}
export interface AgentReplayFile {
  kind: 'boomerang-agent-replay';
  version: 1;
  exportedAt: string;
  match: Omit<MatchResult, 'events' | 'timing'>;
  log: ActionLog;
}

export interface TraceLine {
  type: 'decision';
  index: number;
  tick: number;
  round: number;
  observations: [AgentObservation, AgentObservation];
  actions: [AgentAction, AgentAction];
}
export interface MatchHooks {
  signal?: AbortSignal;
  trace?: (line: TraceLine) => void;
  onProgress?: (frame: AgentFrame) => void;
}

export class MatchFailure extends Error {
  constructor(
    message: string,
    readonly side: number | null,
    readonly tick: number,
    readonly round: number,
  ) {
    super(message);
  }
}

export function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

interface Side {
  decide(observation: AgentObservation, runtime: AgentRuntime): AgentAction;
  dispose(): void;
}

async function prepare(contestant: Contestant, seed: number, player: number): Promise<Side> {
  if (contestant.kind === 'bot') {
    const bot = new NativeBot(contestant.difficulty, seed, player);
    return { decide: (_observation, runtime) => bot.decide(runtime.state), dispose() {} };
  }
  // The MUNDI worker seeds each side with seed + seat.
  const strategy: Strategy = await createStrategy(contestant.code, seed + player);
  return { decide: (observation) => strategy.decide(observation), dispose: strategy.dispose };
}

export const contestantVersion = (contestant: Contestant): string =>
  contestant.kind === 'bot' ? `bot:${contestant.difficulty}` : contestant.hash;

export async function runAgentMatch(
  job: MatchJob,
  hooks: MatchHooks = {},
): Promise<{ result: MatchResult; replay: AgentReplayFile; webReplay: ReplayData | null }> {
  const started = performance.now();
  const maxTicks = job.maxTicks ?? GAME_MAX_TICKS;
  const runtime = new AgentRuntime({ record: job.webReplay, recordLabel: `Agent ${job.id}` });
  const sides: Side[] = [];
  const decideMs: [number, number] = [0, 0],
    slowest: [number, number] = [0, 0];
  let advanceMs = 0;
  try {
    for (let player = 0; player < 2; player++) {
      try {
        sides.push(await prepare(job.contestants[player], job.seed, player));
      } catch (error) {
        throw new MatchFailure(`init: ${(error as Error).message}`, player, 0, 0);
      }
    }
    let frame = runtime.reset({ seed: job.seed, mode: job.mode, characters: job.characters });
    const firstMap = frame.map;
    const actions: [AgentAction, AgentAction][] = [];
    const frameHashes = [fnv(JSON.stringify(frame))];
    const events: MatchEvent[] = [];
    let status: MatchResult['status'] = 'completed';
    while (!frame.done) {
      hooks.signal?.throwIfAborted();
      if (frame.tick >= maxTicks) {
        status = 'tick-limit';
        break;
      }
      const observations = [runtime.observe(0), runtime.observe(1)] as [
        AgentObservation,
        AgentObservation,
      ];
      const pair = sides.map((side, player) => {
        const at = performance.now();
        try {
          return side.decide(observations[player], runtime);
        } catch (error) {
          throw new MatchFailure((error as Error).message, player, frame.tick, frame.round);
        } finally {
          const spent = performance.now() - at;
          decideMs[player] += spent;
          slowest[player] = Math.max(slowest[player], spent);
        }
      }) as [AgentAction, AgentAction];
      hooks.trace?.({
        type: 'decision',
        index: actions.length,
        tick: frame.tick,
        round: frame.round,
        observations,
        actions: pair,
      });
      const before = frame,
        at = performance.now();
      frame = runtime.step(pair, DECISION_TICKS);
      advanceMs += performance.now() - at;
      if (frame.tick <= before.tick) throw new Error('Simulation did not advance');
      actions.push(pair);
      frameHashes.push(fnv(JSON.stringify(frame)));
      // Transitions read from frames; kill causes are never inferred.
      if (frame.round !== before.round)
        events.push({ type: 'round', tick: frame.tick, round: frame.round, map: frame.map });
      if (frame.scores[0] !== before.scores[0] || frame.scores[1] !== before.scores[1])
        events.push({ type: 'score', tick: frame.tick, scores: [...frame.scores] });
      for (let side = 0; side < 2; side++)
        if (before.players[side].alive && !frame.players[side].alive)
          events.push({ type: 'death', tick: frame.tick, side });
      if (actions.length % 200 === 0) hooks.onProgress?.(frame);
    }
    const versions = job.contestants.map(contestantVersion) as [string, string];
    const result: MatchResult = {
      id: job.id,
      engine: ENGINE_ID,
      status,
      seed: job.seed,
      mode: job.mode,
      characters: job.characters,
      names: job.contestants.map((c) => c.name) as [string, string],
      versions,
      scores: frame.scores,
      winner: status === 'completed' ? frame.winner : null,
      reason: status === 'completed' ? frame.reason : 'tick-limit',
      rounds: frame.round,
      ticks: frame.tick,
      decisions: actions.length,
      simulationSeconds: frame.tick / 60,
      wallMs: Math.round(performance.now() - started),
      timing: {
        decideMs: decideMs.map((ms) => Math.round(ms)) as [number, number],
        advanceMs: Math.round(advanceMs),
        slowestDecisionMs: slowest.map((ms) => Math.round(ms * 10) / 10) as [number, number],
      },
      events,
      frameDigest: fnv(frameHashes.join('')),
      actionDigest: fnv(JSON.stringify(actions)),
    };
    const { events: _events, timing: _timing, ...summary } = result;
    const replay: AgentReplayFile = {
      kind: 'boomerang-agent-replay',
      version: 1,
      exportedAt: new Date().toISOString(),
      match: summary,
      log: {
        format: 'boomerang-web-actions-v1',
        engine: ENGINE_ID,
        seed: job.seed,
        mode: job.mode,
        characters: job.characters,
        map: firstMap,
        actions,
        frameHashes,
        final: frame,
      },
    };
    return { result, replay, webReplay: job.webReplay ? runtime.recording() : null };
  } finally {
    for (const side of sides) side.dispose();
    runtime.dispose();
  }
}

/** Re-run a replay's actions on this engine and check every frame hash. */
export function verifyAgentReplay(file: AgentReplayFile): {
  verified: true;
  decisions: number;
  ticks: number;
  scores: [number, number];
  winner: 0 | 1 | null;
} {
  if (file?.kind !== 'boomerang-agent-replay' || file.version !== 1)
    throw new Error('Unsupported replay file');
  const log = file.log;
  if (log?.format !== 'boomerang-web-actions-v1') throw new Error('Unsupported action log');
  if (log.engine !== ENGINE_ID)
    throw new Error(`Replay was recorded on ${log.engine}; this runtime is ${ENGINE_ID}`);
  if (!Array.isArray(log.actions) || log.frameHashes?.length !== log.actions.length + 1)
    throw new Error('Replay frame hashes do not match its actions');
  const runtime = new AgentRuntime();
  try {
    let frame = runtime.reset({ seed: log.seed, mode: log.mode, characters: log.characters });
    const check = (index: number) => {
      const hash = fnv(JSON.stringify(frame));
      if (hash !== log.frameHashes[index])
        throw new Error(`Replay diverged at decision ${index} (tick ${frame.tick})`);
    };
    check(0);
    log.actions.forEach((pair, index) => {
      frame = runtime.step(pair, DECISION_TICKS);
      check(index + 1);
    });
    return {
      verified: true,
      decisions: log.actions.length,
      ticks: frame.tick,
      scores: frame.scores,
      winner: frame.winner,
    };
  } finally {
    runtime.dispose();
  }
}
