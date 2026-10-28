import { lineOfSight, moveAndSlide, onGround, safePosition } from '../core/collision';
import { RULES } from '../core/config';
import { add, distance, mul, normalize, rotate, v } from '../core/math';
import type { Vec2 } from '../core/math';
import type { Actor, DecoyState, GameState, HazardZone } from '../core/types';
import { isInBoundary } from './boundary';
import { damageActor } from './combat';

export function breakDisguise(actor: Actor): void {
  actor.disguised = false;
  actor.disguiseTime = 0;
}

/** Deterministic cells: all clocks and ownership stay in the SDK snapshot. */
export function addZone(
  state: GameState,
  kind: HazardZone['kind'],
  position: Vec2,
  ownerId: number,
  radius = 0.42,
  duration = kind === 'fire' ? 1.25 : 4,
): void {
  if (!onGround(state.arena, position)) return;
  const matching = state.zones.find(
    (zone) => distance(zone.position, position) < Math.min(radius, zone.radius) * 0.5,
  );
  if (matching) {
    // Ice replaces fire. A new fire trail does not erase an existing ice cell.
    if (matching.kind === 'ice' && kind === 'fire') return;
    matching.kind = kind;
    matching.ownerId = ownerId;
    matching.remaining = Math.max(matching.remaining, duration);
    matching.duration = Math.max(matching.duration, duration);
    matching.radius = Math.max(matching.radius, radius);
    return;
  }
  // Keep every live hazard representable by the renderer's matching instance capacity.
  while (state.zones.length >= RULES.maxHazardZones) state.zones.shift();
  state.zones.push({
    id: state.nextId++,
    kind,
    position: { ...position },
    ownerId,
    radius,
    remaining: duration,
    duration,
  });
}

export function igniteActor(state: GameState, actor: Actor, sourceId: number): void {
  if (
    !actor.alive ||
    actor.fall ||
    actor.wetFloor ||
    actor.dashTime > 0 ||
    actor.invulnerable > 0 ||
    (actor.iceExposure ?? 0) > 0 ||
    (actor.frozenTime ?? 0) > 0 ||
    (actor.burnTime ?? 0) > 0
  )
    return;
  if (actor.shield) {
    damageActor(state, actor, sourceId, v());
    return;
  }
  actor.burnTime = 2.5;
  actor.burnDistance = 0;
  actor.burnSourceId = sourceId;
  breakDisguise(actor);
  state.events.push({
    type: 'burn',
    position: { ...actor.position },
    actorId: actor.id,
    value: sourceId,
  });
}

export function freezeActor(
  state: GameState,
  actor: Actor,
  sourceId: number,
  fromIceFloor = false,
): void {
  if (
    !actor.alive ||
    actor.fall ||
    actor.dashTime > 0 ||
    actor.invulnerable > 0 ||
    (actor.frozenTime ?? 0) > 0
  )
    return;
  if (actor.shield && !fromIceFloor) {
    damageActor(state, actor, sourceId, v());
    return;
  }
  if (actor.shield) {
    actor.shield = false;
    actor.powers = actor.powers.filter((power) => power !== 'shield');
    state.events.push({ type: 'shield', position: { ...actor.position }, actorId: actor.id });
  }
  actor.frozenTime = 7;
  actor.freezeChipCooldown = 0;
  actor.burnTime = 0;
  actor.burnDistance = 0;
  actor.iceExposure = 0;
  actor.slowed = false;
  actor.velocity = v();
  actor.charge = 0;
  actor.recalling = false;
  actor.controlling = false;
  actor.attackTime = 0;
  actor.lungeTime = 0;
  breakDisguise(actor);
  state.events.push({
    type: 'freeze',
    position: { ...actor.position },
    actorId: actor.id,
    value: sourceId,
  });
}

export function spawnDecoy(state: GameState, actor: Actor): void {
  if (!actor.powers.includes('decoy') || actor.decoyCreated) return;
  actor.decoyCreated = true;
  const direction = rotate(actor.facing, Math.PI * (actor.id % 2 ? 0.7 : -0.7));
  state.decoys.push({
    id: state.nextId++,
    ownerId: actor.id,
    position: { ...actor.position },
    previous: { ...actor.position },
    velocity: mul(direction, RULES.dashImpulse),
    facing: direction,
    powers: [...actor.powers],
    alive: true,
    age: 0,
    dashTime: RULES.dashDuration,
  });
  state.events.push({
    type: 'decoy',
    position: { ...actor.position },
    actorId: actor.id,
    value: 1,
  });
}

export function hitDecoy(state: GameState, decoy: DecoyState, sourceId: number): boolean {
  if (!decoy.alive || decoy.dashTime > 0) return false;
  if (decoy.powers.includes('shield')) {
    decoy.powers = decoy.powers.filter((power) => power !== 'shield');
    state.events.push({ type: 'shield', position: { ...decoy.position }, actorId: decoy.ownerId });
    return true;
  }
  decoy.alive = false;
  state.events.push({
    type: 'decoy',
    position: { ...decoy.position },
    actorId: decoy.ownerId,
    value: 0,
    entityId: decoy.id,
  });
  // Disappearing grants no kill and triggers no inherited attack effect.
  void sourceId;
  return true;
}

function tickDecoys(state: GameState, dt: number): void {
  for (const decoy of state.decoys) {
    if (!decoy.alive) continue;
    const owner = state.actors.find((actor) => actor.id === decoy.ownerId);
    decoy.previous = { ...decoy.position };
    decoy.age += dt;
    if (
      !owner?.alive ||
      !onGround(state.arena, decoy.position) ||
      !isInBoundary(state.boundary, decoy.position)
    ) {
      decoy.dashTime = 0;
      decoy.powers = decoy.powers.filter((power) => power !== 'shield');
      hitDecoy(state, decoy, owner?.id ?? -1);
      continue;
    }
    // DecoyInput exposes movement/dash only. Steering is derived from snapshot state.
    const wanted = rotate(decoy.facing, Math.sin(decoy.age * 1.7 + decoy.id) * dt * 1.8);
    if (!safePosition(state.arena, add(decoy.position, mul(wanted, 1.1)), RULES.playerRadius))
      decoy.facing = rotate(decoy.facing, Math.PI * 0.72);
    else decoy.facing = wanted;
    const speed = (decoy.powers.includes('haste') ? 1.4 : 1) * 4.8;
    decoy.velocity =
      decoy.dashTime > 0
        ? mul(decoy.velocity, Math.max(0, 1 - RULES.damping * dt))
        : mul(normalize(decoy.facing), speed);
    decoy.position = moveAndSlide(
      state.arena,
      decoy.position,
      mul(decoy.velocity, dt),
      RULES.playerRadius,
    );
    decoy.dashTime = Math.max(0, decoy.dashTime - dt);
    if (decoy.age > 0.4 && decoy.dashTime <= 0) {
      const touching = state.actors.find(
        (actor) =>
          actor.alive &&
          actor.id !== decoy.ownerId &&
          distance(actor.position, decoy.position) < RULES.playerRadius * 1.7,
      );
      if (touching) hitDecoy(state, decoy, touching.id);
      const flame = state.zones.find(
        (zone) => zone.kind === 'fire' && distance(zone.position, decoy.position) < zone.radius,
      );
      if (flame) hitDecoy(state, decoy, flame.ownerId);
    }
  }
  state.decoys = state.decoys.filter((decoy) => decoy.alive);
}

export function tickStatusEffects(state: GameState, dt: number): void {
  for (const zone of state.zones) zone.remaining -= dt;
  state.zones = state.zones.filter((zone) => zone.remaining > 0);
  for (const actor of state.actors) {
    if (!actor.alive) continue;
    actor.reverseTime = Math.max(0, (actor.reverseTime ?? 0) - dt - 1e-12);
    actor.frozenTime = Math.max(0, (actor.frozenTime ?? 0) - dt - 1e-12);
    actor.freezeChipCooldown = Math.max(0, (actor.freezeChipCooldown ?? 0) - dt - 1e-12);
    const touching = state.zones.filter(
      (zone) =>
        distance(zone.position, actor.position) < zone.radius + RULES.playerRadius * 0.35 &&
        lineOfSight(state.arena, zone.position, actor.position),
    );
    const ice = touching.find((zone) => zone.kind === 'ice');
    const fire = touching.find((zone) => zone.kind === 'fire');
    if (ice && actor.dashTime <= 0 && actor.invulnerable <= 0 && (actor.frozenTime ?? 0) <= 0) {
      actor.burnTime = 0;
      actor.burnDistance = 0;
      actor.iceExposure = (actor.iceExposure ?? 0) + dt * (ice.ownerId === actor.id ? 0.2 : 1);
      if (actor.iceExposure >= 0.5 - 1e-10) {
        freezeActor(state, actor, ice.ownerId, true);
        ice.remaining = 0;
      }
    } else actor.iceExposure = Math.max(0, (actor.iceExposure ?? 0) - dt * 0.5);
    actor.slowed = (actor.iceExposure ?? 0) > 0.1;
    if (fire) {
      if (actor.dashTime > 0 || actor.invulnerable > 0 || actor.wetFloor) fire.remaining = 0;
      else {
        igniteActor(state, actor, fire.ownerId);
        if (actor.invulnerable > 0) fire.remaining = 0;
      }
    }
    if ((actor.burnTime ?? 0) > 0) {
      actor.burnTime = Math.max(0, actor.burnTime! - dt);
      actor.burnDistance = (actor.burnDistance ?? 0) + distance(actor.previous, actor.position);
      if (
        actor.fall ||
        actor.shield ||
        actor.wetFloor ||
        actor.burnDistance >= (11.06 * RULES.worldScale) / 0.24
      ) {
        actor.burnTime = 0;
        actor.burnDistance = 0;
      } else if (actor.burnTime <= 0) {
        damageActor(state, actor, actor.burnSourceId ?? actor.id, actor.facing, 'fire');
      } else if (distance(actor.previous, actor.position) > 0.04)
        addZone(state, 'fire', actor.position, actor.id, 0.3, 0.66);
    }
  }
  tickDecoys(state, dt);
}
