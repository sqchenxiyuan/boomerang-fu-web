import { afterEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/sdk/index';
import type { Action, ScriptController, SessionAPI, SessionEvent } from '../src/sdk/types';
import type { GameState, MatchOptions } from '../src/core/types';
import { idleCommand } from '../src/core/types';

const sessions: SessionAPI[] = [];
const options: Partial<MatchOptions> = {
  mode: 'local',
  bots: 0,
  difficulty: 'normal',
  seed: 12456,
  scoreGoal: 5,
  mapId: 'courtyard',
  mapRotation: 'fixed',
};

function session(overrides: Partial<MatchOptions> = {}): SessionAPI {
  const value = createSession({ ...options, ...overrides });
  sessions.push(value);
  return value;
}

function until(
  value: SessionAPI,
  predicate: (state: GameState) => boolean,
  maxTicks = 600,
): GameState {
  for (let tick = 0; tick <= maxTicks; tick++) {
    const state = value.getState();
    if (predicate(state)) return state;
    if (tick < maxTicks) value.step();
  }
  throw new Error(`SDK condition timed out: ${JSON.stringify(value.snapshot())}`);
}

function equipped(value: SessionAPI): void {
  until(value, (state) => state.phase === 'playing' && state.weaponsGranted);
  // The equipment grant blocks held throw; a neutral frame deliberately rearms input.
  value.step(2);
}

function observe(value: SessionAPI): SessionEvent[] {
  const events: SessionEvent[] = [];
  value.onEvent((event) => events.push(event));
  return events;
}

const gameEvents = (events: SessionEvent[], kind: string) =>
  events.filter((event) => event.type === 'game' && event.event.type === kind);

afterEach(() => {
  for (const value of sessions.splice(0)) value.destroy();
});

describe('SDK external input contract', () => {
  it('starts running, derives button edges, and treats omitted controls as released', () => {
    const value = session();
    expect(value.snapshot().status).toBe('running');
    expect(value.getState().phase).toBe('countdown');
    equipped(value);
    const events = observe(value);
    const input = value.acquire(0, 'test driver');
    input.submit({ attack: true }, 120);
    value.step(80);
    expect(value.getState().actors[0].attackSerial).toBe(1);
    input.submit({}, 10);
    value.step();
    input.submit({ attack: true }, 120);
    value.step(45);
    expect(value.getState().actors[0].attackSerial).toBe(2);
    input.submit({ throw: true }, 120);
    value.step(24);
    expect(value.getState().actors[0].charge).toBeGreaterThan(0.2);
    expect(gameEvents(events, 'throw')).toHaveLength(0);
    input.submit({ move: { x: 0, y: -1 } });
    value.step();
    expect(gameEvents(events, 'throw')).toHaveLength(1);
    value.step(5);
    expect(gameEvents(events, 'throw')).toHaveLength(1);
  });

  it('expires a charged sample without interpreting cancellation as a throw release', () => {
    const value = session();
    equipped(value);
    const events = observe(value);
    const input = value.acquire(0);
    input.submit({ throw: true }, 24);
    value.step(18);
    expect(value.getState().actors[0].charge).toBeGreaterThan(0.2);
    value.step(12);
    expect(value.getState().actors[0].charge).toBe(0);
    expect(value.getState().actors[0].armed).toBe(true);
    expect(value.getState().discs).toHaveLength(0);
    expect(gameEvents(events, 'throw')).toHaveLength(0);
    expect(input.active).toBe(true);
    // The same lease can send a fresh intentional press/release after timeout.
    input.submit({ throw: true }, 40);
    value.step(12);
    input.submit({});
    value.step();
    expect(gameEvents(events, 'throw')).toHaveLength(1);
  });

  it('copies external samples, defaults TTL to six ticks, and isolates actor controls', () => {
    const value = session();
    equipped(value);
    const p0 = value.acquire(0);
    const p1 = value.acquire(1);
    const initial = value.getState();
    const action: Action = { move: { x: 1, y: 0 }, throw: true };
    p0.submit(action);
    action.move!.x = -1;
    action.throw = false;
    p1.submit({ move: { x: -1, y: 0 } }, 40);
    value.step(4);
    const moved = value.getState();
    expect(moved.actors[0].position.x).toBeGreaterThan(initial.actors[0].position.x);
    expect(moved.actors[1].position.x).toBeLessThan(initial.actors[1].position.x);
    expect(moved.actors[0].charge).toBeGreaterThan(0);
    expect(moved.actors[1].charge).toBe(0);
    value.step(4);
    expect(value.getState().actors[0].charge).toBe(0);
    expect(value.getState().actors[0].armed).toBe(true);
  });

  it('revokes old leases and never lets them steal a human takeover', () => {
    const value = session();
    equipped(value);
    const old = value.acquire(0, 'old agent');
    old.submit({ move: { x: 1, y: 0 } }, 80);
    value.step(8);
    const human = value.takeover(0, 0);
    expect(old.active).toBe(false);
    expect(() => old.submit({ attack: true })).toThrow(/revok|active|control|lease/i);
    old.release();
    expect(value.snapshot().controls.find((entry) => entry.actorId === 0)?.kind).toBe('human');
    const before = value.getState().actors[0].position.x;
    for (let i = 0; i < 20; i++) {
      value.submitHuman(0, { ...idleCommand(), move: { x: -1, y: 0 } });
      value.step();
    }
    expect(value.getState().actors[0].position.x).toBeLessThan(before);
    human.release();
    human.release();
    expect(human.active).toBe(false);
    expect(value.snapshot().controls.find((entry) => entry.actorId === 0)?.kind).toBe('idle');
    expect(() => old.submit({})).toThrow();
  });

  it('restores the prior script after human takeover and rejects an occupied human slot', () => {
    const value = session();
    equipped(value);
    let scriptCalls = 0;
    value.useScript(
      0,
      () => {
        scriptCalls++;
        return { move: { x: 0, y: -1 } };
      },
      'route script',
    );
    value.step(4);
    const previousCalls = scriptCalls;
    expect(previousCalls).toBeGreaterThan(0);
    const human = value.takeover(0, 0);
    expect(() => value.takeover(0, 0)).toThrow();
    expect(() => value.useHuman(0, 1)).toThrow();
    value.step(8);
    expect(scriptCalls).toBe(previousCalls);
    human.release();
    value.step(5);
    expect(scriptCalls).toBeGreaterThan(previousCalls);
    expect(value.snapshot().controls.find((entry) => entry.actorId === 0)?.kind).toBe('script');
  });

  it('does not replay human commands while a script owns that actor', () => {
    const value = session();
    equipped(value);
    value.useScript(0, () => ({}));
    const before = value.getState().actors[0].position;
    for (let i = 0; i < 10; i++) {
      value.submitHuman(0, { ...idleCommand(), move: { x: 1, y: 0 }, attack: true });
      value.step();
    }
    expect(value.getState().actors[0].position).toEqual(before);
    expect(value.getState().actors[0].attackSerial).toBe(0);
  });

  it('drops pre-play samples at the gameplay boundary and makes active release neutral', () => {
    const value = session();
    const input = value.acquire(0);
    const initial = value.getState().actors[0].position;
    const events = observe(value);
    input.submit({ move: { x: 1, y: 0 }, throw: true }, 600);
    equipped(value);
    expect(value.getState().actors[0].position).toEqual(initial);
    expect(value.getState().actors[0].charge).toBe(0);
    input.submit({ throw: true }, 120);
    value.step(18);
    expect(value.getState().actors[0].charge).toBeGreaterThan(0.2);
    input.release();
    value.step(6);
    expect(input.active).toBe(false);
    expect(value.getState().actors[0].charge).toBe(0);
    expect(value.getState().actors[0].armed).toBe(true);
    expect(gameEvents(events, 'throw')).toHaveLength(0);
    expect(value.snapshot().controls.find((entry) => entry.actorId === 0)?.kind).toBe('idle');
  });
});

describe('SDK lifecycle and isolation', () => {
  it('freezes on pause and clears a held charge without firing on resume', () => {
    const value = session();
    equipped(value);
    const input = value.acquire(0);
    const events = observe(value);
    input.submit({ throw: true }, 120);
    value.step(15);
    expect(value.getState().actors[0].charge).toBeGreaterThan(0.1);
    value.pause();
    const frozen = value.getState();
    value.step(90);
    expect(value.snapshot().status).toBe('paused');
    expect(value.getState()).toEqual(frozen);
    value.resume();
    value.step(6);
    expect(value.getState().actors[0].charge).toBe(0);
    expect(value.getState().actors[0].armed).toBe(true);
    expect(gameEvents(events, 'throw')).toHaveLength(0);
    expect(input.active).toBe(true);
    input.submit({ move: { x: 1, y: 0 } }, 20);
    value.step(8);
    expect(value.getState().actors[0].position.x).toBeGreaterThan(frozen.actors[0].position.x);
  });

  it('start resets the match and invalidates all previous handles and input', () => {
    const value = session();
    equipped(value);
    const external = value.acquire(0);
    external.submit({ throw: true }, 120);
    value.step(12);
    let calls = 0;
    const script = value.useScript(1, () => {
      calls++;
      return {};
    });
    value.step(3);
    const previousCalls = calls;
    value.start({ mapId: 'market', seed: 9 });
    const restarted = value.snapshot();
    expect(restarted.tick).toBe(0);
    expect(restarted.state.round).toBe(1);
    expect(restarted.state.arena.id).toBe('market');
    expect(restarted.state.actors.every((actor) => actor.score === 0 && !actor.armed)).toBe(true);
    expect(external.active).toBe(false);
    expect(script.active).toBe(false);
    expect(() => external.submit({})).toThrow();
    expect(restarted.controls.every((control) => control.kind === 'human')).toBe(true);
    equipped(value);
    expect(calls).toBe(previousCalls);
    expect(value.getState().discs).toHaveLength(0);
  });

  it('clears external samples between real completed rounds without altering score or lives', () => {
    const value = session({ mapRotation: 'cycle' });
    equipped(value);
    const events = observe(value);
    const p0 = value.acquire(0);
    const p1 = value.acquire(1);
    // Real commands move P2 to the unobstructed east edge, then dash into the water.
    p1.submit({ move: { x: 1, y: 0 } }, 600);
    until(value, (state) => state.actors[1].position.x > state.arena.halfWidth - 1.3);
    p0.submit({ throw: true }, 600);
    p1.submit({ move: { x: 1, y: 0 }, dash: true }, 600);
    const ended = until(value, (state) => state.phase === 'roundEnd', 180);
    expect(ended.actors[0].score).toBe(1);
    expect(ended.actors[1].alive).toBe(false);
    const next = until(value, (state) => state.round === 2);
    expect(next.phase).toBe('countdown');
    expect(next.arena.id).toBe('canal');
    expect(next.actors.every((actor) => actor.alive && actor.charge === 0)).toBe(true);
    expect(p0.active && p1.active).toBe(true);
    equipped(value);
    value.step(20);
    const fresh = value.getState();
    expect(fresh.actors[0].position).toEqual(fresh.arena.spawns[0]);
    expect(fresh.actors[1].position).toEqual(fresh.arena.spawns[1]);
    expect(fresh.actors.every((actor) => actor.armed && actor.charge === 0)).toBe(true);
    expect(gameEvents(events, 'throw')).toHaveLength(0);
  });

  it('isolates exceptions and Promise rejections in scripts while another actor continues', async () => {
    const value = session();
    equipped(value);
    const events = observe(value);
    let peerCalls = 0;
    value.useScript(1, () => {
      peerCalls++;
      return {};
    });
    value.useScript(0, () => {
      throw new Error('controller failure');
    });
    expect(() => value.step(3)).not.toThrow();
    expect(peerCalls).toBeGreaterThan(0);
    expect(
      events.some(
        (event) => event.type === 'error' && event.code === 'script' && event.actorId === 0,
      ),
    ).toBe(true);
    expect(value.snapshot().controls.find((control) => control.actorId === 0)?.kind).toBe('idle');

    const rejects = (async () => {
      throw new Error('asynchronous controller failure');
    }) as unknown as ScriptController;
    value.useScript(0, rejects);
    expect(() => value.step()).not.toThrow();
    // Rejected async controllers must be consumed, not leak an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.filter((event) => event.type === 'error')).toHaveLength(2);
    expect(value.snapshot().controls.find((control) => control.actorId === 0)?.kind).toBe('idle');
    value.useScript(0, (() =>
      Promise.resolve({ move: { x: 1, y: 0 } })) as unknown as ScriptController);
    value.step();
    await Promise.resolve();
    expect(events.filter((event) => event.type === 'error')).toHaveLength(3);
    value.useScript(0, () => ({ move: { x: NaN, y: 0 } }));
    expect(() => value.step()).not.toThrow();
    expect(events.filter((event) => event.type === 'error')).toHaveLength(4);
    expect(Number.isFinite(value.getState().actors[0].position.x)).toBe(true);
  });

  it('isolates listeners, source getters, script snapshots and event payload mutation', () => {
    const value = session();
    equipped(value);
    const original = value.getState();
    const polluted = value.getState();
    polluted.actors[0].position.x = Infinity;
    polluted.actors[1].score = 999;
    polluted.arena.obstacles.splice(0);
    const pollutedSnapshot = value.snapshot();
    pollutedSnapshot.controls[0].kind = 'idle';
    pollutedSnapshot.state.options.scoreGoal = 100;
    expect(value.getState()).toEqual(original);
    expect(value.snapshot().controls[0].kind).toBe('human');
    value.useScript(0, ({ state }) => {
      state.actors[1].position.x = Infinity;
      state.actors[0].score = 100;
      return {};
    });
    let peerSawFinite = false;
    value.useScript(1, ({ state }) => {
      peerSawFinite = Number.isFinite(state.actors[1].position.x);
      return {};
    });
    const stopThrowing = value.onEvent(() => {
      throw new Error('listener failure');
    });
    value.onEvent((event) => {
      if (event.type === 'game') event.event.position.x = Infinity;
      if (event.type === 'control') event.control.kind = 'idle';
    });
    const intact = observe(value);
    value.step(2);
    expect(peerSawFinite).toBe(true);
    expect(value.snapshot().listenerErrors).toBeGreaterThan(0);
    stopThrowing();
    const errorsBefore = value.snapshot().listenerErrors;
    const input = value.acquire(0);
    input.submit({ attack: true });
    value.step();
    expect(value.snapshot().listenerErrors).toBe(errorsBefore);
    expect(
      intact.some((event) => event.type === 'control' && event.control.kind === 'external'),
    ).toBe(true);
    expect(
      intact
        .filter((event) => event.type === 'game')
        .every((event) => Number.isFinite(event.event.position.x)),
    ).toBe(true);
    expect(
      value
        .getState()
        .actors.every((actor) => actor.score === 0 && Number.isFinite(actor.position.x)),
    ).toBe(true);
  });

  it('destroy is idempotent and revokes all operations except the disposed snapshot', () => {
    const value = session();
    const input = value.acquire(0);
    const events = observe(value);
    value.destroy();
    value.destroy();
    input.release();
    expect(input.active).toBe(false);
    expect(value.snapshot().status).toBe('disposed');
    expect(
      events.filter((event) => event.type === 'lifecycle' && event.action === 'destroy'),
    ).toHaveLength(1);
    const operations = [
      () => value.start(),
      () => value.pause(),
      () => value.resume(),
      () => value.step(),
      () => value.getState(),
      () => value.acquire(0),
      () => value.useScript(0, () => ({})),
      () => value.useBot(0),
      () => value.useHuman(0),
      () => value.takeover(0),
      () => value.submitHuman(0, idleCommand()),
      () => value.onEvent(() => {}),
      () => input.submit({}),
    ];
    for (const operation of operations) expect(operation).toThrow();
  });
});

describe('SDK validation and reproducibility', () => {
  it('rejects invalid IDs, action scalars, options, TTL and tick counts', () => {
    const value = session();
    for (const id of [NaN, Infinity, -1, 0.5, 99]) {
      expect(() => value.acquire(id)).toThrow();
      expect(() => value.useBot(id)).toThrow();
      expect(() => value.useScript(id, () => ({}))).toThrow();
      expect(() => value.takeover(id)).toThrow();
    }
    for (const ticks of [NaN, Infinity, -1, 0, 1.5, 1_000_001])
      expect(() => value.step(ticks)).toThrow();
    const input = value.acquire(0);
    for (const ttl of [NaN, Infinity, -1, 0, 1.5, 601])
      expect(() => input.submit({}, ttl)).toThrow();
    for (const bad of [NaN, Infinity, -Infinity])
      expect(() => input.submit({ move: { x: bad, y: 0 } })).toThrow();
    expect(() => input.submit({ dash: 'yes' } as unknown as Action)).toThrow();
    expect(() => value.submitHuman(1, { ...idleCommand(), move: { x: NaN, y: 0 } })).toThrow();
    expect(() => value.useHuman(0, -1)).toThrow();
    const beforeBadOptions = value.getState();
    for (const override of [
      { seed: NaN },
      { seed: -1 },
      { seed: 2 ** 32 },
      { scoreGoal: 0 },
      { scoreGoal: 1.5 },
      { bots: -1 },
      { bots: 99 },
      { bots: 1.5 },
      { mapId: 'missing' },
      { mapRotation: 'unknown' },
      { difficulty: 'unknown' },
      { mode: 'online' },
    ]) {
      expect(() => createSession({ ...options, ...override } as Partial<MatchOptions>)).toThrow();
      expect(() => value.start(override as Partial<MatchOptions>)).toThrow();
    }
    expect(value.getState()).toEqual(beforeBadOptions);
    expect(input.active).toBe(true);
  });

  it('gives the same state and event stream for the same seed and public action sequence', () => {
    const first = session({ seed: 773, mapId: 'portals' });
    const second = session({ seed: 773, mapId: 'portals' });
    equipped(first);
    equipped(second);
    const left = [first.acquire(0), first.acquire(1)];
    const right = [second.acquire(0), second.acquire(1)];
    const leftEvents = observe(first);
    const rightEvents = observe(second);
    for (let tick = 0; tick < 1200; tick++) {
      for (let actorId = 0; actorId < 2; actorId++) {
        const angle = tick / 85 + actorId * Math.PI;
        const action: Action = {
          move: { x: Math.cos(angle), y: Math.sin(angle) },
          attack: tick % 80 === actorId,
          dash: tick % 123 === actorId,
          throw: tick % 77 < 26,
        };
        left[actorId].submit(action);
        right[actorId].submit(action);
      }
      first.step();
      second.step();
    }
    expect(first.getState()).toEqual(second.getState());
    expect(first.snapshot().tick).toBe(second.snapshot().tick);
    expect(leftEvents).toEqual(rightEvents);
  });

  it('runs a complete five-point bot match through public useBot and step', () => {
    const value = session({ seed: 41 });
    value.useBot(0);
    value.useBot(1);
    const counts: Record<string, number> = {};
    value.onEvent((event) => {
      if (event.type === 'game') counts[event.event.type] = (counts[event.event.type] ?? 0) + 1;
    });
    let state = value.getState();
    for (let tick = 0; tick < 60 * 420 && state.phase !== 'matchEnd'; tick += 60) {
      value.step(60);
      state = value.getState();
    }
    expect(
      state.phase,
      JSON.stringify({ counts, scores: state.actors.map((actor) => actor.score) }),
    ).toBe('matchEnd');
    expect(state.actors.some((actor) => actor.score === 5)).toBe(true);
    expect(counts.death).toBeGreaterThanOrEqual(5);
    expect((counts.throw ?? 0) + (counts.slash ?? 0)).toBeGreaterThanOrEqual(5);
  }, 30000);

  it('runs a real script-versus-bot match with movement and combat until a winner', () => {
    const value = session({ seed: 295 });
    let calls = 0;
    value.useScript(
      0,
      ({ state, actorId, tick }) => {
        calls++;
        const self = state.actors.find((actor) => actor.id === actorId)!;
        const target = state.actors.find((actor) => actor.id !== actorId && actor.alive);
        if (!self.alive || !target) return {};
        const dx = target.position.x - self.position.x;
        const dy = target.position.y - self.position.y;
        const distance = Math.hypot(dx, dy);
        // A deliberately simple controller: strafe to clear the fountain, then face the target.
        const circle = tick % 180 < 55;
        return {
          move: circle ? { x: -dy, y: dx } : { x: dx, y: dy },
          throw: self.armed ? tick % 75 < 27 : true,
          attack: distance < 2.5 && tick % 45 === 0,
          dash: distance < 3 && tick % 110 === 0,
        };
      },
      'public API duelist',
    );
    value.useBot(1);
    const counts: Record<string, number> = {};
    const errors: SessionEvent[] = [];
    value.onEvent((event) => {
      if (event.type === 'game') counts[event.event.type] = (counts[event.event.type] ?? 0) + 1;
      if (event.type === 'error') errors.push(event);
    });
    let state = value.getState();
    for (let tick = 0; tick < 60 * 600 && state.phase !== 'matchEnd'; tick += 60) {
      value.step(60);
      state = value.getState();
      expect(
        state.actors.every((actor) => Number.isFinite(actor.position.x + actor.position.y)),
      ).toBe(true);
      expect(state.discs.length).toBeLessThanOrEqual(2);
    }
    expect(errors).toHaveLength(0);
    expect(calls).toBeGreaterThan(100);
    expect(
      state.phase,
      JSON.stringify({ counts, scores: state.actors.map((actor) => actor.score) }),
    ).toBe('matchEnd');
    expect(state.actors.some((actor) => actor.score === 5)).toBe(true);
    expect(counts.throw).toBeGreaterThan(0);
    expect(counts.death).toBeGreaterThanOrEqual(5);
  }, 30000);
});
