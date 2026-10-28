import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { length, v } from '../src/core/math';
import { createState, defaultOptions } from '../src/simulation/state';
import { canRescueFall, hazardKind, rescueFall, tickFall } from '../src/simulation/hazards';

function fixture(kind: 'water' | 'cliff' = 'water') {
  const state = createState(defaultOptions());
  state.phase = 'playing';
  state.arena.obstacles = [];
  state.arena.halfWidth = 5;
  state.arena.halfHeight = 4;
  state.arena.pits = [{ position: v(), half: v(1, 1) }];
  state.events = [];
  const actor = state.actors[0];
  actor.position = kind === 'water' ? v() : v(5.2, 0);
  actor.previous = { ...actor.position };
  const advance = (ticks = 1) => {
    for (let i = 0; i < ticks; i++) {
      state.time += RULES.dt;
      tickFall(state, actor, RULES.dt);
    }
  };
  return { state, actor, advance };
}

describe('hazard classification and delayed death', () => {
  it('distinguishes interior water, outer cliffs and exact supported edges', () => {
    const { state } = fixture();
    expect(hazardKind(state.arena, v(0, 0))).toBe('water');
    expect(hazardKind(state.arena, v(5.01, 0))).toBe('cliff');
    expect(hazardKind(state.arena, v(0, -4.01))).toBe('cliff');
    expect(hazardKind(state.arena, v(5, 4))).toBeNull();
    expect(hazardKind(state.arena, v(1, 0))).toBeNull();
    expect(hazardKind(state.arena, v(3, 2))).toBeNull();
  });

  it.each([
    ['water', 0.66, 40],
    ['cliff', 0.74, 45],
  ] as const)(
    '%s remains alive until the first complete duration tick',
    (kind, duration, ticks) => {
      const { state, actor, advance } = fixture(kind);
      advance();
      expect(actor.fall).toEqual({ kind, elapsed: 0, duration });
      expect(actor.alive).toBe(true);
      expect(state.actors.map((a) => a.score)).toEqual([0, 0]);
      expect(state.events).toEqual([]);
      advance(ticks - 1);
      expect(actor.alive).toBe(true);
      expect(state.events).toEqual([]);
      advance();
      expect(actor.alive).toBe(false);
      const deaths = state.events.filter((event) => event.type === 'death');
      expect(deaths).toHaveLength(1);
      expect(deaths[0]).toMatchObject({ actorId: actor.id, cause: 'fall', value: actor.id });
      expect(state.actors.map((a) => ({ score: a.score, kills: a.kills }))).toEqual([
        { score: 0, kills: 0 },
        { score: 0, kills: 0 },
      ]);
      advance(90);
      expect(state.events.filter((event) => event.type === 'death')).toHaveLength(1);
    },
  );

  it('ends a fall even when shielding or temporarily invulnerable', () => {
    const { state, actor, advance } = fixture();
    actor.shield = true;
    actor.invulnerable = 2;
    advance(41);
    expect(actor.alive).toBe(false);
    expect(state.events.some((event) => event.type === 'shield')).toBe(false);
  });

  it('cancels an in-progress attack/charge on entry without scoring or moving the actor', () => {
    const { state, actor, advance } = fixture();
    actor.armed = true;
    actor.charge = 0.7;
    actor.recalling = true;
    actor.aimMoveLag = 1;
    actor.attackTime = 0.2;
    actor.lungeTime = 0.1;
    actor.lungeRecovery = 0.5;
    actor.bufferedAttack = 0.3;
    actor.velocity = v(30, 40);
    const position = { ...actor.position };
    advance();
    expect(actor.position).toEqual(position);
    expect(actor.armed).toBe(true);
    expect(actor).toMatchObject({
      alive: true,
      charge: 0,
      recalling: false,
      aimMoveLag: 0,
      attackTime: 0,
      lungeTime: 0,
      lungeRecovery: 0,
      bufferedAttack: 0,
      throwBlocked: true,
    });
    expect(length(actor.velocity)).toBeCloseTo(RULES.speedLimit * 0.33);
    expect(actor.velocity.y / actor.velocity.x).toBeCloseTo(4 / 3);
    expect(state.events).toEqual([]);
  });

  it('preserves the outward edge drift and does not boost a stationary fall', () => {
    const edge = fixture('cliff');
    edge.actor.velocity = v(4, 0);
    edge.advance();
    expect(edge.actor.velocity).toEqual(v(RULES.speedLimit * 0.6, 0));
    const still = fixture('water');
    still.actor.velocity = v();
    still.advance();
    expect(still.actor.velocity).toEqual(v());
  });
});

describe('fall rescue affordance', () => {
  it('allows one dash rescue through .33 seconds but rejects later attempts', () => {
    const { actor, advance } = fixture();
    expect(canRescueFall(actor)).toBe(false);
    expect(rescueFall(actor)).toBe(false);
    advance();
    advance(19);
    expect(canRescueFall(actor)).toBe(true);
    actor.fall!.elapsed = 0.33;
    expect(canRescueFall(actor)).toBe(true);
    actor.fall!.elapsed = 0.330001;
    expect(canRescueFall(actor)).toBe(false);
    expect(rescueFall(actor)).toBe(false);
    actor.fall!.elapsed = 0.33;
    expect(rescueFall(actor)).toBe(true);
    expect(actor.fall).toBeUndefined();
    expect(actor.fallsSaved).toBe(1);
    expect(rescueFall(actor)).toBe(false);
  });

  it('rejects rescue after the twentieth 60 Hz falling tick', () => {
    const { actor, advance } = fixture();
    advance();
    advance(20);
    expect(actor.fall!.elapsed).toBeGreaterThan(0.33);
    expect(rescueFall(actor)).toBe(false);
  });

  it('allows an existing dash to cross a gap, then starts falling when it ends', () => {
    const { actor, advance } = fixture();
    actor.dashTime = 0.1;
    advance(12);
    expect(actor.fall).toBeUndefined();
    expect(actor.alive).toBe(true);
    actor.dashTime = 0;
    advance();
    expect(actor.fall?.elapsed).toBe(0);
  });

  it('prevents repeated midair saves until a rescued dash lands on supported ground', () => {
    const { actor, advance } = fixture();
    advance();
    expect(rescueFall(actor)).toBe(true);
    actor.dashTime = 0.1;
    advance(6);
    expect(actor.fall).toBeUndefined();
    actor.dashTime = 0;
    advance();
    expect(actor.fallsSaved).toBe(1);
    expect(canRescueFall(actor)).toBe(false);
    expect(rescueFall(actor)).toBe(false);

    const landed = fixture();
    landed.advance();
    rescueFall(landed.actor);
    landed.actor.position = v(2, 0);
    landed.actor.dashTime = 0.1;
    landed.advance();
    expect(landed.actor.fallsSaved).toBe(1);
    landed.actor.dashTime = 0;
    landed.advance();
    expect(landed.actor.fallsSaved).toBe(0);
    landed.actor.position = v();
    landed.advance();
    expect(canRescueFall(landed.actor)).toBe(true);
  });

  it('recovers early footing but does not restore a late falling actor', () => {
    const early = fixture();
    early.advance(10);
    early.actor.position = v(2, 0);
    early.advance();
    expect(early.actor.fall).toBeUndefined();
    expect(early.actor.fallsSaved).toBe(0);
    expect(early.actor.alive).toBe(true);
    const late = fixture();
    late.advance();
    late.actor.fall!.elapsed = 0.33;
    late.actor.position = v(2, 0);
    late.advance();
    expect(late.actor.fall).toBeDefined();
    late.advance(20);
    expect(late.actor.alive).toBe(false);
  });
});
