import type { Actor, GameState } from './types';

/** Shared copy for the full application and the embeddable SDK HUD. */
export function eliminationLabel(actor: Actor): string {
  if (actor.alive)
    return actor.fall
      ? actor.fall.elapsed <= 0.33 && (actor.fallsSaved ?? 0) === 0 && actor.dashCooldown <= 0
        ? '下落中 · 冲刺自救'
        : '正在下落'
      : '';
  if (actor.death?.cause === 'fire') return '火焰出局';
  if (actor.death?.cause === 'telefrag') return '被传送撞击';
  switch (actor.death?.variant) {
    case 'slice':
      return '被切片';
    case 'squash':
      return '爆炸出局';
    case 'water':
      return '落水出局';
    case 'cliff':
      return '坠落出局';
    case 'burst':
      return '界外出局';
    default:
      return '已出局';
  }
}

export function boundaryNotice(state: GameState): string {
  if (state.phase !== 'playing') return '';
  const outside = state.actors.filter((actor) => actor.alive && actor.outOfBounds);
  if (outside.length) return '界外倒计时 · 沿箭头返回安全区';
  if (state.boundary.phase === 'shrinking') return '决胜缩圈 · 前往箭头指向的场地';
  if (state.boundary.phase === 'settled') return '决胜时刻 · 留在边界内';
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
      Math.sin(
        1.5 * Math.PI +
          Math.max(0, elapsed - grace.duration * 0.2) * (3 + intensity * intensity * 17),
      ) *
        0.5,
  };
}
