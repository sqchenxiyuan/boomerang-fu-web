import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { v } from '../src/core/math';
import { idleCommand } from '../src/core/types';
import { createState, defaultOptions } from '../src/simulation/state';
import { damageActor, explode, resolveMelee } from '../src/simulation/combat';
import { throwDisc, tickDiscs } from '../src/simulation/projectiles';
import { tickActor } from '../src/simulation/actors';
import { grantPowerup } from '../src/simulation/powerups';

function fixture() {
  const state = createState(defaultOptions());
  state.phase = 'playing';
  state.weaponsGranted = true;
  state.actors.forEach((actor) => {
    actor.armed = true;
  });
  state.arena.obstacles = [];
  state.arena.pits = [];
  state.actors[0].position = v(-4, 0);
  state.actors[0].previous = v(-4, 0);
  state.actors[0].facing = v(1, 0);
  state.actors[1].position = v(4, 0);
  state.actors[1].previous = v(4, 0);
  state.actors[1].facing = v(-1, 0);
  return state;
}

describe('damage and actions', () => {
  it('haste changes movement and dash recovery, while duplicate pickups do not add slots', () => {
    const normal = fixture(),
      fast = fixture();
    grantPowerup(fast, fast.actors[0], 'haste');
    grantPowerup(fast, fast.actors[0], 'haste');
    expect(fast.actors[0].powers).toEqual(['haste']);
    const command = idleCommand();
    command.move = v(1, 0);
    for (let i = 0; i < 60; i++) {
      tickActor(normal, normal.actors[0], command, RULES.dt);
      tickActor(fast, fast.actors[0], command, RULES.dt);
    }
    expect(fast.actors[0].position.x - normal.actors[0].position.x).toBeGreaterThan(0.8);
    command.dash = true;
    tickActor(normal, normal.actors[0], command, RULES.dt);
    tickActor(fast, fast.actors[0], command, RULES.dt);
    expect(fast.actors[0].dashCooldown).toBeLessThan(normal.actors[0].dashCooldown);
  });
  it('normal hits kill, dash ignores a hit, shield absorbs exactly one hit', () => {
    const state = fixture(),
      target = state.actors[1];
    target.dashTime = 0.2;
    expect(damageActor(state, target, 0, v(1, 0))).toBe('ignored');
    target.dashTime = 0;
    grantPowerup(state, target, 'shield');
    expect(damageActor(state, target, 0, v(1, 0))).toBe('shield');
    expect(target.alive).toBe(true);
    expect(target.shield).toBe(false);
    expect(damageActor(state, target, 0, v(1, 0))).toBe('ignored');
    target.invulnerable = 0;
    expect(damageActor(state, target, 0, v(1, 0))).toBe('killed');
    expect(state.actors[0].kills).toBe(1);
  });
  it('falling defeats a shield instead of consuming it to stand on water', () => {
    const state = fixture();
    state.actors[0].shield = true;
    damageActor(state, state.actors[0], 0, v(), 'fall');
    expect(state.actors[0].alive).toBe(false);
  });
  it('held throw charges; release consumes one weapon and cannot duplicate it', () => {
    const state = fixture(),
      actor = state.actors[0];
    const command = idleCommand();
    command.throwHeld = true;
    for (let i = 0; i < 30; i++) tickActor(state, actor, command, RULES.dt);
    expect(actor.charge).toBeCloseTo(0.5);
    expect(state.discs).toHaveLength(0);
    command.throwHeld = false;
    command.throwReleased = true;
    tickActor(state, actor, command, RULES.dt);
    expect(state.discs).toHaveLength(1);
    expect(actor.armed).toBe(false);
    expect(state.discs[0].charge).toBeCloseTo(1 - Math.cos((Math.PI / 2) * (0.4 / 0.9)), 6);
    expect(throwDisc(state, actor)).toBe(false);
    expect(state.discs).toHaveLength(1);
  });
  it('empty-handed melee disarms instead of dealing lethal weapon damage', () => {
    const state = fixture(),
      actor = state.actors[0],
      target = state.actors[1];
    target.position = v(-2.8, 0);
    target.facing = v(1, 0);
    actor.armed = false;
    actor.attackArmed = false;
    actor.attackTime = 0.2;
    resolveMelee(state);
    expect(target.alive).toBe(true);
    expect(target.armed).toBe(false);
    expect(state.discs[0].state).toBe('dropped');
  });
  it('an explosion respects cover and can hit its owner', () => {
    const state = fixture();
    state.actors[0].position = v(-0.7, 0);
    state.actors[1].position = v(1.5, 0);
    state.arena.obstacles = [
      { id: 'cover', kind: 'stone', position: v(0.7, 0), half: v(0.2, 2), broken: false },
    ];
    explode(state, v(), 0);
    expect(state.actors[0].alive).toBe(false);
    expect(state.actors[1].alive).toBe(true);
  });
});

describe('weapon flight lifecycle', () => {
  it('hits a target continuously at very high speed', () => {
    const state = fixture();
    throwDisc(state, state.actors[0]);
    state.discs[0].velocity = v(900, 0);
    tickDiscs(state, RULES.dt);
    expect(state.actors[1].alive).toBe(false);
  });
  it('a wall is resolved before a target behind it', () => {
    const state = fixture();
    state.arena.obstacles = [
      { id: 'cover', kind: 'stone', position: v(), half: v(0.3, 2), broken: false },
    ];
    throwDisc(state, state.actors[0]);
    state.discs[0].velocity = v(900, 0);
    tickDiscs(state, RULES.dt);
    expect(state.actors[1].alive).toBe(true);
    expect(state.discs[0].bounces).toBeGreaterThan(0);
    expect(state.discs[0].position.x).toBeLessThan(0);
  });
  it('front melee deflects a disc, changes attribution and preserves one weapon', () => {
    const state = fixture(),
      defender = state.actors[1];
    defender.position = v(-1, 0);
    defender.attackTime = 0.2;
    defender.attackArmed = true;
    throwDisc(state, state.actors[0]);
    for (let i = 0; i < 8; i++) tickDiscs(state, RULES.dt);
    expect(defender.alive).toBe(true);
    expect(state.discs).toHaveLength(1);
    expect(state.discs[0].damageOwnerId).toBe(1);
    expect(state.discs[0].ownerId).toBe(0);
    expect(state.events.some((e) => e.type === 'deflect')).toBe(true);
  });
  it('normal flight returns, catches and restores the original inventory', () => {
    const state = fixture();
    state.actors[1].position = v(0, 7);
    throwDisc(state, state.actors[0]);
    for (let i = 0; i < 240; i++) tickDiscs(state, RULES.dt);
    expect(state.discs).toHaveLength(0);
    expect(state.actors[0].armed).toBe(true);
    expect(state.events.some((e) => e.type === 'catch')).toBe(true);
  });
  it('recalls a dropped disc with the same held input', () => {
    const state = fixture();
    state.actors[1].position = v(0, 7);
    throwDisc(state, state.actors[0]);
    state.discs[0].position = v(0, 0);
    state.discs[0].state = 'dropped';
    state.discs[0].age = 1;
    state.actors[0].recalling = true;
    for (let i = 0; i < 90; i++) tickDiscs(state, RULES.dt);
    expect(state.discs).toHaveLength(0);
    expect(state.actors[0].armed).toBe(true);
  });
  it('releasing recall after a catch does not immediately throw the weapon again', () => {
    const state = fixture(),
      actor = state.actors[0];
    state.actors[1].position = v(0, 7);
    throwDisc(state, actor);
    state.discs[0].position = v(-3, 0);
    state.discs[0].state = 'dropped';
    state.discs[0].age = 1;
    const command = idleCommand();
    command.throwHeld = true;
    for (let i = 0; i < 90; i++) {
      tickActor(state, actor, command, RULES.dt);
      tickDiscs(state, RULES.dt);
    }
    expect(actor.armed).toBe(true);
    expect(actor.charge).toBe(0);
    expect(state.discs).toHaveLength(0);
    command.throwHeld = false;
    command.throwReleased = true;
    tickActor(state, actor, command, RULES.dt);
    expect(actor.armed).toBe(true);
    expect(state.discs).toHaveLength(0);
    command.throwHeld = true;
    command.throwReleased = false;
    tickActor(state, actor, command, RULES.dt);
    command.throwHeld = false;
    command.throwReleased = true;
    tickActor(state, actor, command, RULES.dt);
    expect(actor.armed).toBe(false);
    expect(state.discs).toHaveLength(1);
  });
  it('explosive disc detonates once, then restores weapon if its owner survives', () => {
    const state = fixture();
    state.actors[1].position = v(0, 7);
    state.actors[0].powers = ['explosive'];
    throwDisc(state, state.actors[0]);
    for (let i = 0; i < 120; i++) tickDiscs(state, RULES.dt);
    expect(state.events.filter((e) => e.type === 'explosion')).toHaveLength(1);
    expect(state.actors[0].alive).toBe(true);
    expect(state.actors[0].armed).toBe(true);
    expect(state.discs).toHaveLength(0);
  });
});
