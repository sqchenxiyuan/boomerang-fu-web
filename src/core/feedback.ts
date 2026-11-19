import type { Actor, GameState } from './types';
import { dsin } from './dmath';
import { text } from './i18n';

/** Shared copy for the full application and the embeddable SDK HUD. */
export function eliminationLabel(actor: Actor): string {
  const copy = text();
  if (actor.alive)
    return actor.fall
      ? actor.fall.elapsed <= 0.33 && (actor.fallsSaved ?? 0) === 0 && actor.dashCooldown <= 0
        ? copy.fallingSave
        : copy.falling
      : '';
  if (actor.death?.cause === 'fire') return copy.outFire;
  if (actor.death?.cause === 'telefrag') return copy.outTelefrag;
  if (actor.death?.cause === 'crush') return copy.outCrush;
  switch (actor.death?.variant) {
    case 'slice':
      return copy.outSliced;
    case 'squash':
      return copy.outExplosion;
    case 'water':
      return copy.outWater;
    case 'cliff':
      return copy.outCliff;
    case 'burst':
      return copy.outBoundary;
    default:
      return copy.out;
  }
}

export function boundaryNotice(state: GameState): string {
  if (state.phase !== 'playing') return '';
  const outside = state.actors.filter((actor) => actor.alive && actor.outOfBounds);
  if (outside.length) return text().boundaryOutside;
  if (state.boundary.phase === 'shrinking') return text().boundaryShrinking;
  if (state.boundary.phase === 'settled') return text().boundarySettled;
  return '';
}

/** The original warning appears after 20% of the grace period and accelerates. */
export function boundaryWarning(actor: Actor): {
  visible: boolean;
  seconds: number;
  intensity: number;
  pulse: number;
} {
  const grace = actor.outOfBounds;
  if (!actor.alive || !grace) return { visible: false, seconds: 0, intensity: 0, pulse: 0 };
  const elapsed = grace.duration - grace.remaining;
  const intensity = Math.max(0, Math.min(1, elapsed / grace.duration));
  return {
    visible: elapsed >= grace.duration * 0.2,
    seconds: Math.max(0, grace.remaining),
    intensity,
    pulse:
      0.5 +
      dsin(
        1.5 * Math.PI +
          Math.max(0, elapsed - grace.duration * 0.2) * (3 + intensity * intensity * 17),
      ) *
        0.5,
  };
}
