import { RULES } from '../core/config';
import type { GameState, MatchOptions } from '../core/types';
import type { Action, ExternalController } from './types';
import type { ReplayData } from './recording';
import { createSession } from './session';
import { actionSample, integer } from './control';

export interface AgentObservation {
  protocol: 'boomerang-garden.agent.v1';
  actorId: number;
  tick: number;
  dt: number;
  actionTicks: number;
  state: GameState;
}
/** DOM-free subset implemented by native AbortSignal in Node and browsers. */
export interface AgentSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
export type AgentPolicy = (
  observation: AgentObservation,
  signal: AgentSignal,
) => Action | Promise<Action>;
export interface AIMatchOptions {
  match?: Partial<MatchOptions>;
  agents?: Record<number, AgentPolicy>;
  actionTicks?: number;
  timeoutMs?: number;
  maxTicks?: number;
  record?: boolean;
  signal?: AgentSignal;
  onProgress?: (progress: { tick: number; state: GameState }) => void;
}
export interface AIMatchResult {
  completed: boolean;
  reason: 'match-end' | 'tick-limit' | 'aborted';
  ticks: number;
  simulationSeconds: number;
  wallSeconds: number;
  simulationRate: number;
  state: GameState;
  agentErrors: { actorId: number; tick: number; message: string }[];
  recording: ReplayData | null;
}

/** Run fixed 60 Hz physics as fast as the host permits, yielding between bounded batches.
 * All external agents see the same pre-step state. Network waits do not advance simulation. */
export async function runAIMatch(options: AIMatchOptions = {}): Promise<AIMatchResult> {
  const actionTicks = integer(options.actionTicks ?? 6, 1, 60, 'actionTicks');
  const timeout = integer(options.timeoutMs ?? 2000, 1, 60000, 'timeoutMs');
  const maxTicks = integer(options.maxTicks ?? 108000, 1, 1_000_000, 'maxTicks');
  const session = createSession({ mode: 'bots', bots: 2, ...options.match });
  try {
    const policies = Object.entries(options.agents ?? {}).map(([key, policy]) => {
      const id = Number(key);
      integer(id, 0, session.getState().actors.length - 1, 'agent actorId');
      if (typeof policy !== 'function') throw new TypeError('Agent policy must be a function');
      return { id, policy, handle: session.acquire(id, `Agent ${id + 1}`) as ExternalController };
    });
    const errors: AIMatchResult['agentErrors'] = [];
    if (options.record) session.startRecording({ label: 'AI 对战' });
    const started = performance.now();
    let yieldAt = started;
    while (session.tick < maxTicks && !options.signal?.aborted) {
      const state = session.getState();
      if (state.phase === 'matchEnd') break;
      if (policies.length && state.phase === 'playing' && state.hitStop <= 0) {
        const decisions = await Promise.all(
          policies.map(async ({ id, policy }) => {
            if (!state.actors.find((a) => a.id === id)?.alive) return { id, action: {} };
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout>;
            const abort = () => controller.abort();
            options.signal?.addEventListener('abort', abort, { once: true });
            try {
              const action = await Promise.race([
                Promise.resolve().then(() =>
                  policy(
                    {
                      protocol: 'boomerang-garden.agent.v1',
                      actorId: id,
                      tick: session.tick,
                      dt: RULES.dt,
                      actionTicks,
                      state: structuredClone(state),
                    },
                    controller.signal,
                  ),
                ),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(() => {
                    reject(new Error('Agent decision timed out'));
                    controller.abort();
                  }, timeout);
                  controller.signal.addEventListener(
                    'abort',
                    () => reject(new Error('Agent decision aborted')),
                    { once: true },
                  );
                }),
              ]);
              actionSample(action);
              return { id, action };
            } catch (error) {
              return { id, error: error instanceof Error ? error.message : 'Agent failed' };
            } finally {
              clearTimeout(timer!);
              options.signal?.removeEventListener('abort', abort);
            }
          }),
        );
        for (const decision of decisions) {
          const entry = policies.find((p) => p.id === decision.id)!;
          if ('error' in decision) {
            if (errors.length < 1000)
              errors.push({ actorId: entry.id, tick: session.tick, message: decision.error! });
            // A failed observation must cancel charging, not synthesize a release/throw.
            entry.handle.release();
            entry.handle = session.acquire(entry.id, `Agent ${entry.id + 1}`);
          } else entry.handle.submit(decision.action, actionTicks);
        }
      }
      if (options.signal?.aborted) break;
      session.step(Math.min(maxTicks - session.tick, policies.length ? actionTicks : 60));
      if (performance.now() - yieldAt >= 12) {
        options.onProgress?.({ tick: session.tick, state: session.getState() });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yieldAt = performance.now();
      }
    }
    const final = session.getState(),
      wallSeconds = (performance.now() - started) / 1000;
    const ticks = session.tick;
    const recording = options.record ? session.stopRecording() : null;
    return {
      completed: final.phase === 'matchEnd',
      reason:
        final.phase === 'matchEnd'
          ? 'match-end'
          : options.signal?.aborted
            ? 'aborted'
            : 'tick-limit',
      ticks,
      simulationSeconds: ticks * RULES.dt,
      wallSeconds,
      simulationRate: wallSeconds > 0 ? (ticks * RULES.dt) / wallSeconds : 0,
      state: final,
      agentErrors: errors,
      recording,
    };
  } finally {
    session.destroy();
  }
}

/** Host-supplied endpoint; secrets belong in the host, never in replay files or observations. */
export function createHttpAgent(url: string, headers: Record<string, string> = {}): AgentPolicy {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new TypeError('Agent URL must use HTTP(S)');
  return async (observation, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const response = await fetch(parsed, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(observation),
      });
      if (!response.ok) throw new Error(`Agent HTTP ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty agent response');
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 65536) {
            await reader.cancel();
            throw new Error('Agent response is too large');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (
        data?.protocol !== 'boomerang-garden.agent.v1' ||
        data.tick !== observation.tick ||
        data.actorId !== observation.actorId
      )
        throw new Error('Agent response protocol, actor or tick does not match its observation');
      return actionSample(data.action);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
}
