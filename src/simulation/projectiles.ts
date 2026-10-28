import { lineOfSight, segmentCircle, traceObstacles } from '../core/collision';
import { RULES } from '../core/config';
import {
  add,
  angleBetween,
  clamp,
  distance,
  dot,
  length,
  lerpV,
  mul,
  normalize,
  reflect,
  rotate,
  sub,
  v,
} from '../core/math';
import type { Actor, Disc, GameState } from '../core/types';
import { breakCrate, damageActor, explode, facingTarget } from './combat';
import { tracePortal, teleportDisc } from './portals';

export function throwDisc(state: GameState, actor: Actor): boolean {
  if (
    !actor.alive ||
    !actor.armed ||
    actor.attackCooldown > 0 ||
    actor.stun > 0 ||
    actor.dashTime > 0
  )
    return false;
  const charge =
    1 -
    Math.cos(
      (Math.PI / 2) * clamp((actor.charge - RULES.aimStart) / RULES.chargeCurveDuration, 0, 1),
    );
  const oldFacing = actor.facingHistory[0] ?? actor.facing;
  const curve = clamp(angleBetween(oldFacing, actor.facing), -Math.PI / 2, Math.PI / 2);
  const offset = mul(actor.facing, RULES.playerRadius + RULES.discRadius + 0.12);
  const hit = traceObstacles(state.arena, actor.position, offset, RULES.discRadius);
  const position = add(actor.position, mul(offset, hit ? Math.max(0, hit.t - 0.02) : 1));
  state.discs.push({
    id: state.nextId++,
    ownerId: actor.id,
    damageOwnerId: actor.id,
    position,
    previous: { ...position },
    velocity: add(
      mul(actor.facing, RULES.discSpeed * (1 + charge * 0.4)),
      mul(actor.velocity, 0.35),
    ),
    state: 'outbound',
    age: 0,
    stateTime: 0,
    charge,
    curve,
    bounces: 0,
    explosive: actor.powers.includes('explosive'),
    fuse: RULES.explosionFuse,
    grace: 0.15,
    lastDeflector: -1,
    dead: false,
  });
  actor.armed = false;
  actor.charge = 0;
  actor.attackCooldown = RULES.attackCooldown;
  state.events.push({ type: 'throw', position: { ...position }, actorId: actor.id, value: charge });
  return true;
}

function finishDisc(state: GameState, disc: Disc, caught = false): void {
  if (disc.dead) return;
  disc.dead = true;
  const owner = state.actors.find((a) => a.id === disc.ownerId);
  if (owner?.alive) {
    if (owner.recalling) owner.throwBlocked = true;
    owner.armed = true;
    owner.recalling = false;
    if (caught)
      state.events.push({ type: 'catch', position: { ...owner.position }, actorId: owner.id });
  }
}

function deflectDisc(state: GameState, disc: Disc, actor: Actor): void {
  const direction = normalize(
    add(actor.facing, mul(normalize(sub(disc.position, actor.position)), 0.25)),
  );
  disc.velocity = mul(direction, Math.max(RULES.discSpeed, length(disc.velocity)) * 1.1);
  disc.position = add(actor.position, mul(direction, RULES.attackRange + RULES.discRadius + 0.08));
  disc.damageOwnerId = actor.id;
  disc.state = 'outbound';
  disc.stateTime = 0;
  disc.grace = 0.18;
  disc.lastDeflector = actor.id;
  disc.curve = 0;
  state.events.push({
    type: 'deflect',
    position: { ...disc.position },
    actorId: actor.id,
    feedback: 'parry',
  });
}

/** Continuous collision considers walls and actors together, resolving the closest hit first. */
function moveDisc(state: GameState, disc: Disc, dt: number): void {
  let remaining = dt;
  for (let bounce = 0; bounce < 4 && remaining > 0.00001 && !disc.dead; bounce++) {
    const delta = mul(disc.velocity, remaining);
    const wall = traceObstacles(state.arena, disc.position, delta, RULES.discRadius);
    const portal = tracePortal(
      state.arena,
      disc.position,
      delta,
      RULES.discRadius,
      disc.portalCooldown,
    );
    let closest = wall?.t ?? 2;
    let target: Actor | null = null;
    let parry = false;
    for (const actor of state.actors) {
      if (!actor.alive || actor.dashTime > 0 || actor.invulnerable > 0) continue;
      if (actor.id === disc.lastDeflector && disc.grace > 0) continue;
      if (actor.id === disc.ownerId && disc.damageOwnerId === disc.ownerId) continue;
      const canParry =
        actor.attackTime > 0 && actor.attackArmed && facingTarget(actor, disc.position, 0.1);
      const hit = segmentCircle(
        disc.position,
        delta,
        actor.position,
        (canParry ? RULES.attackRange * 0.85 : RULES.playerRadius) + RULES.discRadius,
      );
      if (hit && hit.t < closest) {
        closest = hit.t;
        target = actor;
        parry = canParry;
      }
    }
    if (portal && portal.t < closest) {
      remaining *= 1 - portal.t;
      teleportDisc(state, disc, portal);
      continue;
    }
    if (closest > 1) {
      disc.position = add(disc.position, delta);
      return;
    }
    disc.position = add(disc.position, mul(delta, Math.max(0, closest - 0.0001)));
    remaining *= 1 - closest;
    if (target) {
      if (parry) {
        deflectDisc(state, disc, target);
        return;
      }
      if (disc.explosive) {
        explode(state, disc.position, disc.damageOwnerId);
        finishDisc(state, disc);
        return;
      }
      const result = damageActor(state, target, disc.damageOwnerId, disc.velocity);
      if (result === 'shield') {
        disc.velocity = mul(normalize(sub(disc.position, target.position)), RULES.discSpeed);
        disc.state = 'returning';
        disc.stateTime = 0;
        return;
      }
      // A cut-through hit can reach another target in the remaining substep.
      disc.position = add(disc.position, mul(normalize(delta), 0.02));
    } else if (wall) {
      if (wall.obstacle?.kind === 'crate') breakCrate(state, wall.obstacle, disc.damageOwnerId);
      disc.position = add(disc.position, mul(wall.normal, 0.015));
      disc.velocity = mul(reflect(disc.velocity, wall.normal), 0.88);
      disc.bounces++;
      disc.curve *= -0.5;
      state.events.push({
        type: 'bounce',
        position: { ...disc.position },
        actorId: disc.damageOwnerId,
      });
      if (disc.bounces >= 4) {
        disc.state = 'dropped';
        disc.stateTime = 0;
        disc.velocity = v();
        return;
      }
    }
  }
}

export function tickDiscs(state: GameState, dt: number): void {
  for (const disc of state.discs) {
    if (disc.dead) continue;
    const owner = state.actors.find((a) => a.id === disc.ownerId);
    disc.previous = { ...disc.position };
    disc.age += dt;
    disc.stateTime += dt;
    disc.grace = Math.max(0, disc.grace - dt);
    disc.portalCooldown = Math.max(0, (disc.portalCooldown ?? 0) - dt);
    if (disc.explosive) {
      disc.fuse -= dt;
      if (disc.fuse <= 0) {
        explode(state, disc.position, disc.damageOwnerId);
        finishDisc(state, disc);
        continue;
      }
    }
    if (!owner?.alive && disc.age > 0.4 && !disc.explosive) {
      disc.state = 'dropped';
      disc.velocity = v();
    }
    if (disc.state === 'outbound') {
      disc.velocity = rotate(disc.velocity, disc.curve * dt * 2);
      // Small, forward-only aim assist; no steering through cover.
      const targets = state.actors.filter(
        (a) =>
          a.alive &&
          a.id !== disc.damageOwnerId &&
          a.dashTime <= 0 &&
          distance(a.position, disc.position) < 3.5 &&
          dot(normalize(sub(a.position, disc.position)), normalize(disc.velocity)) > 0.82 &&
          lineOfSight(state.arena, disc.position, a.position),
      );
      const target = targets.sort(
        (a, b) => distance(a.position, disc.position) - distance(b.position, disc.position),
      )[0];
      if (target)
        disc.velocity = mul(
          normalize(
            lerpV(
              normalize(disc.velocity),
              normalize(sub(target.position, disc.position)),
              dt * 1.7,
            ),
          ),
          length(disc.velocity),
        );
      if (disc.stateTime >= RULES.discOutbound - disc.charge * 0.15) {
        disc.state = disc.explosive ? 'dropped' : 'returning';
        disc.stateTime = 0;
        if (disc.explosive) disc.velocity = mul(disc.velocity, 0.1);
      }
    }
    if (owner?.alive && owner.recalling && !disc.explosive && disc.age > 0.15) {
      if (disc.state !== 'returning') disc.bounces = 0;
      disc.state = 'returning';
    }
    if (disc.state === 'returning' && owner?.alive) {
      const direction = normalize(sub(owner.position, disc.position));
      const targetSpeed = RULES.discReturnSpeed * (owner.recalling ? 1.35 : 1);
      disc.velocity = lerpV(
        disc.velocity,
        mul(direction, targetSpeed),
        clamp(dt * (owner.recalling ? 12 : 7), 0, 1),
      );
      const catchHit = segmentCircle(
        disc.position,
        mul(disc.velocity, dt),
        owner.position,
        RULES.playerRadius + 0.35,
      );
      const wall = traceObstacles(
        state.arena,
        disc.position,
        mul(disc.velocity, dt),
        RULES.discRadius,
      );
      const portal = tracePortal(
        state.arena,
        disc.position,
        mul(disc.velocity, dt),
        RULES.discRadius,
        disc.portalCooldown,
      );
      if (
        disc.grace <= 0 &&
        (distance(disc.position, owner.position) < 0.8 ||
          (catchHit && (!wall || catchHit.t < wall.t) && (!portal || catchHit.t < portal.t)))
      ) {
        finishDisc(state, disc, true);
        continue;
      }
    }
    if (disc.state === 'dropped') {
      disc.velocity = mul(disc.velocity, Math.max(0, 1 - dt * 9));
      if (
        !disc.explosive &&
        owner?.alive &&
        disc.age > 0.3 &&
        distance(owner.position, disc.position) < 0.85
      ) {
        finishDisc(state, disc, true);
        continue;
      }
      const wall = traceObstacles(
        state.arena,
        disc.position,
        mul(disc.velocity, dt),
        RULES.discRadius,
      );
      if (wall) disc.velocity = v();
      disc.position = add(disc.position, mul(disc.velocity, dt));
    } else moveDisc(state, disc, dt);
    if (
      Math.abs(disc.position.x) > state.arena.halfWidth + 1.5 ||
      Math.abs(disc.position.y) > state.arena.halfHeight + 1.5
    ) {
      if (disc.explosive) {
        explode(state, disc.position, disc.damageOwnerId);
        finishDisc(state, disc);
      } else if (owner?.alive) {
        disc.state = 'returning';
        disc.bounces = 0;
      }
    }
    // Bounded recovery avoids permanently losing a weapon to geometry at an edge.
    if (disc.age > 8) finishDisc(state, disc, true);
  }
  state.discs = state.discs.filter((disc) => !disc.dead);
}
