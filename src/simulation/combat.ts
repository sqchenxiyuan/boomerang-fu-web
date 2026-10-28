import { lineOfSight, moveAndSlide } from '../core/collision';
import { RULES } from '../core/config';
import { add, distance, dot, mul, normalize, sub, v } from '../core/math';
import type { Vec2 } from '../core/math';
import type {
  Actor,
  DeathCause,
  DeathState,
  GameState,
  Obstacle,
  PowerupKind,
} from '../core/types';
import { heldDiscs, setHeldDiscs } from './inventory';
import { addZone, freezeActor, hitDecoy } from './status-effects';

export function breakCrate(state: GameState, obstacle: Obstacle, actorId: number): void {
  if (obstacle.kind !== 'crate' || obstacle.broken) return;
  obstacle.broken = true;
  state.events.push({ type: 'crate', position: { ...obstacle.position }, actorId });
}

export function damageActor(
  state: GameState,
  actor: Actor,
  sourceId: number,
  direction: Vec2,
  cause: DeathCause = 'weapon',
): 'ignored' | 'shield' | 'killed' {
  if (!actor.alive) return 'ignored';
  const environmental =
    cause === 'fall' || cause === 'boundary' || cause === 'fire' || cause === 'telefrag';
  if (!environmental && (actor.dashTime > 0 || actor.invulnerable > 0)) return 'ignored';
  if (!environmental && actor.shield) {
    actor.shield = false;
    actor.powers = actor.powers.filter((p) => p !== 'shield');
    actor.invulnerable = 0.85;
    actor.velocity = add(actor.velocity, mul(normalize(direction), 5));
    state.events.push({ type: 'shield', position: { ...actor.position }, actorId: actor.id });
    return 'shield';
  }
  actor.alive = false;
  actor.deathTime = state.time;
  const deathDirection = normalize(dot(direction, direction) > 1e-10 ? direction : actor.facing);
  const variant: DeathState['variant'] =
    cause === 'weapon'
      ? 'slice'
      : cause === 'explosion' || cause === 'telefrag'
        ? 'squash'
        : cause === 'boundary' || cause === 'fire'
          ? 'burst'
          : (actor.fall?.kind ??
            (Math.abs(actor.position.x) > state.arena.halfWidth ||
            Math.abs(actor.position.y) > state.arena.halfHeight
              ? 'cliff'
              : 'water'));
  actor.death = {
    cause,
    variant,
    time: state.time,
    position: { ...actor.position },
    direction: deathDirection,
    seed:
      (Math.imul(state.round, 0x9e3779b9) ^
        Math.imul(actor.id + 1, 0x85ebca6b) ^
        Math.round(state.time * 1e6)) >>>
      0,
  };
  actor.fall = undefined;
  actor.outOfBounds = undefined;
  actor.shield = false;
  state.roundFinishTimer = RULES.roundResolveDelay;
  actor.armed = false;
  actor.heldDiscs = 0;
  actor.disguised = false;
  actor.controlling = false;
  actor.burnTime = 0;
  actor.frozenTime = 0;
  actor.reverseTime = 0;
  actor.phaseOrigin = undefined;
  for (const decoy of state.decoys ?? []) if (decoy.ownerId === actor.id) decoy.alive = false;
  actor.charge = 0;
  actor.recalling = false;
  actor.attackTime = 0;
  actor.lungeTime = 0;
  actor.lungeRecovery = 0;
  actor.dashTime = 0;
  actor.velocity = mul(normalize(direction), cause === 'fall' ? 0 : 6);
  const killer = state.actors.find((p) => p.id === sourceId && p.id !== actor.id);
  if (killer) killer.kills++;
  state.events.push({
    type: 'death',
    position: { ...actor.position },
    actorId: actor.id,
    value: sourceId,
    cause,
    direction: { ...deathDirection },
    variant,
  });
  return 'killed';
}

export function facingTarget(actor: Actor, position: Vec2, threshold = 0): boolean {
  return dot(actor.facing, normalize(sub(position, actor.position))) >= threshold;
}

export function resolveMelee(state: GameState): void {
  // Collect all attacks before applying deaths, so simultaneous attacks can trade.
  const hits: Array<{ attacker: Actor; target: Actor; armed: boolean }> = [];
  for (const actor of state.actors) {
    if (!actor.alive || actor.attackTime <= 0) continue;
    for (const decoy of state.decoys ?? []) {
      if (
        decoy.alive &&
        decoy.ownerId !== actor.id &&
        distance(actor.position, decoy.position) < RULES.attackRange + RULES.playerRadius &&
        facingTarget(actor, decoy.position, Math.cos(RULES.attackArc / 2)) &&
        lineOfSight(state.arena, actor.position, decoy.position)
      )
        hitDecoy(state, decoy, actor.id);
    }
    for (const obstacle of state.arena.obstacles) {
      if (
        !obstacle.broken &&
        obstacle.kind === 'crate' &&
        distance(actor.position, obstacle.position) < RULES.attackRange + 0.5 &&
        facingTarget(actor, obstacle.position, 0.2)
      )
        breakCrate(state, obstacle, actor.id);
    }
    for (const target of state.actors) {
      if (!target.alive || target.id === actor.id || actor.hitTargets.includes(target.id)) continue;
      if (
        distance(actor.position, target.position) > RULES.attackRange + RULES.playerRadius ||
        !facingTarget(actor, target.position, Math.cos(RULES.attackArc / 2)) ||
        !lineOfSight(state.arena, actor.position, target.position)
      )
        continue;
      actor.hitTargets.push(target.id);
      hits.push({ attacker: actor, target, armed: actor.attackArmed });
    }
  }
  for (const { attacker, target, armed } of hits) {
    const direction = normalize(sub(target.position, attacker.position));
    if (target.dashTime > 0 || target.invulnerable > 0) continue;
    if (
      target.attackTime > 0 &&
      target.attackArmed &&
      facingTarget(target, attacker.position, 0.1) &&
      armed
    ) {
      target.velocity = add(target.velocity, mul(direction, 5));
      state.events.push({
        type: 'deflect',
        position: mul(add(target.position, attacker.position), 0.5),
        actorId: target.id,
        feedback: 'clash',
      });
    } else if (armed) {
      damageActor(state, target, attacker.id, direction);
    } else {
      target.stun = 0.35;
      target.lungeTime = 0;
      target.velocity = mul(direction, 10);
      if (target.armed) {
        setHeldDiscs(target, heldDiscs(target) - 1);
        state.discs.push({
          id: state.nextId++,
          ownerId: target.id,
          damageOwnerId: target.id,
          position: add(target.position, mul(direction, 0.8)),
          previous: { ...target.position },
          velocity: mul(direction, 5),
          state: 'dropped',
          age: 0,
          stateTime: 0,
          charge: 0,
          curve: 0,
          bounces: 0,
          explosive: false,
          fuse: 0,
          grace: 0.3,
          lastDeflector: -1,
          dead: false,
        });
      }
      state.events.push({
        type: 'deflect',
        position: { ...target.position },
        actorId: attacker.id,
        feedback: 'disarm',
      });
    }
  }
}

export function explode(
  state: GameState,
  position: Vec2,
  sourceId: number,
  powers: readonly PowerupKind[] = [],
  scale = 1,
): void {
  const ice = powers.includes('ice'),
    fire = powers.includes('fire');
  const radius = (ice ? 17 * RULES.worldScale : RULES.explosionRadius) * scale;
  state.events.push({
    type: 'explosion',
    position: { ...position },
    actorId: sourceId,
    value: radius,
    power: ice ? 'ice' : fire ? 'fire' : 'explosive',
  });
  // Obstacles block blast rays; crates touched by this blast break after damage.
  for (const actor of state.actors) {
    if (
      actor.alive &&
      distance(actor.position, position) < radius + RULES.playerRadius &&
      lineOfSight(state.arena, position, actor.position)
    ) {
      if (ice) freezeActor(state, actor, sourceId);
      else damageActor(state, actor, sourceId, sub(actor.position, position), 'explosion');
    }
  }
  for (const decoy of state.decoys ?? [])
    if (
      decoy.alive &&
      distance(decoy.position, position) < radius &&
      lineOfSight(state.arena, position, decoy.position)
    )
      hitDecoy(state, decoy, sourceId);
  // Ground patches also honor cover; avoid one large circle leaking through walls.
  if (ice || fire)
    for (let x = -radius; x <= radius; x += 0.65)
      for (let y = -radius; y <= radius; y += 0.65) {
        if (x * x + y * y > radius * radius) continue;
        const point = add(position, v(x, y));
        if (lineOfSight(state.arena, position, point))
          addZone(state, ice ? 'ice' : 'fire', point, sourceId);
      }
  for (const obstacle of state.arena.obstacles)
    if (!ice && distance(position, obstacle.position) < radius + 0.4)
      breakCrate(state, obstacle, sourceId);
}

export function separateActors(state: GameState): void {
  for (let i = 0; i < state.actors.length; i++)
    for (let j = i + 1; j < state.actors.length; j++) {
      const a = state.actors[i],
        b = state.actors[j];
      if (!a.alive || !b.alive) continue;
      if ((a.phaseOrigin && a.dashTime > 0) || (b.phaseOrigin && b.dashTime > 0)) continue;
      const diff = sub(b.position, a.position),
        d = distance(a.position, b.position);
      if (d < RULES.playerRadius * 2) {
        const push = mul(d > 0.001 ? normalize(diff) : v(1, 0), (RULES.playerRadius * 2 - d) * 0.5);
        a.position = moveAndSlide(state.arena, a.position, mul(push, -1), RULES.playerRadius);
        b.position = moveAndSlide(state.arena, b.position, push, RULES.playerRadius);
      }
    }
}
