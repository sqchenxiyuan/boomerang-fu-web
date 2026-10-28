import { onGround } from '../core/collision';
import { RULES } from '../core/config';
import { add, clampLength, length, mul, normalize, sub, v } from '../core/math';
import type { Vec2 } from '../core/math';
import type { Actor, Arena, GameState } from '../core/types';
import { damageActor } from './combat';
import { shapeContains, obstacleDistance } from '../core/geometry';

type FallKind = 'water' | 'cliff';
const FALL_DURATION: Record<FallKind, number> = { water: 0.66, cliff: 0.74 };
const RESCUE_WINDOW = 0.33;
const EPSILON = 1e-10;

/** Web arenas designate interior pits as water and the outer edge as a cliff. */
export function hazardKind(arena: Arena, position: Vec2): FallKind | null {
  if (onGround(arena, position)) return null;
  if (arena.floors && hazardContactPoints(arena, position, RULES.playerRadius * 1.15) <= 8)
    return null;
  if (arena.hazard)
    return arena.surfaces?.some(
      (surface) => surface.kind === 'water' && shapeContains(surface, position),
    )
      ? 'water'
      : arena.hazard;
  return Math.abs(position.x) > arena.halfWidth || Math.abs(position.y) > arena.halfHeight
    ? 'cliff'
    : 'water';
}

/** LevelManager.HazardContactPoints: center plus eight support samples, north stretched 1.25x. */
export function hazardContactPoints(
  arena: Arena,
  position: Vec2,
  radius: number,
  includeObstacles = true,
): number {
  let misses = 0;
  const centerMissing = !onGround(arena, position);
  if (centerMissing) misses++;
  for (let i = 0; i < 8; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 4;
    const p = add(
      position,
      v(Math.cos(angle) * radius, Math.sin(angle) * radius * (i === 0 ? 1.25 : 1)),
    );
    if (!onGround(arena, p)) misses++;
    if (
      includeObstacles &&
      centerMissing &&
      arena.obstacles.some((o) => !o.broken && !o.disabled && obstacleDistance(o, p) === 0)
    )
      misses++;
  }
  return misses;
}

/** Original Dash rejects strictly after .33 seconds and permits only one midair rescue. */
export function canRescueFall(actor: Actor): boolean {
  return (
    actor.alive &&
    actor.fall !== undefined &&
    actor.fall.elapsed <= RESCUE_WINDOW + EPSILON &&
    (actor.fallsSaved ?? 0) === 0
  );
}

/** The caller still checks ordinary dash availability and supplies its impulse. */
export function rescueFall(actor: Actor): boolean {
  if (!canRescueFall(actor)) return false;
  actor.fall = undefined;
  actor.fallsSaved = 1;
  return true;
}

/**
 * Call after movement, once per effective simulation tick. Entry starts at elapsed=0;
 * subsequent ticks advance the timer. Game owns pause/hit-stop and the movement clock.
 * Existing velocity drives drift; this module never moves or scores an actor itself.
 */
export function tickFall(state: GameState, actor: Actor, dt: number): void {
  if (!actor.alive) return;
  const kind = hazardKind(state.arena, actor.position);
  if (actor.fall) {
    // Automatic footing recovery is strictly before .33; the dash boundary is inclusive.
    if (kind === null && actor.fall.elapsed < RESCUE_WINDOW && rescueFall(actor)) {
      if (actor.dashTime <= 0) actor.fallsSaved = 0;
      return;
    }
    actor.fall.elapsed = Math.min(actor.fall.duration, actor.fall.elapsed + dt);
    if (actor.fall.elapsed + EPSILON >= actor.fall.duration) {
      actor.fall.elapsed = actor.fall.duration;
      // Combat owns the persistent death record and clears the falling state.
      damageActor(state, actor, actor.id, v(), 'fall');
    }
    return;
  }
  if (kind === null) {
    if (actor.dashTime <= 0) actor.fallsSaved = 0;
    return;
  }
  if (actor.dashTime > 0) return;
  if (state.arena.floors && length(actor.velocity) >= RULES.speedLimit * 0.8) return;

  actor.fall = { kind, elapsed: 0, duration: FALL_DURATION[kind] };
  actor.charge = 0;
  actor.aimMoveLag = 0;
  actor.recalling = false;
  actor.throwBlocked = true;
  actor.facingHistory = [];
  actor.attackTime = 0;
  actor.lungeTime = 0;
  actor.lungeRecovery = 0;
  actor.bufferedAttack = 0;

  // Actor.StartFall's edge impulse/cap, scaled to the Web world. We approximate
  // velocityStored with current velocity; moving-floor transfer is not implemented.
  const direction = normalize(actor.velocity);
  const behind = sub(actor.position, mul(direction, RULES.worldScale));
  const ahead = add(actor.position, mul(direction, RULES.worldScale * 2));
  actor.velocity =
    hazardKind(state.arena, behind) === null && hazardKind(state.arena, ahead) !== null
      ? mul(direction, RULES.speedLimit * 0.6)
      : clampLength(actor.velocity, RULES.speedLimit * 0.33);
}
