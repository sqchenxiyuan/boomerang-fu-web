import { lineOfSight, moveAndSlide } from '../core/collision';
import { RULES } from '../core/config';
import { add, distance, dot, mul, normalize, sub, v } from '../core/math';
import type { Vec2 } from '../core/math';
import type { Actor, GameState, Obstacle } from '../core/types';

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
  cause: 'weapon' | 'explosion' | 'fall' | 'boundary' = 'weapon',
): 'ignored' | 'shield' | 'killed' {
  if (!actor.alive) return 'ignored';
  const environmental = cause === 'fall' || cause === 'boundary';
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
  actor.armed = false;
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
        target.armed = false;
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

export function explode(state: GameState, position: Vec2, sourceId: number): void {
  state.events.push({
    type: 'explosion',
    position: { ...position },
    actorId: sourceId,
    value: RULES.explosionRadius,
  });
  // Obstacles block blast rays; crates touched by this blast break after damage.
  for (const actor of state.actors) {
    if (
      distance(actor.position, position) < RULES.explosionRadius + RULES.playerRadius &&
      lineOfSight(state.arena, position, actor.position)
    )
      damageActor(state, actor, sourceId, sub(actor.position, position), 'explosion');
  }
  for (const obstacle of state.arena.obstacles)
    if (distance(position, obstacle.position) < RULES.explosionRadius + 0.4)
      breakCrate(state, obstacle, sourceId);
}

export function separateActors(state: GameState): void {
  for (let i = 0; i < state.actors.length; i++)
    for (let j = i + 1; j < state.actors.length; j++) {
      const a = state.actors[i],
        b = state.actors[j];
      if (!a.alive || !b.alive) continue;
      const diff = sub(b.position, a.position),
        d = distance(a.position, b.position);
      if (d < RULES.playerRadius * 2) {
        const push = mul(d > 0.001 ? normalize(diff) : v(1, 0), (RULES.playerRadius * 2 - d) * 0.5);
        a.position = moveAndSlide(state.arena, a.position, mul(push, -1), RULES.playerRadius);
        b.position = moveAndSlide(state.arena, b.position, push, RULES.playerRadius);
      }
    }
}
