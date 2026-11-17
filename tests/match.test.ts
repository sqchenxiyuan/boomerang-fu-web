import { describe, expect, it } from 'vitest';
import { Game } from '../src/simulation/game';
import { defaultOptions } from '../src/simulation/state';
import { damageActor } from '../src/simulation/combat';
import { v } from '../src/core/math';
import { findPath } from '../src/simulation/navigation';
import { createArena } from '../src/core/arena';
import { safePosition } from '../src/core/collision';
import { ROUND_END_DURATION } from '../src/core/presentation';
import { driveBotGame } from './bot-fixture';

/** The 1.45 s confirmation is scaled time; a kill's slow motion stretches it. */
function confirmRound(game: Game): void {
  for (let i = 0; i < 600 && game.state.phase === 'playing'; i++) game.step();
}

function finishRound(game: Game): void {
  for (let i = 0; i < Math.ceil((ROUND_END_DURATION + 0.3) * 60); i++) {
    if (game.state.phase !== 'roundEnd') break;
    game.step();
  }
}

describe('match lifecycle', () => {
  it('kill scoring awards the killer at once and ends an uncontested match at the goal', () => {
    const game = new Game({ ...defaultOptions(), scoreGoal: 2 });
    game.state.phase = 'playing';
    damageActor(game.state, game.state.actors[1], 0, v(1, 0));
    expect(game.state.actors[0].score).toBe(1);
    expect(game.state.clock?.slowMo || game.state.clock?.slowHold).toBeTruthy();
    confirmRound(game);
    expect(game.state.phase).toBe('roundEnd');
    expect(game.state.actors[0].score).toBe(1);
    finishRound(game);
    expect(game.state.phase).toBe('countdown');
    expect(game.state.round).toBe(2);
    expect(game.state.clock?.timeScale).toBe(1);
    game.state.phase = 'playing';
    // A self-inflicted out-of-bounds death is a suicide: −1, floored at zero by round end.
    damageActor(game.state, game.state.actors[1], 1, v(1, 0), 'boundary');
    expect(game.state.actors[1].score).toBe(-1);
    confirmRound(game);
    finishRound(game);
    expect(game.state.actors[1].score).toBe(0);
    expect(game.state.phase).toBe('countdown');
    game.state.phase = 'playing';
    damageActor(game.state, game.state.actors[1], 0, v(1, 0));
    expect(game.state.pendingWinnerId).toBe(0);
    confirmRound(game);
    finishRound(game);
    expect(game.state.phase).toBe('matchEnd');
    expect(game.state.matchWinnerId).toBe(0);
  });
  it('kill scoring defaults to the Medium goal for the player count', () => {
    expect(new Game(defaultOptions()).state.options.scoreGoal).toBe(14);
    expect(new Game({ ...defaultOptions(), bots: 3 }).state.options.scoreGoal).toBe(16);
    expect(new Game({ ...defaultOptions(), scoring: 'survival' }).state.options.scoreGoal).toBe(5);
  });
  it('survival scoring awards the last survivor, preserves score and reaches a result', () => {
    const game = new Game({ ...defaultOptions(), scoring: 'survival', scoreGoal: 2 });
    game.state.phase = 'playing';
    damageActor(game.state, game.state.actors[1], 0, v(1, 0));
    confirmRound(game);
    expect(game.state.phase).toBe('roundEnd');
    expect(game.state.actors[0].score).toBe(1);
    finishRound(game);
    expect(game.state.phase).toBe('countdown');
    expect(game.state.round).toBe(2);
    expect(game.state.actors[0].score).toBe(1);
    expect(game.state.actors.every((a) => a.alive && !a.armed)).toBe(true);
    game.state.phase = 'playing';
    damageActor(game.state, game.state.actors[1], 0, v(1, 0));
    confirmRound(game);
    finishRound(game);
    expect(game.state.phase).toBe('matchEnd');
    expect(game.state.matchWinnerId).toBe(0);
    game.start({ ...defaultOptions(), scoring: 'survival' });
    expect(game.state.actors[0].score).toBe(0);
    expect(game.state.round).toBe(1);
  });
  it('a simultaneous elimination is a draw with no score', () => {
    const game = new Game();
    game.state.phase = 'playing';
    game.state.actors.forEach((a) => damageActor(game.state, a, -1, v(), 'boundary'));
    confirmRound(game);
    expect(game.state.phase).toBe('roundEnd');
    expect(game.state.winnerId).toBeNull();
    finishRound(game);
    expect(game.state.actors.every((a) => a.score === 0)).toBe(true);
  });
  it('navigation finds a traversable path around the center and pools', () => {
    const arena = createArena(),
      path = findPath(arena, v(-6, 0), v(6, 0));
    expect(path.length).toBeGreaterThan(1);
    expect(path.every((p) => safePosition(arena, p, 0.47))).toBe(true);
  });
  it.each([41, 295, 8731])(
    'seed %i completes an autonomous five-point match without invalid state',
    (seed) => {
      const game = new Game({ ...defaultOptions(), seed, scoreGoal: 5 });
      game.state.actors.forEach((a) => {
        a.controller = 'bot';
      });
      const counts: Record<string, number> = {};
      let ticks = 0;
      while (game.state.phase !== 'matchEnd' && ticks < 60 * 420) {
        driveBotGame(game);
        ticks++;
        for (const event of game.drainEvents()) counts[event.type] = (counts[event.type] ?? 0) + 1;
        for (const actor of game.state.actors) {
          if (!Number.isFinite(actor.position.x + actor.position.y))
            throw new Error('Non-finite position');
          const owned = game.state.discs.filter((d) => d.ownerId === actor.id);
          const groups = new Set(owned.map((d) => d.groupId ?? d.id));
          // Player.heldDiscs never exceeds two; public discs can be collected and thrown,
          // but the world never holds more weapons than two per player.
          const weapons =
            new Set(game.state.discs.map((d) => d.groupId ?? d.id)).size +
            game.state.actors.reduce((n, a) => n + (a.armed ? (a.heldDiscs ?? 1) : 0), 0);
          if (
            (actor.armed ? (actor.heldDiscs ?? 1) : 0) > 2 ||
            weapons > 2 * game.state.actors.length
          )
            throw new Error('Duplicated weapon inventory');
          for (const group of groups)
            if (owned.filter((d) => (d.groupId ?? d.id) === group).length > 5)
              throw new Error('Too many fragments in one weapon');
        }
      }
      expect(
        game.state.phase,
        JSON.stringify({ ticks, scores: game.state.actors.map((a) => a.score), counts }),
      ).toBe('matchEnd');
      expect((counts.throw ?? 0) + (counts.slash ?? 0)).toBeGreaterThanOrEqual(5);
      expect(counts.death).toBeGreaterThanOrEqual(5);
      expect(game.state.actors.reduce((total, a) => total + a.kills, 0)).toBeGreaterThan(0);
      console.log(
        JSON.stringify({
          seed,
          seconds: ticks / 60,
          rounds: game.state.round,
          scores: game.state.actors.map((a) => a.score),
          kills: game.state.actors.map((a) => a.kills),
          counts,
        }),
      );
    },
    20000,
  );
  it('four actors finish a match with powerups and a bounded weapon inventory', () => {
    const game = new Game({ ...defaultOptions(), bots: 3, seed: 5526, scoreGoal: 5 });
    game.state.actors.forEach((a) => {
      a.controller = 'bot';
    });
    let ticks = 0;
    const counts: Record<string, number> = {};
    while (game.state.phase !== 'matchEnd' && ticks < 60 * 600) {
      driveBotGame(game);
      ticks++;
      for (const event of game.drainEvents()) counts[event.type] = (counts[event.type] ?? 0) + 1;
      // Four actors, two inventory units each, at most five fragments per unit.
      expect(game.state.discs.length).toBeLessThanOrEqual(40);
    }
    expect(game.state.phase).toBe('matchEnd');
    expect(game.state.actors.some((a) => a.score >= 5)).toBe(true);
    console.log(
      JSON.stringify({
        players: 4,
        seconds: ticks / 60,
        rounds: game.state.round,
        scores: game.state.actors.map((a) => a.score),
        counts,
      }),
    );
  }, 20000);
});
