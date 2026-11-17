import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { introDuration, PRESENTATION, ROUND_END_DURATION } from '../src/core/presentation';
import { idleCommand } from '../src/core/types';
import { v } from '../src/core/math';
import { Game } from '../src/simulation/game';
import { defaultOptions } from '../src/simulation/state';

describe('authoritative presentation and map flow', () => {
  it('locks controls for the whole entrance and grants weapons 1.2 seconds after Go', () => {
    const game = new Game({ ...defaultOptions(), mode: 'local', bots: 0 });
    const positions = game.state.actors.map((a) => ({ ...a.position }));
    const command = { ...idleCommand(), move: v(1, 0), dash: true, attack: true, throwHeld: true };
    for (let i = 0; i < Math.round(introDuration(2) / RULES.dt); i++) {
      expect(game.state.phase).toBe('countdown');
      game.step(new Map([[0, command]]));
      expect(game.state.actors.map((a) => a.position)).toEqual(positions);
    }
    expect(game.state.phase).toBe('playing');
    expect(game.state.actors.every((a) => !a.armed)).toBe(true);
    for (let i = 0; i < Math.round(PRESENTATION.equipDelay / RULES.dt) - 1; i++) game.step();
    expect(game.state.weaponsGranted).toBe(false);
    game.step();
    expect(game.state.weaponsGranted).toBe(true);
    expect(game.state.actors.every((a) => a.armed)).toBe(true);
  });

  it('a melee kill scores at once, slows time for the confirmation and rotates under cover', () => {
    const game = new Game({ ...defaultOptions(), mode: 'local', bots: 0, mapRotation: 'cycle' });
    const state = game.state;
    state.phase = 'playing';
    state.weaponsGranted = true;
    state.arena.obstacles = [];
    state.arena.pits = [];
    const [a, b] = state.actors;
    a.armed = b.armed = true;
    a.position = a.previous = v(-2, 0);
    b.position = b.previous = v(-0.5, 0);
    a.facing = v(1, 0);
    // PlayerInput starts the swing; the next FixedUpdate's trigger phase cuts.
    game.step(new Map([[0, { ...idleCommand(), attack: true }]]));
    game.step();
    expect(b.alive).toBe(false);
    expect(a.score).toBe(1);
    expect(state.phase).toBe('playing');
    // CombatWorld.Kill → TimeKeeper.SlowMoEffect(.5, .5): no freeze, an eased slowdown.
    expect(state.hitStop).toBe(0);
    const time = state.time;
    for (let i = 0; i < 30; i++) game.step();
    expect(state.time - time).toBeLessThan(30 * RULES.dt * 0.75);
    expect(state.clock?.timeScale).toBeLessThan(0.5);
    let frames = 0;
    while (state.phase === 'playing' && frames++ < 600) game.step();
    expect(a.score).toBe(1);
    expect(state.phase).toBe('roundEnd');
    expect(state.phaseTime).toBe(0);
    expect(state.arena.id).toBe('courtyard');
    for (let i = 0; i < Math.round(ROUND_END_DURATION / RULES.dt) - 1; i++) game.step();
    expect(state.arena.id).toBe('courtyard');
    game.step();
    expect(state.arena.id).toBe('canal');
    expect(state.phase).toBe('countdown');
    expect(state.round).toBe(2);
    expect(a.score).toBe(1);
    expect(state.discs).toEqual([]);
    expect(state.weaponsGranted).toBe(false);
  });
});
