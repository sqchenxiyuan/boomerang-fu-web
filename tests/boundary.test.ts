import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { Random, v } from '../src/core/math';
import { idleCommand } from '../src/core/types';
import { matchOptions } from '../src/sdk/control';
import {
  boundaryCurve,
  isInBoundary,
  startShrinkingBoundary,
  tickActorBoundary,
  tickBoundary,
} from '../src/simulation/boundary';
import { damageActor } from '../src/simulation/combat';
import { tickActor } from '../src/simulation/actors';
import { Game } from '../src/simulation/game';
import { createState, defaultOptions, resetRound } from '../src/simulation/state';

function fixture() {
  const state = createState();
  state.phase = 'playing';
  state.arena.obstacles = [];
  state.arena.pits = [];
  state.actors[0].position = v(-3, 0);
  state.actors[1].position = v(3, 0);
  return state;
}

describe('rectangular sudden death', () => {
  it('defaults to packaged 180 seconds and validates explicit short matches', () => {
    expect(defaultOptions().suddenDeathTime).toBe(180);
    expect(matchOptions(defaultOptions(), { suddenDeathTime: 2.5 }).suddenDeathTime).toBe(2.5);
    expect(matchOptions(defaultOptions(), { suddenDeathTime: 0 }).suddenDeathTime).toBe(0);
    for (const suddenDeathTime of [-1, Infinity, NaN])
      expect(() => matchOptions(defaultOptions(), { suddenDeathTime })).toThrow();
  });

  it('uses strict rectangle edges and keeps the corners that a circle would exclude', () => {
    const state = fixture();
    state.boundary.center = v(4, -1);
    state.boundary.halfSize = v(2, 2);
    expect(isInBoundary(state.boundary, v(5.99, 0.99))).toBe(true);
    expect(isInBoundary(state.boundary, v(6, -1))).toBe(false);
    expect(isInBoundary(state.boundary, v(4, 1))).toBe(false);
    expect(isInBoundary(state.boundary, v(1.99, -1))).toBe(false);
  });

  it('starts strictly after the threshold, using seeded random targets within the original box', () => {
    const a = fixture(),
      b = fixture();
    a.roundTime = 180;
    tickBoundary(a, new Random(7), RULES.dt);
    expect(a.boundary.phase).toBe('idle');
    a.roundTime = b.roundTime = 180 + RULES.dt;
    tickBoundary(a, new Random(7), RULES.dt);
    tickBoundary(b, new Random(7), RULES.dt);
    expect(a.boundary.phase).toBe('shrinking');
    expect(a.boundary.targetCenter).toEqual(b.boundary.targetCenter);
    expect(a.boundary.targetCenter).not.toEqual(v());
    expect(Math.abs(a.boundary.targetCenter.x) + 2).toBeLessThanOrEqual(a.arena.halfWidth);
    expect(Math.abs(a.boundary.targetCenter.y) + 2).toBeLessThanOrEqual(a.arena.halfHeight);
    expect(a.boundary.duration).toBeCloseTo((a.arena.halfWidth * 2) / 2.8, 10);
    expect(a.suddenDeathStarted).toBe(true);
    expect(a.events.filter((event) => event.type === 'boundary')).toHaveLength(1);
    tickBoundary(a, new Random(7), RULES.dt);
    expect(a.events.filter((event) => event.type === 'boundary')).toHaveLength(1);
  });

  it('evaluates the actual curve and stops permanently at four by four Web units', () => {
    const state = fixture();
    expect(boundaryCurve(0.8998180031776428)).toBeCloseTo(0.9163225889205933, 10);
    expect(boundaryCurve(0.01)).toBe(0);
    expect(boundaryCurve(0.5)).toBeLessThan(0.5);
    startShrinkingBoundary(state, v(5, -3));
    const duration = state.boundary.duration;
    tickBoundary(state, new Random(1), duration);
    tickBoundary(state, new Random(1), RULES.dt);
    expect(state.boundary.phase).toBe('settled');
    expect(state.boundary.halfSize).toEqual(v(2, 2));
    expect(state.boundary.center).toEqual(v(5, -3));
    tickBoundary(state, new Random(1), 500);
    expect(state.boundary.halfSize).toEqual(v(2, 2));
  });

  it('stops at the current rectangle when only one opponent remains', () => {
    const state = fixture();
    startShrinkingBoundary(state, v(5, 2));
    tickBoundary(state, new Random(1), state.boundary.duration / 2);
    const before = structuredClone(state.boundary);
    state.actors[1].alive = false;
    tickBoundary(state, new Random(1), 3);
    expect(state.boundary.phase).toBe('settled');
    expect(state.boundary.center).toEqual(before.center);
    expect(state.boundary.halfSize).toEqual(before.halfSize);
    expect(state.boundary.halfSize.x).toBeGreaterThan(2);
  });

  it('does not start sudden death with one opponent and has no 65 second forced result', () => {
    const game = new Game();
    game.state = fixture();
    game.state.roundTime = 66;
    game.step();
    expect(game.state.phase).toBe('playing');
    expect(game.state.boundary.phase).toBe('idle');
    game.state.actors[1].alive = false;
    game.state.roundTime = 181;
    tickBoundary(game.state, new Random(1), RULES.dt);
    expect(game.state.boundary.phase).toBe('idle');
  });

  it('freezes all boundary timers during hit stop', () => {
    const game = new Game();
    game.state = fixture();
    startShrinkingBoundary(game.state, v());
    game.state.actors[0].outOfBounds = { remaining: 2, duration: 3.75 };
    game.state.hitStop = 0.2;
    const time = game.state.roundTime;
    game.step();
    expect(game.state.roundTime).toBe(time);
    expect(game.state.boundary.elapsed).toBe(0);
    expect(game.state.actors[0].outOfBounds.remaining).toBe(2);
  });
});

describe('out of bounds grace and death', () => {
  it.each([
    ['idle', 3],
    ['shrinking', 3.75],
    ['settled', 3],
  ] as const)(
    'captures %s exit grace as %s seconds and kills on the update after expiry',
    (phase, duration) => {
      const state = fixture(),
        actor = state.actors[0];
      state.boundary.phase = phase;
      state.boundary.halfSize = v(2, 2);
      actor.position = v(3, 0);
      actor.shield = true;
      actor.invulnerable = 10;
      actor.dashTime = 10;
      tickActorBoundary(state, actor, 0);
      expect(actor.outOfBounds).toEqual({ duration, remaining: duration });
      tickActorBoundary(state, actor, duration);
      expect(actor.alive).toBe(true);
      expect(actor.outOfBounds?.remaining).toBe(0);
      tickActorBoundary(state, actor, RULES.dt);
      expect(actor.alive).toBe(false);
      expect(actor.death?.cause).toBe('boundary');
      expect(actor.death?.variant).toBe('burst');
      expect(actor.shield).toBe(false);
    },
  );

  it('re-entry cancels expiry and a later exit receives a fresh duration', () => {
    const state = fixture(),
      actor = state.actors[0];
    state.boundary.halfSize = v(2, 2);
    actor.position = v(3, 0);
    tickActorBoundary(state, actor, 3);
    actor.position = v();
    tickActorBoundary(state, actor, RULES.dt);
    expect(actor.alive).toBe(true);
    expect(actor.outOfBounds).toBeUndefined();
    actor.position = v(3, 0);
    state.boundary.phase = 'shrinking';
    tickActorBoundary(state, actor, 0);
    expect(actor.outOfBounds?.remaining).toBe(3.75);
    state.boundary.phase = 'settled';
    tickActorBoundary(state, actor, 1);
    expect(actor.outOfBounds?.remaining).toBeCloseTo(2.75);
    expect(actor.outOfBounds?.duration).toBe(3.75);
  });

  it('pauses positive outside time while falling and resets all transient state next round', () => {
    const state = fixture(),
      actor = state.actors[0];
    state.boundary.halfSize = v(2, 2);
    actor.position = v(3, 0);
    actor.fall = { kind: 'water', elapsed: 0, duration: 0.66 };
    tickActorBoundary(state, actor, 1);
    expect(actor.outOfBounds?.remaining).toBe(3);
    startShrinkingBoundary(state, v(), 1);
    state.suddenDeathStarted = true;
    actor.fallsSaved = 1;
    resetRound(state);
    expect(state.boundary.phase).toBe('idle');
    expect(state.boundary.ownerId).toBeNull();
    expect(state.suddenDeathStarted).toBe(false);
    expect(actor.outOfBounds).toBeUndefined();
    expect(actor.fall).toBeUndefined();
    expect(actor.fallsSaved).toBe(0);
    expect(actor.death).toBeUndefined();
  });

  it('keeps immutable death geometry and deterministic variants/seeds', () => {
    const state = fixture(),
      actor = state.actors[0];
    const position = { ...actor.position };
    damageActor(state, actor, 1, v(3, 4), 'explosion');
    const event = state.events.find((e) => e.type === 'death')!;
    expect(actor.death?.variant).toBe('squash');
    expect(actor.death?.direction.x).toBeCloseTo(0.6);
    expect(actor.death?.direction.y).toBeCloseTo(0.8);
    expect(event.direction).toEqual(actor.death?.direction);
    expect(event.variant).toBe('squash');
    actor.position.x += 5;
    expect(actor.death?.position).toEqual(position);
    const again = fixture();
    damageActor(again, again.actors[0], 1, v(3, 4), 'explosion');
    expect(again.actors[0].death?.seed).toBe(actor.death?.seed);
  });
});

describe('survival resolution', () => {
  it('accepts an early dash rescue through real actor input and rejects late falling actions', () => {
    const state = fixture(),
      actor = state.actors[0];
    actor.position = v(state.arena.halfWidth + 0.1, 0);
    tickActor(state, actor, idleCommand(), RULES.dt);
    expect(actor.fall?.kind).toBe('cliff');
    expect(actor.alive).toBe(true);
    tickActor(state, actor, { ...idleCommand(), dash: true, move: v(-1, 0) }, RULES.dt);
    expect(actor.fall).toBeUndefined();
    expect(actor.fallsSaved).toBe(1);
    expect(actor.dashTime).toBeGreaterThan(0);
    expect(actor.position.x).toBeLessThan(state.arena.halfWidth);
    actor.position = v(state.arena.halfWidth + 0.1, 0);
    actor.velocity = v();
    actor.dashTime = actor.dashCooldown = 0;
    actor.fallsSaved = 0;
    actor.fall = { kind: 'cliff', elapsed: 0.34, duration: 0.74 };
    const eventCount = state.events.length;
    tickActor(
      state,
      actor,
      { ...idleCommand(), attack: true, dash: true, throwReleased: true, move: v(-1, 0) },
      RULES.dt,
    );
    expect(actor.fall).toBeDefined();
    expect(actor.dashTime).toBe(0);
    expect(state.events.length).toBe(eventCount);
    expect(actor.position.x).toBeCloseTo(state.arena.halfWidth + 0.1);
  });

  it('withholds the survival point if the last actor starts falling during confirmation', () => {
    const game = new Game();
    game.state = fixture();
    damageActor(game.state, game.state.actors[1], 0, v(1, 0));
    for (let i = 0; i < 70; i++) game.step();
    game.state.actors[0].position = v(game.state.arena.halfWidth + 0.2, 0);
    for (let i = 0; i < 20; i++) game.step();
    expect(game.state.actors[0].fall).toBeDefined();
    expect(game.state.phase).toBe('playing');
    expect(game.state.actors[0].score).toBe(0);
    for (let i = 0; i < 180 && game.state.phase === 'playing'; i++) game.step();
    expect(game.state.phase).toBe('roundEnd');
    expect(game.state.winnerId).toBeNull();
    expect(game.state.actors.every((actor) => actor.score === 0)).toBe(true);
  });

  it('continues simulation for the original 1.45 second confirmation before scoring', () => {
    const game = new Game();
    game.state = fixture();
    damageActor(game.state, game.state.actors[1], 0, v(1, 0));
    for (let i = 0; i < 86; i++) game.step();
    expect(game.state.phase).toBe('playing');
    expect(game.state.actors[0].score).toBe(0);
    game.step();
    expect(game.state.phase).toBe('roundEnd');
    expect(game.state.actors[0].score).toBe(1);
  });

  it('allows a delayed explosion to turn the would-be win into a draw', () => {
    const game = new Game();
    game.state = fixture();
    const state = game.state;
    damageActor(state, state.actors[1], 0, v(1, 0));
    state.discs.push({
      id: 1,
      ownerId: 1,
      damageOwnerId: 1,
      position: { ...state.actors[0].position },
      previous: v(),
      velocity: v(),
      state: 'dropped',
      age: 0,
      stateTime: 0,
      charge: 0,
      curve: 0,
      bounces: 0,
      explosive: true,
      fuse: 0.4,
      grace: 0,
      lastDeflector: -1,
      dead: false,
    });
    for (let i = 0; i < 240 && state.phase === 'playing'; i++) game.step();
    expect(state.phase).toBe('roundEnd');
    expect(state.winnerId).toBeNull();
    expect(state.actors.every((a) => a.score === 0)).toBe(true);
    expect(state.actors[0].death?.cause).toBe('explosion');
  });
});
