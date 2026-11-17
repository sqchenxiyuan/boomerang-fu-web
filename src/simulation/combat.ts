import { lineOfSight, moveAndSlide } from '../core/collision';
import {
  DISARM_CENTER,
  DISARM_SHAPE,
  MELEE_CENTER,
  MELEE_SHAPE,
  NATIVE,
  RULES,
} from '../core/config';
import { add, distance, dot, length, mul, normalize, reflect, sub, v } from '../core/math';
import type { Vec2 } from '../core/math';
import type {
  Actor,
  DeathCause,
  DeathState,
  Disc,
  GameState,
  KillerType,
  Obstacle,
  PowerupKind,
} from '../core/types';
import { heldDiscs } from './inventory';
import { addZone, freezeActor, hitDecoy } from './status-effects';
import { damageEnvironmentObstacle, strikeEnvironment } from './environment';
import { obstacleDistance } from '../core/geometry';
import { freeze, slowMo } from './clock';
import { getStunned, startPushback, stopAiming, stopLunge } from './actors';
import { dropDisc, startFreeform, startThrow, bounceDisc } from './projectiles';

/*
 * Combat triggers from the reference CombatWorld: melee/disarm polygons, blocks,
 * parries, shields, disc damage, kill attribution and the resulting time effects.
 */
const C = NATIVE.combat;
const S = NATIVE.slowMo;

export function breakCrate(
  state: GameState,
  obstacle: Obstacle,
  actorId: number,
  hitSerial?: number,
): void {
  if (obstacle.kind !== 'crate' || obstacle.broken) return;
  if (damageEnvironmentObstacle(state, obstacle, actorId, hitSerial)) return;
  obstacle.broken = true;
  state.events.push({ type: 'crate', position: { ...obstacle.position }, actorId });
}

/* ----------------------------------------------------------------- geometry */

const right = (facing: Vec2): Vec2 => v(-facing.y, facing.x);
function localToWorld(actor: Actor, point: Vec2, center: number): Vec2 {
  const f = normalize(actor.facing),
    r = right(f);
  return add(actor.position, add(mul(r, point.x), mul(f, point.y + center)));
}
export const meleeCenter = (actor: Actor): Vec2 => localToWorld(actor, v(), MELEE_CENTER);
export const disarmCenter = (actor: Actor): Vec2 => localToWorld(actor, v(), DISARM_CENTER);
export const meleePolygon = (actor: Actor): Vec2[] =>
  MELEE_SHAPE.map((point) => localToWorld(actor, v(point.x, point.y - MELEE_CENTER), MELEE_CENTER));
export const disarmPolygon = (actor: Actor): Vec2[] =>
  DISARM_SHAPE.map((point) =>
    localToWorld(actor, v(point.x, point.y - DISARM_CENTER), DISARM_CENTER),
  );

function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
function segmentDistance(point: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(point, a), ab) / Math.max(1e-12, dot(ab, ab))));
  return distance(point, add(a, mul(ab, t)));
}
/** Physics2D trigger overlap between a circle and a polygon. */
export function circleTouchesPolygon(center: Vec2, radius: number, polygon: Vec2[]): boolean {
  if (pointInPolygon(center, polygon)) return true;
  for (let i = 0; i < polygon.length; i++)
    if (segmentDistance(center, polygon[i], polygon[(i + 1) % polygon.length]) < radius)
      return true;
  return false;
}
function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const cross = (o: Vec2, p: Vec2, q: Vec2): number =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a),
    d2 = cross(c, d, b),
    d3 = cross(a, b, c),
    d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
export function polygonsIntersect(a: Vec2[], b: Vec2[]): boolean {
  if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return true;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (segmentsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return false;
}
/** CombatWorld.LineBlocked: an obstacle between two points. */
export const lineBlocked = (state: GameState, from: Vec2, to: Vec2): boolean =>
  !lineOfSight(state.arena, from, to);

export function facingTarget(actor: Actor, position: Vec2, threshold = 0): boolean {
  return dot(actor.facing, normalize(sub(position, actor.position))) >= threshold;
}

const isArmedAttack = (actor: Actor): boolean =>
  actor.alive && actor.attackTime > 0 && actor.attackArmed;
const isDisarming = (actor: Actor): boolean =>
  actor.alive && actor.attackTime > 0 && !actor.attackArmed;
const frontal = (actor: Actor, point: Vec2): boolean =>
  isArmedAttack(actor) && dot(normalize(sub(point, actor.position)), actor.facing) > 0;
const protect = (table: Record<number, number> | undefined, id: number): Record<number, number> => {
  const result = table ?? {};
  result[id] = C.protectionFrames;
  return result;
};

/* ------------------------------------------------------------ attribution */

export function attribute(actor: Actor, killer: number, type: KillerType, timer: number): void {
  actor.killerId = killer;
  actor.killerType = type;
  actor.killerTimer = timer;
}

function resolveKiller(actor: Actor, sourceId: number, cause: DeathCause): number {
  const attributed =
    actor.killerId !== undefined && actor.killerId !== actor.id ? actor.killerId : undefined;
  if (cause === 'fall' || cause === 'crush' || cause === 'boundary') return attributed ?? sourceId;
  return sourceId;
}

/** GameManager.PlayerKilled → AddPlayerKill / AddPlayerSuicide, plus RecordKill. */
function scoreDeath(state: GameState, victim: Actor, killerId: number, cause: DeathCause): void {
  const killer = state.actors.find((actor) => actor.id === killerId);
  const scoring = state.options.scoring ?? 'kills';
  if (killer && killer.id !== victim.id) {
    killer.kills++;
    if (scoring === 'kills') {
      killer.score++;
      const goal = state.options.scoreGoal;
      const alive = state.actors.filter((actor) => actor.alive);
      // GameManager.AddPlayerKill: a tie-breaker kill, or an unopposed goal, ends the match.
      const contested = alive.some(
        (other) => other.id !== killer.id && other.score + (alive.length - 1) >= goal,
      );
      if (
        state.tieBreaker ||
        (killer.score >= goal &&
          !contested &&
          killer.alive &&
          (killer.burnTime ?? 0) <= 0 &&
          (killer.frozenTime ?? 0) <= 0)
      )
        state.pendingWinnerId ??= killer.id;
    }
  } else if (scoring === 'kills' && cause !== 'fall' && !state.tieBreaker) {
    victim.suicides = (victim.suicides ?? 0) + 1;
    victim.score--;
  }
  const records =
    cause === 'weapon' ||
    cause === 'telefrag' ||
    (killer !== undefined &&
      killer.id !== victim.id &&
      (cause === 'explosion' ||
        cause === 'boundary' ||
        cause === 'crush' ||
        (cause === 'fall' && victim.killerType === 'Push')));
  if (killer && killer.id !== victim.id && records) {
    const streak = (killer.streak ??= { count: 0, last: -1e9 });
    if (state.time - streak.last > C.streakWindow) streak.count = 0;
    streak.last = state.time;
    streak.count++;
    if (streak.count >= 2)
      state.events.push({
        type: 'streak',
        position: { ...killer.position },
        actorId: killer.id,
        value: streak.count,
      });
    if (streak.count >= 3) freeze(state, S.streakFreeze);
  }
}

/** CombatWorld.Kill plus the Web death presentation record. */
export function damageActor(
  state: GameState,
  actor: Actor,
  sourceId: number,
  direction: Vec2,
  cause: DeathCause = 'weapon',
): 'ignored' | 'shield' | 'killed' {
  if (!actor.alive) return 'ignored';
  const environmental =
    cause === 'fall' ||
    cause === 'boundary' ||
    cause === 'fire' ||
    cause === 'telefrag' ||
    cause === 'crush';
  if (!environmental && (actor.dashTime > 0 || actor.invulnerable > 0)) return 'ignored';
  if (!environmental && actor.shield) {
    breakShield(state, actor);
    return 'shield';
  }
  const killerId = resolveKiller(actor, sourceId, cause);
  actor.alive = false;
  actor.deathTime = state.time;
  const deathDirection = normalize(dot(direction, direction) > 1e-10 ? direction : actor.facing);
  const variant: DeathState['variant'] =
    cause === 'weapon'
      ? 'slice'
      : cause === 'explosion' || cause === 'telefrag' || cause === 'crush'
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
  stopAiming(actor);
  actor.fall = undefined;
  actor.outOfBounds = undefined;
  actor.shield = false;
  state.roundFinishTimer = RULES.roundResolveDelay;
  actor.armed = false;
  actor.heldDiscs = 0;
  actor.disguised = false;
  actor.burnTime = 0;
  actor.frozenTime = 0;
  actor.reverseTime = 0;
  actor.phaseOrigin = undefined;
  for (const decoy of state.decoys ?? []) if (decoy.ownerId === actor.id) decoy.alive = false;
  actor.attackTime = 0;
  actor.lungeTime = 0;
  actor.lungeRecovery = 0;
  actor.dashTime = 0;
  actor.stun = 0;
  actor.pushTime = 0;
  actor.velocity = mul(normalize(direction), cause === 'fall' ? 0 : 6 * NATIVE.scale);
  // Disc.BecomePublic: the dead owner's projectiles keep attribution for a second.
  for (const disc of state.discs)
    if (!disc.dead && disc.ownerId === actor.id && disc.publicTimer === undefined)
      disc.publicTimer = disc.mini ? NATIVE.disc.miniPublicDelay : NATIVE.disc.publicDelay;
  scoreDeath(state, actor, killerId, cause);
  slowMo(state, S.death.hold, S.death.lerpIn);
  state.events.push({
    type: 'death',
    position: { ...actor.position },
    actorId: actor.id,
    value: killerId,
    cause,
    direction: { ...deathDirection },
    variant,
  });
  return 'killed';
}

/** Player.DamageShield: one hit, then .85 s of invulnerability. */
export function breakShield(state: GameState, actor: Actor): void {
  actor.shield = false;
  actor.powers = actor.powers.filter((p) => p !== 'shield');
  actor.invulnerable = 0.85;
  state.events.push({ type: 'shield', position: { ...actor.position }, actorId: actor.id });
}

/** Ends a swing after a block or parry and spends the remaining attack budget. */
function endMeleeOnBlock(actor: Actor): void {
  actor.attackTime = 0;
  actor.attackCooldown = NATIVE.actor.blockCooldown;
  if ((actor.attacksLeft ?? 0) > 0) {
    actor.attacksLeft = 0;
    actor.coolingAttack = true;
    actor.attackCooldown = NATIVE.actor.blockBudgetCooldown;
  }
  stopLunge(actor);
}

/* ------------------------------------------------------------- disc hits */

/** CombatWorld.TriggerDamage. */
export function triggerDamage(state: GameState, actor: Actor, disc: Disc): boolean {
  if (disc.dead || disc.projectile === false) return false;
  if (lineBlocked(state, actor.position, disc.position)) return false;
  if (!actor.alive || actor.shield || actor.dashTime > 0 || actor.invulnerable > 0) return false;
  if (actor.deflectedDiscs?.[disc.id]) return false;
  if (disc.movement === 'dropped' || disc.startedDropped || disc.ownerId === actor.id) return false;
  if (frontal(actor, disc.position)) {
    const owner = state.actors.find((a) => a.id === disc.ownerId);
    if (owner && distance(actor.position, disc.position) < distance(disc.position, owner.position))
      owner.deflectedMelees = protect(owner.deflectedMelees, actor.id);
    return false;
  }
  const owner = state.actors.find((a) => a.id === disc.ownerId);
  if (!owner && (actor.frozenTime ?? 0) <= 0) return false;
  if (owner) attribute(actor, owner.id, 'Disc', 0);
  return (
    damageActor(state, actor, owner?.id ?? actor.id, sub(actor.position, disc.position)) ===
    'killed'
  );
}

/** Projectile vs shield; bounces the disc off unless the shield holder is dashing. */
export function triggerShieldDisc(state: GameState, actor: Actor, disc: Disc): boolean {
  if (disc.dead || !actor.shield || !actor.alive || disc.projectile === false) return false;
  const outward = normalize(sub(disc.position, actor.position));
  const blocked = lineBlocked(state, actor.position, disc.position);
  const accepted =
    actor.dashTime <= 0 && !blocked && !frontal(actor, disc.position) && disc.ownerId !== actor.id;
  if (accepted) {
    attribute(actor, disc.ownerId, 'Disc', C.killerDisc);
    breakShield(state, actor);
    stopAiming(actor);
    actor.velocity = v();
    const stored = actor.stored ?? v(),
      discStored = disc.stored ?? disc.velocity;
    if ((disc.charge ?? 0) >= 1) {
      actor.velocity = reflect(stored, outward);
      startPushback(
        actor,
        mul(sub(stored, discStored), -1.2),
        C.shieldChargedPushTime,
        C.shieldChargedStun,
      );
      slowMo(state, S.chargedShield.hold);
    } else startPushback(actor, discStored, C.shieldPushTime, actor.stun > 0 ? 0 : C.shieldStun);
  }
  disc.canHome = false;
  if (disc.ownerId >= 0 && disc.ownerId !== actor.id && !actor.deflectedDiscs?.[disc.id]) {
    if (!disc.startedDropped) disc.canCollideWithOwner = true;
    let incoming = disc.velocity;
    const inward = mul(outward, -length(disc.velocity));
    const d = dot(normalize(incoming), outward);
    if (d > 0) incoming = inward;
    else if (d > -0.5) incoming = add(mul(incoming, 0.25), mul(inward, 0.75));
    if (length(disc.velocity) < 0.1 * NATIVE.scale) incoming = mul(outward, -1);
    if (actor.dashTime <= 0) bounceDisc(state, disc, incoming, outward);
  }
  return accepted;
}

/** A swing that touches a flying disc: reflect it, re-arm own discs. */
export function triggerDiscParry(state: GameState, actor: Actor, disc: Disc): boolean {
  if (disc.dead || !isArmedAttack(actor)) return false;
  const center = meleeCenter(actor);
  const actorBlocked = lineBlocked(state, actor.position, disc.position);
  const discBlocked = lineBlocked(state, disc.position, center);
  const owner = state.actors.find((a) => a.id === disc.ownerId);
  const override = (): void => {
    if (!owner || discBlocked) return;
    disc.canBeControlled = false;
    disc.canHome = false;
    if (owner === actor && disc.movement !== 'dropped') disc.charge = 1;
  };
  if (actor.deflectedDiscs?.[disc.id] || (owner === actor && !disc.canCollideWithOwner)) {
    override();
    return false;
  }
  if (actorBlocked && discBlocked) return false;
  const normal = normalize(sub(disc.position, actor.position));
  if (
    !actorBlocked &&
    disc.projectile !== false &&
    disc.movement !== 'dropped' &&
    !disc.startedDropped
  ) {
    endMeleeOnBlock(actor);
    const stored = actor.stored ?? v();
    actor.velocity = reflect(stored, normal);
    const charged = (disc.charge ?? 0) >= 1;
    if (charged) {
      let direction = mul(sub(stored, disc.stored ?? disc.velocity), -1.2);
      if (length(direction) < 1 * NATIVE.scale)
        direction = mul(normalize(sub(actor.position, disc.position)), 80 * NATIVE.scale);
      startPushback(actor, direction, C.parryPushTime, C.parryStun);
      slowMo(state, S.chargedParry.hold);
    }
    freeze(state, C.parryFreeze);
    state.events.push({
      type: 'deflect',
      position: { ...disc.position },
      actorId: actor.id,
      feedback: 'parry',
      charged,
    });
  }
  override();
  if (owner && !discBlocked) {
    if (!disc.startedDropped) disc.canCollideWithOwner = true;
    let incoming = disc.velocity;
    const inward = mul(normal, -length(disc.velocity));
    const d = dot(normalize(incoming), normal);
    if (d > 0) incoming = inward;
    else if (d > -0.5) incoming = add(mul(incoming, 0.25), mul(inward, 0.75));
    if (length(disc.velocity) < 0.1 * NATIVE.scale) incoming = mul(normal, -1);
    let n = normal;
    const turn = (vector: Vec2): Vec2 => {
      const a = (-45 * Math.PI) / 180;
      return v(
        vector.x * Math.cos(a) - vector.y * Math.sin(a),
        vector.x * Math.sin(a) + vector.y * Math.cos(a),
      );
    };
    if (dot(normalize(reflect(incoming, n)), normalize(sub(owner.position, disc.position))) > 0.9)
      incoming = turn(incoming);
    if (dot(normalize(reflect(incoming, n)), normalize(sub(actor.position, disc.position))) > 0.9)
      n = mul(n, -1);
    disc.deflectedTimer = NATIVE.disc.deflectProtection;
    bounceDisc(state, disc, incoming, n);
    if (disc.movement !== 'dropped') {
      if (owner === actor) {
        disc.throwDirection = normalize(disc.velocity);
        startThrow(state, disc, true);
      } else {
        startFreeform(state, disc, NATIVE.disc.parryBoost);
        if (distance(disc.position, owner.position) < distance(center, owner.position))
          owner.deflectedMelees = protect(owner.deflectedMelees, actor.id);
      }
    } else startFreeform(state, disc, NATIVE.disc.droppedParryBoost, true);
    disc.colliderDisabled = NATIVE.disc.colliderDisable;
    disc.damageOwnerId = owner.id;
    disc.lastDeflector = actor.id;
  }
  if (!actorBlocked) actor.deflectedDiscs = protect(actor.deflectedDiscs, disc.id);
  return true;
}

/* -------------------------------------------------------------- melee */

function triggerShieldMelee(state: GameState, target: Actor, attacker: Actor): boolean {
  if (!target.shield || target.dashTime > 0 || !target.alive) return false;
  const center = meleeCenter(attacker);
  const normal = normalize(sub(center, target.position));
  if (
    (isArmedAttack(target) && dot(normal, target.facing) > 0) ||
    lineBlocked(state, target.position, center)
  )
    return false;
  stopAiming(target);
  target.velocity = v();
  attribute(target, attacker.id, 'Melee', C.killerDisc);
  breakShield(state, target);
  startPushback(
    target,
    mul(normal, -C.shieldMeleePush),
    C.shieldMeleePushTime,
    target.stun > 0 ? 0 : C.shieldMeleeStun,
  );
  endMeleeOnBlock(attacker);
  attacker.velocity = v();
  startPushback(
    attacker,
    mul(normalize(sub(target.position, attacker.position)), -C.meleeBlockPush),
    C.meleeBlockPushTime,
    C.meleeBlockStun,
  );
  return true;
}

function triggerMeleeDamage(state: GameState, target: Actor, source: Actor): boolean {
  if (!isArmedAttack(source) || heldDiscs(source) === 0) return false;
  if (!target.alive || target.shield || target.dashTime > 0 || target.invulnerable > 0)
    return false;
  if (target.deflectedMelees?.[source.id]) return false;
  if (lineBlocked(state, target.position, meleeCenter(source))) return false;
  if (frontal(target, source.position)) return false;
  attribute(target, source.id, 'Melee', 0);
  return damageActor(state, target, source.id, sub(target.position, source.position)) === 'killed';
}

function triggerMeleeBlock(state: GameState, actor: Actor, other: Actor): boolean {
  const otherCenter = meleeCenter(other);
  if (!actor.alive || lineBlocked(state, actor.position, otherCenter)) return false;
  if (dot(normalize(sub(actor.position, otherCenter)), other.facing) < -0.25) return false;
  endMeleeOnBlock(actor);
  const direction = mul(normalize(sub(otherCenter, actor.position)), -C.meleeBlockPush);
  actor.velocity = v();
  startPushback(
    actor,
    mul(direction, C.meleeBlockPushFactor),
    C.meleeBlockPushTime,
    C.meleeBlockStun,
  );
  actor.deflectedMelees = protect(actor.deflectedMelees, other.id);
  return true;
}

function triggerDisarm(state: GameState, target: Actor, source: Actor): boolean {
  if (!isDisarming(source) || !target.alive) return false;
  if (target.dashTime > 0 || target.invulnerable > 0 || target.shield) return false;
  const center = disarmCenter(source);
  if (lineBlocked(state, target.position, center)) return false;
  attribute(target, source.id, 'Push', C.killerPush);
  const direction = mul(normalize(sub(target.position, center)), C.disarmPush);
  const armed = heldDiscs(target) > 0;
  const frozen = (target.frozenTime ?? 0) > 0;
  getStunned(target, direction, armed || frozen ? C.disarmStunArmed : C.disarmStunEmpty);
  if (armed && !frozen) dropDisc(state, target, mul(normalize(direction), C.disarmDropSpeed));
  if (armed) slowMo(state, S.armedDisarm.hold);
  state.events.push({
    type: 'deflect',
    position: { ...target.position },
    actorId: source.id,
    entityId: target.id,
    feedback: 'disarm',
    value: armed ? 1 : 0,
  });
  return true;
}

/** Native melee/disarm overlap phase plus Web environment strikes. */
export function resolveMelee(state: GameState): void {
  for (const actor of state.actors) {
    if (!actor.alive || actor.attackTime <= 0) continue;
    strikeEnvironment(state, {
      kind: 'melee',
      position: actor.position,
      direction: actor.facing,
      radius: RULES.attackRange,
      actorId: actor.id,
      serial: actor.attackSerial,
    });
    for (const decoy of state.decoys ?? []) {
      if (
        decoy.alive &&
        decoy.ownerId !== actor.id &&
        actor.attackArmed &&
        circleTouchesPolygon(decoy.position, NATIVE.damageRadius, meleePolygon(actor)) &&
        lineOfSight(state.arena, actor.position, decoy.position)
      )
        hitDecoy(state, decoy, actor.id);
    }
    for (const obstacle of state.arena.obstacles) {
      if (
        !obstacle.broken &&
        obstacle.kind === 'crate' &&
        obstacleDistance(obstacle, actor.position) < RULES.attackRange &&
        facingTarget(actor, obstacle.position, 0.2)
      )
        breakCrate(state, obstacle, actor.id, actor.attackSerial);
    }
  }
  // Armed melee: shields, enter-only damage, and swing-on-swing blocks.
  const damageNow = new Map<number, number[]>();
  const blocksNow = new Map<number, number[]>();
  const actors = state.actors;
  for (let i = 0; i < actors.length; i++) {
    const attacker = actors[i];
    if (!isArmedAttack(attacker)) continue;
    const polygon = meleePolygon(attacker);
    for (let j = 0; j < actors.length; j++) {
      const victim = actors[j];
      if (i === j || !victim.alive) continue;
      if (victim.shield && circleTouchesPolygon(victim.position, NATIVE.shieldRadius, polygon))
        triggerShieldMelee(state, victim, attacker);
      if (!isArmedAttack(attacker)) break;
      if (circleTouchesPolygon(victim.position, NATIVE.damageRadius, polygon)) {
        damageNow.set(attacker.id, [...(damageNow.get(attacker.id) ?? []), victim.id]);
        if (!(attacker.meleeContacts ?? []).includes(victim.id) || victim.justVulnerable) {
          victim.justVulnerable = false;
          if (victim.invulnerable > 0 && !lineBlocked(state, attacker.position, victim.position))
            stopLunge(attacker, false);
          triggerMeleeDamage(state, victim, attacker);
        }
      }
      if (j > i && isArmedAttack(victim) && polygonsIntersect(polygon, meleePolygon(victim))) {
        blocksNow.set(attacker.id, [...(blocksNow.get(attacker.id) ?? []), victim.id]);
        if (!(attacker.blockContacts ?? []).includes(victim.id)) {
          const a = triggerMeleeBlock(state, attacker, victim);
          const b = triggerMeleeBlock(state, victim, attacker);
          if (a || b) {
            freeze(state, C.meleeBlockFreeze);
            state.events.push({
              type: 'deflect',
              position: mul(add(attacker.position, victim.position), 0.5),
              actorId: attacker.id,
              entityId: victim.id,
              feedback: 'clash',
            });
          }
        }
      }
    }
  }
  for (const actor of actors) {
    actor.meleeContacts = damageNow.get(actor.id) ?? [];
    actor.blockContacts = blocksNow.get(actor.id) ?? [];
  }
  // Unarmed disarms.
  const disarmsNow = new Map<number, number[]>();
  for (const attacker of actors) {
    if (!isDisarming(attacker)) continue;
    const polygon = disarmPolygon(attacker);
    for (const victim of actors) {
      if (victim === attacker || !victim.alive) continue;
      if (!circleTouchesPolygon(victim.position, NATIVE.damageRadius, polygon)) continue;
      disarmsNow.set(attacker.id, [...(disarmsNow.get(attacker.id) ?? []), victim.id]);
      if (!(attacker.disarmContacts ?? []).includes(victim.id) || victim.justVulnerable) {
        victim.justVulnerable = false;
        triggerDisarm(state, victim, attacker);
      }
    }
  }
  for (const actor of actors) actor.disarmContacts = disarmsNow.get(actor.id) ?? [];
}

/* ---------------------------------------------------------- explosions */

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
  strikeEnvironment(state, {
    kind: 'explosion',
    position,
    direction: v(),
    radius,
    actorId: sourceId,
    fire,
    ice,
  });
  state.events.push({
    type: 'explosion',
    position: { ...position },
    actorId: sourceId,
    value: radius,
    power: ice ? 'ice' : fire ? 'fire' : 'explosive',
  });
  // Obstacles block blast rays; crates touched by this blast break after damage.
  for (const actor of state.actors) {
    if (!actor.alive || !lineOfSight(state.arena, position, actor.position)) continue;
    const reach = distance(actor.position, position);
    // CombatWorld.ExplosionShield: the shield absorbs the blast and stuns.
    if (
      actor.shield &&
      actor.dashTime <= 0 &&
      actor.invulnerable <= 0 &&
      reach < radius + NATIVE.shieldRadius
    ) {
      actor.velocity = v();
      startPushback(
        actor,
        mul(normalize(sub(actor.position, position)), C.explosionShieldPush),
        C.explosionShieldPushTime,
        C.explosionShieldStun,
      );
      breakShield(state, actor);
      attribute(actor, sourceId, 'Explosion', C.killerDisc);
    }
    if (reach >= radius + NATIVE.damageRadius) continue;
    if (actor.shield || actor.dashTime > 0 || actor.invulnerable > 0) continue;
    if (ice) {
      freezeActor(state, actor, sourceId);
      attribute(actor, sourceId, 'Freeze', 7.01);
    } else {
      attribute(actor, sourceId, 'Explosion', 0);
      damageActor(state, actor, sourceId, sub(actor.position, position), 'explosion');
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

/** Positional separation for actors that already overlap (spawns, teleports). */
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
