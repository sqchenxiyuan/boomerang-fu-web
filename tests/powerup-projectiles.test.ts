import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { v } from '../src/core/math';
import { Game } from '../src/simulation/game';
import { createState, defaultOptions, resetRound } from '../src/simulation/state';
import { explode } from '../src/simulation/combat';
import { grantPowerup } from '../src/simulation/powerups';
import { heldDiscs, recoverDisc, setHeldDiscs } from '../src/simulation/inventory';
import { throwDisc, tickDiscs } from '../src/simulation/projectiles';
import type { PowerupKind } from '../src/core/types';

function scene(powers: PowerupKind[] = []) {
  const state = createState(defaultOptions());
  state.phase = 'playing';
  state.weaponsGranted = true;
  state.arena.obstacles = [];
  state.arena.pits = [];
  state.arena.halfWidth = 30;
  state.arena.halfHeight = 30;
  const actor = state.actors[0];
  actor.position = v(-10, 0);
  actor.facing = v(1, 0);
  state.actors[1].position = v(0, 20);
  setHeldDiscs(actor, 1);
  for (const power of powers) grantPowerup(state, actor, power);
  state.events = [];
  return { state, actor };
}

describe('V4 inventory and combined projectile powers', () => {
  it('automatically equips at 1.2 seconds, emitting one cue per actor and using real loadout grants', () => {
    const game = new Game({ ...defaultOptions(), startingPowers: ['extra', 'multi', 'fire'] });
    while (game.state.phase === 'countdown') game.step();
    for (let i = 0; i < 71; i++) game.step();
    expect(game.state.weaponsGranted).toBe(false);
    expect(game.state.actors.every((a) => !a.armed)).toBe(true);
    game.step();
    expect(game.state.actors.map(heldDiscs)).toEqual([2, 2]);
    expect(game.state.events.filter((e) => e.type === 'equip')).toHaveLength(2);
    expect(game.state.actors[0].powers).toEqual(['extra', 'multi', 'fire']);
    game.step();
    expect(game.state.events.filter((e) => e.type === 'equip')).toHaveLength(2);
  });

  it('two independent throws and catches cannot create a third weapon', () => {
    const { state, actor } = scene(['extra']);
    expect(heldDiscs(actor)).toBe(2);
    throwDisc(state, actor);
    actor.attackCooldown = 0;
    throwDisc(state, actor);
    actor.attackCooldown = 0;
    expect(throwDisc(state, actor)).toBe(false);
    expect(state.discs).toHaveLength(2);
    recoverDisc(state, state.discs[1], true);
    expect(heldDiscs(actor)).toBe(1);
    recoverDisc(state, state.discs[0], true);
    recoverDisc(state, state.discs[0], true);
    expect(heldDiscs(actor)).toBe(2);
  });

  it.each([
    [['multi'], 5],
    [['multi', 'fire'], 4],
    [['multi', 'explosive'], 4],
  ] as [PowerupKind[], number][])(
    'splits %j into %i children and only restores one inventory unit',
    (powers, count) => {
      const { state, actor } = scene(powers);
      throwDisc(state, actor);
      for (let i = 0; i < 28; i++) tickDiscs(state, RULES.dt);
      expect(state.discs).toHaveLength(count);
      expect(state.discs.every((d) => d.mini && !d.powers?.includes('multi'))).toBe(true);
      for (const disc of state.discs.slice(0, -1)) recoverDisc(state, disc, true);
      expect(actor.armed).toBe(false);
      recoverDisc(state, state.discs.at(-1)!, true);
      expect(heldDiscs(actor)).toBe(1);
    },
  );

  it('launch powers are snapshots and fire/ice leave actual ground hazards', () => {
    const { state, actor } = scene(['fire']);
    throwDisc(state, actor);
    grantPowerup(state, actor, 'ice');
    for (let i = 0; i < 10; i++) tickDiscs(state, RULES.dt);
    expect(state.discs[0].powers).toContain('fire');
    expect(state.discs[0].powers).not.toContain('ice');
    expect(state.zones.some((z) => z.kind === 'fire')).toBe(true);
    expect(actor.powers).not.toContain('fire');
    expect(actor.powers).toContain('ice');
  });

  it('controlled input steers a flying disc and release permits its return', () => {
    const { state, actor } = scene(['controlled']);
    throwDisc(state, actor);
    actor.controlling = true;
    actor.controlDirection = v(0, 1);
    for (let i = 0; i < 30; i++) tickDiscs(state, RULES.dt);
    expect(state.discs[0].state).toBe('outbound');
    expect(state.discs[0].velocity.y).toBeGreaterThan(16);
    for (let i = 0; i < 90; i++) tickDiscs(state, RULES.dt);
    expect(
      Math.hypot(
        state.discs[0].position.x - actor.position.x,
        state.discs[0].position.y - actor.position.y,
      ),
    ).toBeLessThan(12.5);
    actor.controlling = false;
    actor.recalling = true;
    for (let i = 0; i < 480; i++) tickDiscs(state, RULES.dt);
    expect(state.discs).toHaveLength(0);
    expect(heldDiscs(actor)).toBe(1);
  });

  it('explosive ice keeps its flying trail while explosive fire waits for detonation', () => {
    for (const power of ['ice', 'fire'] as const) {
      const { state, actor } = scene(['explosive', power]);
      throwDisc(state, actor);
      for (let i = 0; i < 10; i++) tickDiscs(state, RULES.dt);
      expect(state.zones.length > 0).toBe(power === 'ice');
    }
  });

  it('ice explosion freezes, fire explosion kills and leaves fire, and cover blocks the blast', () => {
    const { state } = scene();
    const target = state.actors[1];
    target.position = v(2, 0);
    explode(state, v(), 0, ['explosive', 'ice']);
    expect(target.alive).toBe(true);
    expect(target.frozenTime).toBeGreaterThan(0);
    target.frozenTime = 0;
    explode(state, v(), 0, ['explosive', 'fire']);
    expect(target.alive).toBe(false);
    const covered = scene().state;
    covered.actors[1].position = v(2, 0);
    covered.arena.obstacles = [
      { id: 'cover', kind: 'stone', position: v(1, 0), half: v(0.2, 3), broken: false },
    ];
    explode(covered, v(), 0, ['explosive', 'fire']);
    expect(covered.actors[1].alive).toBe(true);
    expect(covered.zones.some((z) => z.kind === 'fire')).toBe(true);
  });

  it('reset preserves persistent slots and clears all transient inventory and hazards', () => {
    const { state, actor } = scene(['extra', 'fire', 'multi']);
    throwDisc(state, actor);
    tickDiscs(state, RULES.dt);
    actor.burnTime = 1;
    actor.reverseTime = 6;
    actor.disguised = true;
    state.round++;
    resetRound(state);
    expect(actor.powers).toEqual(['extra', 'fire', 'multi']);
    expect(heldDiscs(actor)).toBe(0);
    expect(state.discs).toHaveLength(0);
    expect(state.zones).toHaveLength(0);
    expect(state.decoys).toHaveLength(0);
    expect(actor.burnTime).toBe(0);
    expect(actor.reverseTime).toBe(0);
    expect(actor.disguised).toBe(false);
  });
});
