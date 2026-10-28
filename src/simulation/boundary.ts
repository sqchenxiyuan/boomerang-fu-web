import { RULES } from '../core/config';
import { clamp, lerpV, normalize, sub, v } from '../core/math';
import type { Random, Vec2 } from '../core/math';
import type { Actor, Arena, BoundaryState, GameState } from '../core/types';
import { damageActor } from './combat';

// level1 / LevelManager 8970, AnimationCurve at object-relative +840.
// weightedMode=0 on all keys; use the unweighted cubic Hermite tangents.
const SHRINK_KEYS = [
  [0, 0, -0.09615211188793182],
  [0.8998180031776428, 0.9163225889205933, 2.18933367729187],
  [1, 1, 0],
] as const;

export function boundaryCurve(progress: number): number {
  const t = clamp(progress, 0, 1);
  const index = t < SHRINK_KEYS[1][0] ? 0 : 1;
  const a = SHRINK_KEYS[index],
    b = SHRINK_KEYS[index + 1];
  const span = b[0] - a[0],
    u = (t - a[0]) / span;
  const u2 = u * u,
    u3 = u2 * u;
  // Unity Vector2.Lerp clamps the evaluated value, including the negative start tangent.
  return clamp(
    (2 * u3 - 3 * u2 + 1) * a[1] +
      (u3 - 2 * u2 + u) * span * a[2] +
      (-2 * u3 + 3 * u2) * b[1] +
      (u3 - u2) * span * b[2],
    0,
    1,
  );
}

export function createBoundary(arena: Arena): BoundaryState {
  const halfSize = v(arena.halfWidth, arena.halfHeight);
  return {
    phase: 'idle',
    center: v(),
    halfSize,
    startCenter: v(),
    startHalfSize: { ...halfSize },
    targetCenter: v(),
    targetHalfSize: v(RULES.boundaryFinalWidth / 2, RULES.boundaryFinalWidth / 2),
    elapsed: 0,
    duration: 0,
    startedAt: 0,
    progress: 0,
    ownerId: null,
  };
}

/** Original checks the actor origin, with strict rectangle edges, not body overlap. */
export function isInBoundary(boundary: BoundaryState, point: Vec2, inset = 0): boolean {
  return (
    Math.abs(point.x - boundary.center.x) < boundary.halfSize.x - inset &&
    Math.abs(point.y - boundary.center.y) < boundary.halfSize.y - inset
  );
}

export function clampToBoundary(boundary: BoundaryState, point: Vec2, inset = 0): Vec2 {
  const x = Math.max(0, boundary.halfSize.x - inset),
    y = Math.max(0, boundary.halfSize.y - inset);
  return v(
    clamp(point.x, boundary.center.x - x, boundary.center.x + x),
    clamp(point.y, boundary.center.y - y, boundary.center.y + y),
  );
}

export function startShrinkingBoundary(
  state: GameState,
  target: Vec2,
  ownerId: number | null = null,
): void {
  const b = state.boundary,
    half = RULES.boundaryFinalWidth / 2;
  b.phase = 'shrinking';
  b.startCenter = { ...b.center };
  b.startHalfSize = { ...b.halfSize };
  b.targetHalfSize = v(half, half);
  // Clamp to the original map box. No obstacle/water filtering exists in the source.
  b.targetCenter = v(
    clamp(target.x, -state.arena.halfWidth + half, state.arena.halfWidth - half),
    clamp(target.y, -state.arena.halfHeight + half, state.arena.halfHeight - half),
  );
  b.elapsed = 0;
  b.duration = (b.startHalfSize.x * 2) / RULES.boundaryShrinkSpeed;
  b.startedAt = state.time;
  b.progress = 0;
  b.ownerId = ownerId;
  state.events.push({ type: 'boundary', position: { ...b.targetCenter }, actorId: ownerId ?? -1 });
}

export function stopShrinkingBoundary(state: GameState): void {
  if (state.boundary.phase === 'shrinking') state.boundary.phase = 'settled';
}

export function tickBoundary(state: GameState, random: Random, dt: number): void {
  if (state.phase !== 'playing') return;
  const b = state.boundary,
    opponents = state.actors.filter((a) => a.alive).length;
  if (
    !state.suddenDeathStarted &&
    state.roundTime > (state.options.suddenDeathTime ?? RULES.suddenDeathStart) &&
    b.phase !== 'shrinking' &&
    opponents > 1
  ) {
    state.suddenDeathStarted = true;
    startShrinkingBoundary(
      state,
      v(
        random.range(b.center.x - b.halfSize.x, b.center.x + b.halfSize.x),
        random.range(b.center.y - b.halfSize.y, b.center.y + b.halfSize.y),
      ),
    );
  }
  if (b.phase === 'shrinking') {
    if (opponents < 2) stopShrinkingBoundary(state);
    else if (b.elapsed < b.duration) {
      b.elapsed = Math.min(b.duration, b.elapsed + dt);
      b.progress = b.duration > 0 ? b.elapsed / b.duration : 1;
      const t = boundaryCurve(b.progress);
      b.center = lerpV(b.startCenter, b.targetCenter, t);
      b.halfSize = lerpV(b.startHalfSize, b.targetHalfSize, t);
    } else {
      b.center = { ...b.targetCenter };
      b.halfSize = { ...b.targetHalfSize };
      stopShrinkingBoundary(state);
    }
  }
  state.safeRadius = Math.min(b.halfSize.x, b.halfSize.y);
}

export function tickActorBoundary(state: GameState, actor: Actor, dt: number): void {
  if (!actor.alive || state.phase !== 'playing' || isInBoundary(state.boundary, actor.position)) {
    actor.outOfBounds = undefined;
    return;
  }
  if (!actor.outOfBounds) {
    const duration =
      state.boundary.phase === 'shrinking'
        ? RULES.shrinkingOutOfBoundsDuration
        : RULES.outOfBoundsDuration;
    actor.outOfBounds = { remaining: duration, duration };
  }
  // Falling pauses a positive timer. Expiration is checked on the next update, as in Player.cs.
  if (actor.outOfBounds.remaining > 0) {
    if (!actor.fall && dt > 0)
      actor.outOfBounds.remaining = Math.max(0, actor.outOfBounds.remaining - dt - 1e-12);
  } else {
    damageActor(
      state,
      actor,
      state.boundary.ownerId ?? actor.id,
      normalize(sub(state.boundary.center, actor.position)),
      'boundary',
    );
  }
}
