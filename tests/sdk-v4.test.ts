import { afterEach, describe, expect, it } from 'vitest';
import { POWERUPS } from '../src/core/config';
import type { MatchOptions, PowerupKind } from '../src/core/types';
import { createSession, type GameSession } from '../src/sdk/index';

const sessions: GameSession[] = [];
function session(options: Partial<MatchOptions> = {}): GameSession {
  const value = createSession({ mode: 'local', bots: 0, seed: 41, ...options });
  sessions.push(value);
  return value;
}
function ready(value: GameSession): void {
  for (let i = 0; i < 600 && !value.getState().weaponsGranted; i++) value.step();
  expect(value.getState().weaponsGranted).toBe(true);
  value.step(2);
}
afterEach(() => {
  for (const value of sessions.splice(0)) value.destroy();
});

describe('SDK V4 options and lifecycle reads', () => {
  it('reads status and tick through pause, restart and destruction without exposing state', () => {
    const value = session();
    expect(value.status).toBe('running');
    expect(value.tick).toBe(0);
    value.step(4);
    expect(value.tick).toBe(4);
    value.pause();
    const paused = value.getState();
    value.step(30);
    expect(value.status).toBe('paused');
    expect(value.tick).toBe(4);
    expect(value.getState()).toEqual(paused);
    value.resume();
    value.step();
    expect(value.tick).toBe(5);
    value.start();
    expect(value.status).toBe('running');
    expect(value.tick).toBe(0);
    value.destroy();
    expect(value.status).toBe('disposed');
    expect(value.tick).toBe(0);
    expect(value.snapshot().status).toBe(value.status);
  });

  it('copies supplied, inherited and returned power arrays across construction and restart', () => {
    const pool: PowerupKind[] = ['shield', 'extra'];
    const powers: PowerupKind[] = ['shield'];
    const value = session({ powerupPool: pool, startingPowers: powers });
    pool[0] = 'fire';
    powers.push('ice');
    expect(value.getState().options.powerupPool).toEqual(['shield', 'extra']);
    expect(value.getState().options.startingPowers).toEqual(['shield']);
    const detached = value.snapshot();
    detached.state.options.powerupPool!.splice(0);
    detached.state.options.startingPowers!.push('reverse');
    value.start({ seed: 52, powerupPool: undefined, startingPowers: undefined });
    expect(value.getState().options.powerupPool).toEqual(['shield', 'extra']);
    expect(value.getState().options.startingPowers).toEqual(['shield']);
    const replacement: PowerupKind[] = ['ice'];
    const empty: PowerupKind[] = [];
    value.start({ powerupPool: replacement, startingPowers: empty });
    replacement.push('fire');
    empty.push('extra');
    expect(value.getState().options.powerupPool).toEqual(['ice']);
    expect(value.getState().options.startingPowers).toEqual([]);
  });

  it('accepts every configured pool member and rejects invalid lists atomically', () => {
    const all = Object.keys(POWERUPS) as PowerupKind[];
    expect(all).toHaveLength(14);
    const value = session({ powerupPool: all, startingPowers: [] });
    const input = value.acquire(0);
    const before = value.snapshot();
    const invalid = [
      { powerupPool: [] },
      { powerupPool: ['shield', 'shield'] },
      { powerupPool: [...all, 'shield'] },
      { powerupPool: ['missing'] },
      { powerupPool: ['constructor'] },
      { powerupPool: ['__proto__'] },
      { powerupPool: 'shield' },
      { powerupPool: null },
      { powerupPool: [null] },
      { powerupPool: [undefined] },
      { powerupPool: new Array(1) },
      { startingPowers: ['shield', 'haste', 'extra', 'fire'] },
      { startingPowers: ['missing'] },
      { startingPowers: null },
      { startingPowers: new Array(1) },
      { startingPowers: false },
    ];
    for (const override of invalid) {
      expect(() => value.start(override as Partial<MatchOptions>)).toThrow();
      expect(() => createSession(override as Partial<MatchOptions>)).toThrow();
      expect(value.snapshot()).toEqual(before);
      expect(input.active).toBe(true);
    }
  });

  it('grants starting powers at actual weapon equip and uses the configured pickup pool', () => {
    const value = session({
      powerupPool: ['shield'],
      startingPowers: ['shield', 'extra', 'reverse'],
    });
    expect(
      value.getState().actors.every((actor) => !actor.armed && actor.powers.length === 0),
    ).toBe(true);
    ready(value);
    for (const actor of value.getState().actors) {
      expect(actor.shield).toBe(true);
      expect(actor.powers).toEqual(['shield', 'extra']);
      expect(actor.heldDiscs).toBe(2);
      expect(actor.reverseTime).toBeGreaterThan(5);
    }
    value.step(300);
    const pickups = value.getState().pickups;
    expect(pickups.length).toBeGreaterThan(0);
    expect(pickups.every((pickup) => pickup.kind === 'shield')).toBe(true);
  });

  it('applies ordered grants, including fire/ice exclusion and repeated starting grants', () => {
    const value = session({ startingPowers: ['fire', 'ice', 'shield'] });
    ready(value);
    expect(value.getState().actors[0].powers).toEqual(['ice', 'shield']);
    value.start({ startingPowers: ['shield', 'shield'] });
    ready(value);
    expect(value.getState().actors[0].powers).toEqual(['shield']);
    expect(value.getState().actors[0].positivePickups).toBe(2);
  });
});

describe('SDK optimized routing preserves callback isolation', () => {
  it('gives later scripts the same pre-routing state even when an earlier script fails', () => {
    const value = session();
    ready(value);
    let fail = false;
    value.useScript(0, () => {
      if (fail) throw new Error('intentional script failure');
      return { throw: true };
    });
    let peerCharge = 0;
    value.useScript(1, ({ state }) => {
      peerCharge = state.actors[0].charge;
      state.actors[0].score = 999;
      state.options.powerupPool = ['reverse'];
      return {};
    });
    value.step(12);
    const before = value.getState().actors[0].charge;
    expect(before).toBeGreaterThan(0);
    fail = true;
    value.step();
    expect(peerCharge).toBe(before);
    const state = value.getState();
    expect(state.actors[0].charge).toBe(0);
    expect(state.actors[0].score).toBe(0);
    expect(state.options.powerupPool).toBeUndefined();
    expect(value.snapshot().controls[0].kind).toBe('idle');
  });
});
