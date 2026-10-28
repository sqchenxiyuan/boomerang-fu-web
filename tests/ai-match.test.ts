import { describe, expect, it } from 'vitest';
import { runAIMatch, createHttpAgent } from '../src/sdk/ai-match';
import { ReplayPlayer } from '../src/sdk/recording';
import { createSession } from '../src/sdk/session';

describe('AI matches and headless acceleration', () => {
  it('runs every actor as a bot and finishes an actual match with a replay', async () => {
    const result = await runAIMatch({
      match: { mapId: 'courtyard', bots: 4, seed: 8751, scoreGoal: 1, suddenDeathTime: 15 },
      record: true,
    });
    expect(result.completed).toBe(true);
    expect(result.reason).toBe('match-end');
    expect(result.state.actors).toHaveLength(4);
    expect(result.state.actors.every((a) => a.controller === 'bot')).toBe(true);
    const replay = new ReplayPlayer(result.recording!);
    replay.step(result.ticks);
    expect(JSON.parse(JSON.stringify(replay.getState()))).toEqual(
      JSON.parse(JSON.stringify(result.state)),
    );
    expect(result.agentErrors).toEqual([]);
    expect(result.simulationRate).toBeGreaterThan(0);
  }, 30000);

  it('gives simultaneous external policies detached observations and records their actual actions', async () => {
    const seen: number[][] = [[], []];
    const result = await runAIMatch({
      match: { mapId: 'courtyard', seed: 12 },
      maxTicks: 300,
      record: true,
      agents: {
        0: async (obs) => {
          seen[0].push(obs.tick);
          obs.state.actors[1].score = 99;
          return { move: { x: 1, y: 0 }, throw: true };
        },
        1: (obs) => {
          seen[1].push(obs.tick);
          expect(obs.state.actors[1].score).toBe(0);
          return { move: { x: -1, y: 0 }, attack: true };
        },
      },
    });
    expect(seen[0].length).toBeGreaterThan(0);
    expect(seen[0]).toEqual(seen[1]);
    expect(result.reason).toBe('tick-limit');
    expect(result.agentErrors).toEqual([]);
    const replay = new ReplayPlayer(result.recording!);
    replay.step(300);
    expect(JSON.parse(JSON.stringify(replay.getState()))).toEqual(
      JSON.parse(JSON.stringify(result.state)),
    );
  });

  it('isolates throwing, invalid and timed-out agents without stopping the other actor', async () => {
    let calls = 0;
    const result = await runAIMatch({
      maxTicks: 240,
      timeoutMs: 5,
      agents: {
        0: () => (++calls % 2 ? new Promise(() => {}) : Promise.reject(new Error('bad policy'))),
        1: () => ({ move: { x: Number.NaN, y: 0 } }),
      },
    });
    expect(result.ticks).toBe(240);
    expect(result.agentErrors.some((e) => e.actorId === 0)).toBe(true);
    expect(result.agentErrors.some((e) => e.actorId === 1)).toBe(true);
    expect(result.state.actors.every((a) => Number.isFinite(a.position.x))).toBe(true);
  });

  it('advances the same deterministic state regardless of batching', () => {
    const a = createSession({ mode: 'bots', bots: 2, seed: 55 }),
      b = createSession({ mode: 'bots', bots: 2, seed: 55 });
    for (let i = 0; i < 600; i++) a.step();
    for (let i = 0; i < 10; i++) b.step(60);
    expect(a.getState()).toEqual(b.getState());
    expect(() => createHttpAgent('file:///secret')).toThrow(/HTTP/);
  });
});
