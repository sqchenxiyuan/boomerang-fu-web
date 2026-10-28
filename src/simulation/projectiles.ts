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
import type { Actor, DecoyState, Disc, GameState, PowerupKind } from '../core/types';
import { breakCrate, damageActor, explode, facingTarget } from './combat';
import { tracePortal, teleportDisc } from './portals';
import { heldDiscs, setHeldDiscs, recoverDisc } from './inventory';
import { addZone, hitDecoy } from './status-effects';

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
  const id = state.nextId++;
  state.discs.push({
    id,
    groupId: id,
    powers: [...actor.powers],
    mini: false,
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
  setHeldDiscs(actor, heldDiscs(actor) - 1);
  actor.disguised = false;
  actor.disguiseTime = 0;
  actor.charge = 0;
  actor.attackCooldown = RULES.attackCooldown;
  state.events.push({ type: 'throw', position: { ...position }, actorId: actor.id, value: charge });
  return true;
}

function finishDisc(state: GameState, disc: Disc, caught = false): void {
  recoverDisc(state, disc, caught);
}

const has = (disc: Disc, power: PowerupKind): boolean => disc.powers?.includes(power) ?? false;

function detonate(state: GameState, disc: Disc): void {
  explode(state, disc.position, disc.damageOwnerId, disc.powers, disc.mini ? 0.5 : 1);
  finishDisc(state, disc);
}

function splitDisc(state: GameState, parent: Disc): void {
  const count = parent.explosive || has(parent, 'fire') ? 4 : 5;
  parent.dead = true;
  const direction = normalize(parent.velocity);
  for (let i = 0; i < count; i++) {
    state.discs.push({
      ...parent,
      id: state.nextId++,
      groupId: parent.groupId ?? parent.id,
      position: { ...parent.position },
      previous: { ...parent.position },
      velocity: mul(rotate(direction, -Math.PI / 2 + (Math.PI * i) / (count - 1)), RULES.discSpeed),
      powers: parent.powers?.filter((power) => power !== 'multi'),
      mini: true,
      dead: false,
      age: 0,
      state: 'outbound',
      stateTime: 0,
      charge: 0,
      curve: 0,
      bounces: 0,
      fuse: 0.931 + i * 0.1,
    });
  }
  state.events.push({
    type: 'split',
    position: { ...parent.position },
    actorId: parent.ownerId,
    value: count,
  });
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
    let decoyTarget: DecoyState | null = null;
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
    for (const decoy of state.decoys ?? []) {
      if (!decoy.alive || decoy.ownerId === disc.damageOwnerId) continue;
      const hit = segmentCircle(
        disc.position,
        delta,
        decoy.position,
        RULES.playerRadius + RULES.discRadius,
      );
      if (hit && hit.t < closest) {
        closest = hit.t;
        decoyTarget = decoy;
        target = null;
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
    if (decoyTarget) {
      hitDecoy(state, decoyTarget, disc.damageOwnerId);
      if (disc.explosive) {
        detonate(state, disc);
        return;
      }
      disc.position = add(disc.position, mul(normalize(delta), 0.02));
    } else if (target) {
      if (parry) {
        deflectDisc(state, disc, target);
        return;
      }
      if (disc.explosive) {
        detonate(state, disc);
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
  // New fragments begin on the following fixed step, independent of array append behavior.
  const count = state.discs.length;
  for (let index = 0; index < count; index++) {
    const disc = state.discs[index];
    if (disc.dead) continue;
    const owner = state.actors.find((a) => a.id === disc.ownerId);
    disc.previous = { ...disc.position };
    disc.age += dt;
    disc.stateTime += dt;
    disc.grace = Math.max(0, disc.grace - dt);
    disc.portalCooldown = Math.max(0, (disc.portalCooldown ?? 0) - dt);
    if (disc.explosive && !has(disc, 'multi')) {
      disc.fuse -= dt;
      if (disc.fuse <= 0) {
        detonate(state, disc);
        continue;
      }
    }
    if (!owner?.alive && disc.age > 0.4 && !disc.explosive) {
      disc.state = 'dropped';
      disc.velocity = v();
    }
    const controlled =
      owner?.alive && owner.controlling && has(disc, 'controlled') && disc.state !== 'dropped';
    if (controlled && owner.controlDirection && length(owner.controlDirection) > 0.05) {
      disc.velocity = mul(
        normalize(
          lerpV(normalize(disc.velocity), normalize(owner.controlDirection), clamp(dt * 9, 0, 1)),
        ),
        RULES.discSpeed,
      );
    }
    if (controlled) {
      const radial = sub(disc.position, owner.position);
      const d = length(radial),
        direction = normalize(radial);
      const outward = dot(disc.velocity, direction);
      if (d > 10.4 && outward > 0)
        disc.velocity = sub(disc.velocity, mul(direction, outward * clamp((d - 10.4) / 1.6, 0, 1)));
      if (d > 12) disc.velocity = add(disc.velocity, mul(direction, -(d - 12) * 12));
    }
    if (disc.state === 'outbound') {
      if (!controlled) {
        disc.velocity = rotate(disc.velocity, disc.curve * dt * 2);
        // Small, forward-only aim assist; no steering through cover.
        const targets = state.actors.filter(
          (a) =>
            a.alive &&
            !a.disguised &&
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
      }
      const outbound = disc.mini
        ? 0.3378 * (disc.explosive ? 0.2 : 1)
        : RULES.discOutbound - disc.charge * 0.15;
      if (!controlled && disc.stateTime >= outbound) {
        if (has(disc, 'multi')) {
          splitDisc(state, disc);
          continue;
        }
        disc.state = disc.explosive ? 'dropped' : 'returning';
        disc.stateTime = 0;
        if (disc.explosive) disc.velocity = mul(disc.velocity, 0.1);
      }
    }
    if (owner?.alive && owner.recalling && !controlled && !disc.explosive && disc.age > 0.15) {
      if (disc.state !== 'returning') disc.bounces = 0;
      disc.state = 'returning';
    }
    if (controlled && disc.state === 'returning') disc.state = 'outbound';
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
      !disc.dead &&
      !has(disc, 'multi') &&
      disc.state !== 'dropped' &&
      ((has(disc, 'fire') && !disc.explosive) || has(disc, 'ice'))
    ) {
      disc.trailTime = (disc.trailTime ?? 0) - dt;
      if (disc.trailTime <= 0) {
        addZone(state, has(disc, 'fire') ? 'fire' : 'ice', disc.position, disc.damageOwnerId);
        disc.trailTime = 0.08;
      }
    }
    if (
      Math.abs(disc.position.x) > state.arena.halfWidth + 1.5 ||
      Math.abs(disc.position.y) > state.arena.halfHeight + 1.5
    ) {
      if (disc.explosive) {
        detonate(state, disc);
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
