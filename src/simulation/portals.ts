import {
  pointInBox,
  safePosition,
  segmentCircle,
  sweepBox,
  traceObstacles,
} from '../core/collision';
import { localPoint } from '../core/geometry';
import { RULES } from '../core/config';
import { add, distance, mul, rotate, sub, v } from '../core/math';
import type { Vec2 } from '../core/math';
import type { Arena, Disc, GameState, Portal } from '../core/types';

// The original enables portals after two rendered frames. We use two fixed simulation ticks.
export const PORTAL_COOLDOWN = 2 * RULES.dt;
export interface PortalHit {
  t: number;
  portal: Portal;
  destination: Vec2;
}

export function portalDestination(arena: Arena, portal: Portal, radius: number): Vec2 | null {
  const exit = arena.portals?.find((p) => p.id === portal.exitId);
  if (!exit) return null;
  const destination = add(
    exit.position,
    mul(exit.direction, (exit.thickness ?? exit.radius + 0.08) + radius),
  );
  if (exit.half) return destination;
  return safePosition(arena, destination, radius) ? destination : null;
}

/** Entry requires crossing the boundary. Remaining inside a pad never repeatedly teleports. */
export function tracePortal(
  arena: Arena,
  start: Vec2,
  delta: Vec2,
  radius: number,
  cooldown = 0,
): PortalHit | null {
  if (cooldown > 0) return null;
  let closest: PortalHit | null = null;
  for (const portal of arena.portals ?? []) {
    const p = sub(localPoint(start, portal), portal.triggerOffset ?? v());
    if (
      portal.half
        ? pointInBox(p, v(), portal.half, radius - 0.0001)
        : distance(start, portal.position) < portal.radius + radius - 0.0001
    )
      continue;
    const hit = portal.half
      ? sweepBox(p, rotate(delta, -(portal.angle ?? 0)), radius, v(), portal.half)
      : segmentCircle(start, delta, portal.position, portal.radius + radius);
    if (!hit || (closest && hit.t >= closest.t)) continue;
    const destination = portalDestination(arena, portal, radius);
    if (destination) closest = { t: hit.t, portal, destination };
  }
  return closest;
}

export function teleportDisc(state: GameState, disc: Disc, hit: PortalHit): void {
  disc.position = { ...hit.destination };
  disc.previous = { ...hit.destination };
  disc.portalCooldown = PORTAL_COOLDOWN;
  // Original Projectile.OnTriggerEnter2D preserves velocity and ownership.
  state.events.push({
    type: 'teleport',
    position: { ...hit.portal.position },
    destination: { ...hit.destination },
    actorId: disc.damageOwnerId,
    entityId: disc.id,
    entityType: 'disc',
  });
}

/** Call after actor movement and before melee/separation. Returns IDs whose AI path was invalidated. */
export function tickActorPortals(state: GameState, dt: number): number[] {
  const teleported: number[] = [];
  for (const actor of state.actors) {
    actor.portalCooldown = Math.max(0, (actor.portalCooldown ?? 0) - dt);
    if (!actor.alive || state.phase !== 'playing') continue;
    const delta = sub(actor.position, actor.previous);
    const hit = tracePortal(
      state.arena,
      actor.previous,
      delta,
      RULES.playerRadius,
      actor.portalCooldown,
    );
    if (!hit) continue;
    const wall = traceObstacles(state.arena, actor.previous, delta, RULES.playerRadius);
    if (wall && wall.t <= hit.t) continue;
    actor.position = { ...hit.destination };
    actor.previous = { ...hit.destination };
    actor.portalCooldown = PORTAL_COOLDOWN;
    // Facing, dash direction and velocity are preserved, as in Actor.OnTriggerEnter2D.
    state.events.push({
      type: 'teleport',
      position: { ...hit.portal.position },
      destination: { ...hit.destination },
      actorId: actor.id,
      entityId: actor.id,
      entityType: 'actor',
    });
    teleported.push(actor.id);
  }
  return teleported;
}
