import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { v } from '../src/core/math';
import { idleCommand, type Command } from '../src/core/types';
import { tickActor } from '../src/simulation/actors';
import { createState, defaultOptions } from '../src/simulation/state';

function fixture() {
  const state = createState(defaultOptions());
  state.phase = 'playing';
  state.safeRadius = 1000;
  state.arena.halfWidth = 100;
  state.arena.halfHeight = 100;
  state.arena.obstacles = [];
  state.arena.pits = [];
  const actor = state.actors[0];
  actor.armed = true;
  actor.position = v();
  actor.previous = v();
  actor.facing = v(1, 0);
  const step = (command: Partial<Command> = {}, frames = 1) => {
    for (let i = 0; i < frames; i++)
      tickActor(state, actor, { ...idleCommand(), ...command }, RULES.dt);
  };
  return { state, actor, step };
}

describe('movement derived from static force and drag rules', () => {
  it('accelerates from rest and coasts after release at the fixed 60 Hz step', () => {
    const { actor, step } = fixture();
    step({ move: v(1, 0) });
    expect(actor.velocity.x).toBeCloseTo(1.08888889, 7);
    step({ move: v(1, 0) }, 119);
    expect(actor.velocity.x).toBeCloseTo(5.93939394, 6);
    const releasePosition = actor.position.x;
    step({}, 12);
    expect(actor.velocity.x).toBeCloseTo(0.5227332, 5);
    expect(actor.position.x - releasePosition).toBeGreaterThan(0.39);
    expect(actor.position.x - releasePosition).toBeLessThan(0.42);
  });

  it('turns 18 degrees on the first walking step, while dash snaps and locks direction', () => {
    const { actor, step } = fixture();
    step({ move: v(0, 1) });
    expect(Math.atan2(actor.facing.y, actor.facing.x)).toBeCloseTo(Math.PI / 10, 8);
    const perpendicularMomentum = actor.velocity.y;
    step({ move: v(-1, 0), dash: true });
    expect(actor.facing).toEqual(v(-1, 0));
    step({ move: v(0, 1) }, 20);
    expect(actor.facing).toEqual(v(-1, 0));
    // A snapped dash adds force along its axis; it preserves existing perpendicular momentum.
    expect(actor.velocity.y).toBeCloseTo(
      perpendicularMomentum * (1 - RULES.damping * RULES.dt) ** 21,
      10,
    );
  });

  it('integrates the cosine dash force instead of assigning a linear speed each frame', () => {
    const { actor, step } = fixture();
    step({ dash: true, move: v(1, 0) });
    expect(actor.velocity.x).toBeCloseTo(23.19333333, 6);
    step({}, 11);
    expect(actor.dashTime).toBe(0);
    expect(actor.position.x).toBeCloseTo(3.63477469, 6);
    step({}, 21);
    expect(actor.position.x).toBeCloseTo(4.42572594, 6);
    expect(actor.dashCooldown).toBeGreaterThan(0);
    step({ move: v(0, 1) });
    expect(actor.dashCooldown).toBe(0);
    expect(actor.velocity.y).toBeGreaterThan(1);
  });
});

describe('action recovery, input windows and priority', () => {
  it.each([
    { haste: false, firstRepeatFrame: 34, pressFrame: 22 },
    { haste: true, firstRepeatFrame: 21, pressFrame: 12 },
  ])('repeats dash only after the $haste haste recovery with a buffered press', (sample) => {
    const { state, actor, step } = fixture();
    if (sample.haste) actor.powers = ['haste'];
    step({ dash: true });
    for (let frame = 2; frame < sample.firstRepeatFrame; frame++) {
      step({ dash: frame === sample.pressFrame });
      expect(state.events.filter((event) => event.type === 'dash')).toHaveLength(1);
    }
    step();
    expect(state.events.filter((event) => event.type === 'dash')).toHaveLength(2);
  });

  it('expires a dash pressed more than 250 ms before recovery', () => {
    const { state, step } = fixture();
    step({ dash: true });
    step({ dash: true });
    step({}, 40);
    expect(state.events.filter((event) => event.type === 'dash')).toHaveLength(1);
  });

  it('retains an attack pressed 300 ms before recovery and accepts input during stun', () => {
    const { actor, step } = fixture();
    actor.attackCooldown = 0.3;
    actor.stun = 0.15;
    step({ attack: true });
    expect(actor.attackSerial).toBe(0);
    step({}, 17);
    expect(actor.attackSerial).toBe(1);
  });

  it('keeps the 200 ms hit window separate from 500 ms movement recovery', () => {
    const { actor, step } = fixture();
    step({ attack: true });
    step({ move: v(0, 1) }, 12);
    expect(actor.attackTime).toBe(0);
    expect(actor.lungeRecovery).toBeGreaterThan(0);
    expect(actor.facing).toEqual(v(1, 0));
    step({ move: v(0, 1) }, 17);
    expect(actor.velocity.y).toBe(0);
    step({ move: v(0, 1) });
    expect(actor.lungeRecovery).toBe(0);
    expect(actor.velocity.y).toBeGreaterThan(1);
  });

  it('gives fresh melee priority over throw release and dash in the same tick', () => {
    const { state, actor, step } = fixture();
    step({ attack: true, throwReleased: true, dash: true });
    expect(
      state.events
        .filter((event) => ['slash', 'dash', 'throw'].includes(event.type))
        .map((event) => event.type),
    ).toEqual(['slash']);
    expect(actor.armed).toBe(true);
    expect(state.discs).toHaveLength(0);
  });

  it('allows throw release then dash in the same tick, and melee can cancel an active dash', () => {
    const throwing = fixture();
    throwing.step({ throwReleased: true, dash: true });
    expect(
      throwing.state.events
        .filter((event) => ['dash', 'throw'].includes(event.type))
        .map((event) => event.type),
    ).toEqual(['throw', 'dash']);
    const cancelling = fixture();
    cancelling.step({ dash: true });
    cancelling.step({ attack: true, move: v(0, 1) });
    expect(cancelling.actor.dashTime).toBe(0);
    expect(cancelling.actor.attackTime).toBe(RULES.attackDuration);
    expect(cancelling.actor.facing).toEqual(v(1, 0));
  });
});

describe('aiming movement', () => {
  it('holds aim for the 100 ms startup plus 900 ms charge curve', () => {
    const { actor, step } = fixture();
    step({ throwHeld: true }, 54);
    expect(actor.charge).toBeCloseTo(0.9, 10);
    expect(actor.charge).toBeLessThan(RULES.chargeTime);
    step({ throwHeld: true }, 6);
    expect(actor.charge).toBe(1);
    step({ throwHeld: true }, 12);
    expect(actor.charge).toBe(1);
  });

  it('removes movement force after the aim threshold but still lets the player turn', () => {
    const { actor, step } = fixture();
    step({ move: v(1, 0), throwHeld: true }, 6);
    const velocityAtThreshold = actor.velocity.x;
    step({ move: v(0, 1), throwHeld: true }, 12);
    expect(actor.velocity.x).toBeLessThan(velocityAtThreshold * 0.1);
    expect(actor.velocity.y).toBe(0);
    expect(actor.facing.y).toBeGreaterThan(0.99);
    expect(actor.charge).toBeCloseTo(0.3);
  });

  it('eases movement back for 500 ms after aiming and allows dash to cancel aiming', () => {
    const recovering = fixture();
    recovering.step({ move: v(1, 0), throwHeld: true }, 30);
    recovering.step({ move: v(1, 0), throwReleased: true });
    expect(recovering.actor.aimMoveLag).toBeCloseTo(1 - 1 / 30);
    expect(recovering.actor.velocity.x).toBeLessThan(0.1);
    recovering.step({ move: v(1, 0) }, 29);
    expect(recovering.actor.aimMoveLag).toBeCloseTo(0);
    const cancelling = fixture();
    cancelling.step({ throwHeld: true }, 20);
    cancelling.step({ throwHeld: true, dash: true });
    expect(cancelling.actor.charge).toBe(0);
    expect(cancelling.actor.throwBlocked).toBe(true);
    cancelling.step({ throwReleased: true });
    expect(cancelling.state.discs).toHaveLength(0);
  });
});
