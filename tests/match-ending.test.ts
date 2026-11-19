import { describe, expect, it } from 'vitest';
import { Game } from '../src/simulation/game';
import { defaultOptions } from '../src/simulation/state';
import { damageActor } from '../src/simulation/combat';
import { v } from '../src/core/math';
import { ROUND_END_DURATION } from '../src/core/presentation';

/*
 * Simulation 0.10.1: the 14-point match must not end early. A goal met during
 * the round-end delay can be taken back (suicide, a double knock-out, a
 * catch-up to the same score), and a 14:14 tie-breaker is decided by its first
 * kill, at once, as in the source OriginalFfaScore / OriginalFfaRound.
 */

function confirmRound(game: Game): void {
  for (let i = 0; i < 600 && game.state.phase === 'playing'; i++) game.step();
}

function finishRound(game: Game): void {
  for (let i = 0; i < Math.ceil((ROUND_END_DURATION + 0.3) * 60); i++) {
    if (game.state.phase !== 'roundEnd') break;
    game.step();
  }
}

/** One player per score (a human and bots), mid-round, to a 14-point goal. */
function match(scores: number[]): Game {
  const game = new Game({ ...defaultOptions(), bots: scores.length - 1, scoreGoal: 14 });
  game.state.actors.forEach((actor, i) => (actor.score = scores[i] ?? 0));
  game.state.phase = 'playing';
  return game;
}

describe('match ending (simulation 0.10.1)', () => {
  it('takes back a goal when the pending winner kills themselves before the round ends', () => {
    const game = match([13, 5, 0]);
    damageActor(game.state, game.state.actors[1], 0, v(1, 0));
    expect(game.state.actors[0].score).toBe(14);
    expect(game.state.pendingWinnerId).toBe(0);
    // Still inside the round-end delay: a self-inflicted death costs the point back.
    damageActor(game.state, game.state.actors[0], 0, v(1, 0), 'boundary');
    expect(game.state.actors[0].score).toBe(13);
    expect(game.state.pendingWinnerId).toBeUndefined();
    confirmRound(game);
    finishRound(game);
    expect(game.state.phase).toBe('countdown');
    expect(game.state.matchWinnerId).toBeNull();
  });

  it('drops a pending winner who has been caught up with', () => {
    const game = match([13, 13, 0]);
    // Player 1 is already out; their boomerang is still in the air.
    game.state.actors[1].alive = false;
    damageActor(game.state, game.state.actors[2], 0, v(1, 0));
    expect(game.state.pendingWinnerId).toBe(0);
    // The late boomerang takes player 1 to 14 too: nobody holds the goal alone.
    damageActor(game.state, game.state.actors[0], 1, v(1, 0));
    expect(game.state.actors[1].score).toBe(14);
    expect(game.state.pendingWinnerId).toBeUndefined();
    confirmRound(game);
    finishRound(game);
    expect(game.state.matchWinnerId).toBeNull();
    expect(game.state.tieBreaker).toBe(true);
  });

  it('turns 14:14 into a tie-breaker fought only by the leaders, won by its first kill', () => {
    const game = match([13, 13, 3]);
    // Both leaders reach 14 in the same round, so neither holds the goal alone.
    damageActor(game.state, game.state.actors[2], 0, v(1, 0));
    damageActor(game.state, game.state.actors[0], 1, v(1, 0));
    expect(game.state.pendingWinnerId).toBeUndefined();
    confirmRound(game);
    finishRound(game);
    expect(game.state.tieBreaker).toBe(true);
    expect(game.state.phase).toBe('countdown');
    // Only the players tied for the lead take part.
    expect(game.state.actors.map((actor) => actor.alive)).toEqual([true, true, false]);
    game.state.phase = 'playing';
    game.state.events.length = 0;
    damageActor(game.state, game.state.actors[1], 0, v(1, 0));
    expect(game.state.phase).toBe('matchEnd');
    expect(game.state.matchWinnerId).toBe(0);
    expect(game.state.winnerId).toBe(0);
    expect(game.state.actors.map((actor) => actor.score)).toEqual([15, 14, 3]);
    const win = game.state.events.find((event) => event.type === 'win');
    expect(win?.actorId).toBe(0);
    // Damage later in the same tick no longer counts.
    expect(damageActor(game.state, game.state.actors[0], 1, v(1, 0))).toBe('ignored');
    expect(game.state.actors[0].alive).toBe(true);
    expect(game.state.actors[1].score).toBe(14);
    // Stepping does not resume the round.
    game.step();
    expect(game.state.phase).toBe('matchEnd');
  });

  it('ignores damage during the round-end delay', () => {
    const game = match([1, 1]);
    damageActor(game.state, game.state.actors[1], 0, v(1, 0));
    confirmRound(game);
    expect(game.state.phase).toBe('roundEnd');
    expect(damageActor(game.state, game.state.actors[0], 0, v(1, 0), 'boundary')).toBe('ignored');
    expect(game.state.actors[0].score).toBe(2);
  });

  it('clears a stale pending winner when a new round starts', () => {
    const game = match([3, 3]);
    game.state.pendingWinnerId = 1;
    game.state.actors[1].alive = false;
    confirmRound(game);
    finishRound(game);
    expect(game.state.pendingWinnerId).toBeUndefined();
    expect(game.state.matchWinnerId).toBeNull();
  });
});
