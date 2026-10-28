import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { Random, v } from '../src/core/math';
import { idleCommand } from '../src/core/types';
import type { Command, PowerupKind } from '../src/core/types';
import { tickActor, tryTeleport } from '../src/simulation/actors';
import { createBoundary } from '../src/simulation/boundary';
import { grantPowerup, tickPowerups } from '../src/simulation/powerups';
import { heldDiscs, setHeldDiscs } from '../src/simulation/inventory';
import { throwDisc } from '../src/simulation/projectiles';
import { createState, defaultOptions, resetRound } from '../src/simulation/state';
import {
  addZone,
  freezeActor,
  hitDecoy,
  igniteActor,
  tickStatusEffects,
} from '../src/simulation/status-effects';

function scene(powers: PowerupKind[] = []) {
  const state = createState(defaultOptions());
  state.phase = 'playing';
  state.weaponsGranted = true;
  state.arena.obstacles = [];
  state.arena.pits = [];
  state.arena.halfWidth = 30;
  state.arena.halfHeight = 30;
  state.boundary = createBoundary(state.arena);
  const actor = state.actors[0];
  actor.position = v();
  actor.previous = v();
  actor.facing = v(1, 0);
  state.actors[1].position = v(20, 0);
  setHeldDiscs(actor, 1);
  for (const power of powers) grantPowerup(state, actor, power);
  state.events = [];
  const step = (command: Partial<Command> = {}, frames = 1) => {
    for (let i = 0; i < frames; i++) {
      tickActor(state, actor, { ...idleCommand(), ...command }, RULES.dt);
      tickStatusEffects(state, RULES.dt);
    }
  };
  return { state, actor, step };
}

describe('persistent power slots and temporary rewards', () => {
  it('retains acquisition order, replaces fire/ice, and keeps negative/instant effects outside FIFO', () => {
    const { state, actor } = scene(['shield', 'fire', 'multi']);
    grantPowerup(state, actor, 'ice');
    expect(actor.powers).toEqual(['shield', 'multi', 'ice']);
    grantPowerup(state, actor, 'reverse');
    grantPowerup(state, actor, 'shrink');
    expect(actor.powers).toEqual(['shield', 'multi', 'ice']);
    expect(actor.reverseTime).toBe(6);
    expect(state.boundary.ownerId).toBe(actor.id);
    grantPowerup(state, actor, 'haste');
    expect(actor.powers).toEqual(['multi', 'ice', 'haste']);
    expect(actor.shield).toBe(false);
  });

  it('does not duplicate ammo when extra is collected again, or leave held ammo after its FIFO eviction', () => {
    const { state, actor } = scene(['extra', 'haste', 'multi']);
    expect(heldDiscs(actor)).toBe(2);
    throwDisc(state, actor);
    expect(heldDiscs(actor)).toBe(1);
    grantPowerup(state, actor, 'extra');
    expect(heldDiscs(actor)).toBe(1);
    grantPowerup(state, actor, 'fire');
    expect(actor.powers).not.toContain('extra');
    expect(heldDiscs(actor)).toBe(0);
    expect(state.discs.filter((disc) => !disc.dead)).toHaveLength(1);
  });

  it('keeps persistent powers between rounds while clearing temporary status and decoy availability', () => {
    const { state, actor, step } = scene(['haste', 'decoy']);
    grantPowerup(state, actor, 'reverse');
    step({ dash: true });
    expect(actor.decoyCreated).toBe(true);
    state.round++;
    resetRound(state);
    expect(actor.powers).toEqual(['haste', 'decoy']);
    expect(actor.reverseTime).toBe(0);
    expect(actor.decoyCreated).toBe(false);
    expect(actor.armed).toBe(false);
    expect(state.decoys).toHaveLength(0);
  });

  it('honors an empty pickup pool and the reverse-only custom pool', () => {
    const { state } = scene();
    state.options.powerupPool = [];
    state.pickupTimer = 0;
    tickPowerups(state, new Random(1), RULES.dt);
    expect(state.pickups).toHaveLength(0);
    state.options.powerupPool = ['reverse'];
    state.pickupTimer = 0;
    tickPowerups(state, new Random(1), RULES.dt);
    expect(state.pickups[0].kind).toBe('reverse');
  });

  it('only permits the negative override after a prior positive collection', () => {
    const { state, actor } = scene();
    state.pickupTimer = 100;
    const random = new Random(1);
    random.next = () => 0;
    const collect = (kind: PowerupKind) => {
      state.pickups = [{ id: state.nextId++, kind, age: 1, position: v() }];
      tickPowerups(state, random, RULES.dt);
    };
    collect('fire');
    expect(actor.powers).toContain('fire');
    expect(actor.reverseTime).toBe(0);
    collect('ice');
    expect(actor.reverseTime).toBe(6);
    expect(actor.powers).toEqual(['fire']);
  });
});

describe('power-aware input and movement', () => {
  it('reverses direction for six seconds without occupying a persistent slot', () => {
    const { state, actor, step } = scene();
    grantPowerup(state, actor, 'reverse');
    step({ move: v(1, 0) });
    expect(actor.position.x).toBeLessThan(0);
    expect(actor.powers).toHaveLength(0);
    step({}, 359);
    expect(actor.reverseTime).toBe(0);
    actor.velocity = v();
    step({ move: v(1, 0) });
    expect(actor.velocity.x).toBeGreaterThan(0);
  });

  it('crosses a wall while dashing, extends an embedded dash, and restores ordinary wall collision', () => {
    const { state, actor, step } = scene(['wallDash']);
    state.arena.obstacles = [
      { id: 'wall', position: v(4, 0), half: v(2, 5), kind: 'stone', broken: false },
    ];
    step({ dash: true, move: v(1, 0) });
    step({}, 11);
    expect(actor.position.x).toBeGreaterThan(2);
    expect(actor.position.x).toBeLessThan(6);
    expect(actor.dashTime).toBeGreaterThan(0);
    step({}, 40);
    expect(actor.position.x).toBeGreaterThan(6);
    expect(actor.phaseOrigin).toBeUndefined();
    step({ move: v(-1, 0) }, 120);
    expect(actor.position.x).toBeGreaterThan(6.4);
  });

  it('teleports while holding a second disc and during ordinary dash cooldown, without detonating the grenade', () => {
    const { state, actor, step } = scene(['teleport', 'extra', 'explosive']);
    throwDisc(state, actor);
    state.discs[0].position = v(8, 0);
    actor.dashCooldown = 0.4;
    state.actors[1].position = v(8, 0);
    state.actors[1].powers = ['shield'];
    state.actors[1].shield = true;
    state.actors[1].dashTime = 0.2;
    state.actors[1].invulnerable = 1;
    expect(actor.armed).toBe(true);
    step({ dash: true });
    expect(actor.position.x).toBeCloseTo(8);
    expect(state.actors[1].alive).toBe(false);
    expect(state.actors[1].death?.cause).toBe('telefrag');
    expect(state.events.some((event) => event.type === 'teleport')).toBe(true);
    expect(state.events.some((event) => event.type === 'explosion')).toBe(false);
  });

  it('rejects a teleport target inside water or a wall', () => {
    const { state, actor } = scene(['teleport']);
    throwDisc(state, actor);
    state.discs[0].position = v(8, 0);
    state.arena.pits = [{ position: v(8, 0), half: v(2, 2) }];
    expect(tryTeleport(state, actor)).toBe(false);
    state.arena.pits = [];
    state.arena.obstacles = [
      { id: 'wall', position: v(8, 0), half: v(2, 2), kind: 'stone', broken: false },
    ];
    expect(tryTeleport(state, actor)).toBe(false);
    expect(actor.position).toEqual(v());
  });

  it('automatically disguises after idle time and reveals on aim or movement', () => {
    const { actor, step } = scene(['disguise']);
    step({}, 12);
    expect(actor.disguised).toBe(true);
    step({ throwHeld: true });
    expect(actor.disguised).toBe(false);
    step({}, 12);
    expect(actor.disguised).toBe(true);
    step({ move: v(1, 0) }, 20);
    expect(actor.disguised).toBe(false);
  });

  it('holds a controlled disc with movement input, without simultaneously charging another throw', () => {
    const { state, actor, step } = scene(['controlled']);
    throwDisc(state, actor);
    step({ throwHeld: true, move: v(0, 1) });
    expect(actor.controlling).toBe(true);
    expect(actor.controlDirection).toEqual(v(0, 1));
    expect(actor.charge).toBe(0);
    step();
    expect(actor.controlling).toBe(false);
  });
});

describe('elemental hazards and decoys', () => {
  it('caps live zones at the visible surface capacity and retires the oldest zone first', () => {
    const { state } = scene();
    state.zones = Array.from({ length: RULES.maxHazardZones }, (_, index) => ({
      id: index + 1,
      kind: 'ice' as const,
      position: v((index % 64) * 0.4 - 12.8, Math.floor(index / 64) * 0.4 - 12.8),
      ownerId: 0,
      radius: 0.2,
      remaining: 4,
      duration: 4,
    }));
    state.nextId = RULES.maxHazardZones + 1;
    addZone(state, 'fire', v(20, 20), 1);
    expect(state.zones).toHaveLength(RULES.maxHazardZones);
    expect(state.zones[0].id).toBe(2);
    expect(state.zones.at(-1)?.kind).toBe('fire');
    expect(state.zones.at(-1)?.position).toEqual(v(20, 20));
  });

  it('fire is dangerous to its owner, burns after 2.5 seconds, and a shield prevents ignition once', () => {
    const burning = scene(['fire']);
    igniteActor(burning.state, burning.actor, burning.actor.id);
    expect(burning.actor.burnTime).toBe(2.5);
    burning.step({}, 151);
    expect(burning.actor.alive).toBe(false);
    const shielded = scene(['shield']);
    igniteActor(shielded.state, shielded.actor, 1);
    expect(shielded.actor.shield).toBe(false);
    expect(shielded.actor.burnTime).toBe(0);
    expect(shielded.actor.alive).toBe(true);
  });

  it('ice extinguishes fire and replaces fire cells instead of combining two incompatible trails', () => {
    const { state, actor, step } = scene();
    igniteActor(state, actor, 1);
    addZone(state, 'fire', v(), 1);
    addZone(state, 'ice', v(), 1);
    addZone(state, 'fire', v(), 1);
    expect(state.zones).toHaveLength(1);
    expect(state.zones[0].kind).toBe('ice');
    step();
    expect(actor.burnTime).toBe(0);
  });

  it('freezes on foreign ice after half a second, while own ice accumulates five times slower', () => {
    const foreign = scene();
    addZone(foreign.state, 'ice', v(), 1, 1, 4);
    foreign.step({}, 30);
    expect(foreign.actor.frozenTime).toBe(7);
    const own = scene(['ice']);
    addZone(own.state, 'ice', v(), own.actor.id, 1, 4);
    own.step({}, 30);
    expect(own.actor.frozenTime).toBe(0);
    own.step({}, 120);
    expect(own.actor.frozenTime).toBe(7);
  });

  it('frozen actors cannot move or attack, but repeated fresh actions chip ice at a 0.2 second limit', () => {
    const { state, actor, step } = scene();
    freezeActor(state, actor, 1);
    step({ attack: true, dash: true, move: v(1, 0) });
    expect(actor.position).toEqual(v());
    expect(actor.attackTime).toBe(0);
    expect(actor.frozenTime).toBeCloseTo(7 - 7 / 12 - RULES.dt);
    const afterChip = actor.frozenTime!;
    step({ attack: true }, 6);
    expect(actor.frozenTime).toBeCloseTo(afterChip - 6 * RULES.dt);
    step({ attack: true }, 7);
    expect(actor.frozenTime).toBeLessThan(afterChip - 13 * RULES.dt - 0.5);
  });

  it('a shield blocks an ice blast but sustained ice-floor contact freezes and removes the shield', () => {
    const blast = scene(['shield']);
    freezeActor(blast.state, blast.actor, 1);
    expect(blast.actor.frozenTime).toBe(0);
    expect(blast.actor.shield).toBe(false);
    const floor = scene(['shield']);
    addZone(floor.state, 'ice', v(), 1, 1, 4);
    floor.step({}, 30);
    expect(floor.actor.frozenTime).toBe(7);
    expect(floor.actor.shield).toBe(false);
  });

  it('creates one noncombat decoy on the first successful dash and disappearing grants no score or attack', () => {
    const { state, actor, step } = scene(['decoy', 'explosive', 'fire']);
    expect(state.decoys).toHaveLength(0);
    step({ dash: true });
    expect(state.decoys).toHaveLength(1);
    const decoy = state.decoys[0];
    decoy.dashTime = 0;
    hitDecoy(state, decoy, 1);
    expect(state.actors[1].kills).toBe(0);
    expect(state.events.some((event) => event.type === 'explosion')).toBe(false);
    step({}, 40);
    step({ dash: true });
    expect(state.decoys).toHaveLength(0);
    expect(actor.decoyCreated).toBe(true);
  });
});
