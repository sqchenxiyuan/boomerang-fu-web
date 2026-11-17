import { describe, expect, it } from 'vitest';
import { NATIVE } from '../src/core/config';
import { ORIGINAL_MAP_RECORDS } from '../src/core/original-maps';
import { ReplayPlayer } from '../src/sdk/recording';
import {
  ENGINE_ID,
  neutralAction,
  normalizeAction,
  type AgentAction,
  type AgentFrame,
} from '../src/agent/contract';
import { runAgentMatch, verifyAgentReplay, type Contestant } from '../src/agent/match';
import { matchPlaylist } from '../src/agent/playlist';
import { AgentRuntime } from '../src/agent/runtime';
import { createStrategy } from '../src/agent/sandbox';
import { HOUSE_STRATEGY, STARTER_STRATEGY } from '../src/agent/strategies';

const act = (patch: Partial<AgentAction> = {}): AgentAction => ({ ...neutralAction(), ...patch });
const idle: [AgentAction, AgentAction] = [act(), act()];
const sceneFile = new Map(ORIGINAL_MAP_RECORDS.map((r) => [r.info.id, r.provenance.sceneFile]));
const code = (name: string, source: string): Contestant => ({
  kind: 'code',
  name,
  code: source,
  hash: name,
});

/** Idle until both players hold a disc (countdown, then the equip delay). */
function armed(seed = 3): { runtime: AgentRuntime; frame: AgentFrame } {
  const runtime = new AgentRuntime();
  let frame = runtime.reset({ seed, mode: 'round' });
  while (frame.players.some((p) => p.discs === 0)) {
    frame = runtime.step(idle, 6);
    if (frame.tick > 600) throw new Error('Players were never armed');
  }
  return { runtime, frame };
}

describe('agent contract', () => {
  it('normalizes actions with the platform rules', () => {
    expect(normalizeAction({ moveX: 3, aimY: -9, throw: true })).toEqual(
      act({ moveX: 1, aimY: -1, throw: true }),
    );
    expect(normalizeAction({})).toEqual(act());
    expect(() => normalizeAction({ moveX: Number.NaN })).toThrow(/finite/);
    expect(() => normalizeAction({ dash: 1 })).toThrow(/boolean/);
    expect(() => normalizeAction([])).toThrow();
  });

  it('builds the reference two-player map playlist from the seed', () => {
    const files = (seed: number) => matchPlaylist(seed).map((id) => sceneFile.get(id));
    // Expected orders from the MUNDI adapter's playlist for the same seeds.
    expect(files(1).slice(0, 8)).toEqual([
      'level35',
      'level15',
      'level39',
      'level3',
      'level13',
      'level30',
      'level7',
      'level32',
    ]);
    expect(files(4294967295).slice(0, 8)).toEqual([
      'level23',
      'level15',
      'level2',
      'level11',
      'level18',
      'level21',
      'level38',
      'level37',
    ]);
    expect(new Set(files(77))).toHaveProperty('size', 36);
    expect(files(77)).not.toContain('level28');
  });
});

describe('strategy sandbox', () => {
  it('hides Date, seeds Math.random and keeps memory between calls', async () => {
    const source = `function decide(o, memory) {
      memory.n = (memory.n || 0) + 1;
      return { action: { moveX: Math.random(), moveY: typeof Date === 'undefined' ? 1 : -1 }, memory };
    }`;
    const runtime = new AgentRuntime();
    runtime.reset({ seed: 1, mode: 'round' });
    const observation = runtime.observe(0);
    const [a, b] = [await createStrategy(source, 7), await createStrategy(source, 7)];
    const first = a.decide(observation);
    expect(first).toEqual(b.decide(observation));
    expect(first.moveY).toBe(1);
    expect(a.decide(observation).moveX).not.toBe(first.moveX);
    a.dispose();
    b.dispose();
  });

  it('rejects runaway, oversized and malformed strategies', async () => {
    const runtime = new AgentRuntime();
    runtime.reset({ seed: 1, mode: 'round' });
    const observation = runtime.observe(0);
    const loop = await createStrategy('function decide(){ for(;;){} }');
    expect(() => loop.decide(observation)).toThrow(/time budget/);
    loop.dispose();
    const big = await createStrategy(
      'function decide(o, m){ return { action: {}, memory: { s: "x".repeat(9000) } }; }',
    );
    expect(() => big.decide(observation)).toThrow(/larger/);
    big.dispose();
    await expect(createStrategy('const x = 1;')).rejects.toThrow(/decide/);
    await expect(createStrategy('//' + 'x'.repeat(25000))).rejects.toThrow(/larger/);
  });
});

describe('agent runtime', () => {
  it('reports reference game-world units with Y up', () => {
    const { runtime, frame } = armed();
    const actor = runtime.state.actors[0];
    expect(frame.players[0].x).toBeCloseTo(actor.position.x / NATIVE.scale, 9);
    expect(frame.players[0].y).toBeCloseTo(-actor.position.y / NATIVE.scale, 9);
    const observation = runtime.observe(1);
    expect(observation.self.id).toBe(1);
    expect(observation.opponent.id).toBe(0);
    expect(observation.arena.units).toBe('game-world');
    expect(observation.arena.rays).toHaveLength(16);
    for (const ray of observation.arena.rays) {
      expect(ray.clearance).toBeGreaterThanOrEqual(0);
      expect(ray.clearance).toBeLessThanOrEqual(5);
    }
    expect(Object.keys(observation.self).sort()).toEqual(
      [
        'id',
        'x',
        'y',
        'vx',
        'vy',
        'alive',
        'state',
        'discs',
        'aimX',
        'aimY',
        'canDash',
        'aimPower',
        'stunned',
        'frozen',
        'visible',
        'inPlants',
        'inBounds',
        'burnt',
        'powers',
        'character',
      ].sort(),
    );
    expect(frame.engine).toBe(ENGINE_ID);
  });

  it('charges while throw is held and releases exactly once on the falling edge', () => {
    const { runtime } = armed();
    let frame = runtime.snapshot();
    for (let i = 0; i < 20; i++) frame = runtime.step([act({ throw: true }), act()], 6);
    expect(frame.projectiles.filter((p) => p.owner === 0)).toHaveLength(0);
    expect(frame.players[0].aimPower).toBeGreaterThan(0.9);
    // The release lands on the first frame of the next block.
    frame = runtime.step([act(), act()], 1);
    expect(frame.projectiles.filter((p) => p.owner === 0)).toHaveLength(1);
    for (let i = 0; i < 5; i++) frame = runtime.step([act(), act()], 6);
    expect(frame.players[0].discs).toBe(0);
  });

  it('snaps facing to aim while the throw follows the last movement', () => {
    const { runtime } = armed(5);
    // Walk toward +x so the remembered movement points there.
    for (let i = 0; i < 4; i++) runtime.step([act({ moveX: 1 }), act()], 6);
    let frame = runtime.step([act({ aimY: 1, throw: true }), act()], 1);
    expect(frame.players[0].aimY).toBeGreaterThan(0.9);
    for (let i = 0; i < 6; i++) frame = runtime.step([act({ aimY: 1, throw: true }), act()], 6);
    expect(frame.players[0].aimY).toBeGreaterThan(0.9);
    frame = runtime.step([act({ aimY: 1 }), act()], 2);
    const disc = frame.projectiles.find((p) => p.owner === 0)!;
    expect(disc).toBeDefined();
    expect(disc.vx).toBeGreaterThan(Math.abs(disc.vy) * 2);
  });

  it('repeats a held dash request whenever the cooldown allows', () => {
    const { runtime } = armed(8);
    let dashes = 0,
      previous = runtime.state.actors[0].dashTime;
    // 150 frames with dash held: one press per cooldown (0.55 s), no re-press needed.
    for (let i = 0; i < 150; i++) {
      runtime.step([act({ moveX: i % 60 < 30 ? 1 : -1, dash: true }), act()], 1);
      const time = runtime.state.actors[0].dashTime;
      if (time > previous) dashes++;
      previous = time;
    }
    expect(dashes).toBeGreaterThanOrEqual(3);
  });

  it('ends a round-mode run when play stops and never advances afterwards', async () => {
    const { result } = await runAgentMatch({
      id: 'round',
      seed: 21,
      mode: 'round',
      characters: ['Banana', 'Coffee'],
      contestants: [
        code('house', HOUSE_STRATEGY),
        { kind: 'bot', name: 'bot', difficulty: 'hard' },
      ],
    });
    expect(result.status).toBe('completed');
    expect(['score', 'round']).toContain(result.reason);
    expect(result.rounds).toBe(1);
    if (result.reason === 'score') expect(result.winner).not.toBeNull();
  });

  it('changes maps along the playlist and never invents a winner at the tick budget', async () => {
    const { result } = await runAgentMatch({
      id: 'budget',
      seed: 1,
      mode: 'match',
      characters: ['Avocado', 'Watermelon'],
      contestants: [
        { kind: 'bot', name: 'a', difficulty: 'impossible' },
        { kind: 'bot', name: 'b', difficulty: 'hard' },
      ],
      maxTicks: 4200,
    });
    expect(result.status).toBe('tick-limit');
    expect(result.winner).toBeNull();
    const rounds = result.events.filter((e) => e.type === 'round');
    expect(rounds.length).toBeGreaterThan(0);
    expect(rounds[0]).toMatchObject({ round: 2, map: 'level15' });
  }, 30000);

  it('replays deterministically, detects tampering and exports a browser replay', async () => {
    const { result, replay, webReplay } = await runAgentMatch({
      id: 'det',
      seed: 5,
      mode: 'round',
      characters: ['Avocado', 'Watermelon'],
      contestants: [code('starter', STARTER_STRATEGY), code('house', HOUSE_STRATEGY)],
      webReplay: true,
    });
    const again = await runAgentMatch({
      id: 'det',
      seed: 5,
      mode: 'round',
      characters: ['Avocado', 'Watermelon'],
      contestants: [code('starter', STARTER_STRATEGY), code('house', HOUSE_STRATEGY)],
    });
    expect(again.result.frameDigest).toBe(result.frameDigest);
    const copy = JSON.parse(JSON.stringify(replay));
    expect(verifyAgentReplay(copy)).toMatchObject({ verified: true, ticks: result.ticks });
    // Before weapons are granted (tick 150) both players are certainly alive and walking.
    const original = copy.log.actions[25][0];
    copy.log.actions[25][0] = {
      ...original,
      moveX: -original.moveX || 1,
      moveY: -original.moveY || 1,
    };
    expect(() => verifyAgentReplay(copy)).toThrow(/diverged/);
    // The native recording plays in the browser replay player to the same end state.
    const player = new ReplayPlayer(webReplay!);
    player.step(player.durationTicks);
    const end = player.getState().actors[0].position;
    expect(end.x / NATIVE.scale).toBeCloseTo(replay.log.final.players[0].x, 6);
  }, 30000);
});
