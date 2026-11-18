import {
  lineOfSight,
  moveAndSlide,
  onGround,
  safePosition,
  segmentCircle,
  traceObstacles,
} from '../core/collision';
import { NATIVE, RULES } from '../core/config';
import {
  add,
  angleBetween,
  clampLength,
  distance,
  dot,
  length,
  mul,
  normalize,
  reflect,
  rotate,
  sub,
  v,
} from '../core/math';
import type { Vec2 } from '../core/math';
import type { Actor, Command, GameState } from '../core/types';
import { launchDisc } from './projectiles';
import { tickActorBoundary } from './boundary';
import { canRescueFall, rescueFall, tickFall } from './hazards';
import { heldDiscs, ownedWeapons, recoverDisc } from './inventory';
import { damageActor } from './combat';
import { breakDisguise, spawnDecoy } from './status-effects';
import { shapeContains } from '../core/geometry';
import { dacos, dcos, dsin } from '../core/dmath';

/*
 * Actor locomotion, Player input and weapon budget, following the reference
 * Actor.cs / Player.cs / PlayerInput.cs simulation. One Web step is one frame:
 * the fixed-step motion runs first, then input, then the per-frame timers.
 */
const A = NATIVE.actor;
const easeIn = (t: number): number => 1 - dcos((Math.PI / 2) * t);
const easeOut = (t: number): number => dsin((Math.PI / 2) * t);

export const aimPower = (actor: Actor): number =>
  Math.min(1, Math.max(0, easeIn(Math.min(1, Math.max(0, (actor.charge - 0.1) / 0.9)))));

export const isLunging = (actor: Actor): boolean => actor.lungeRecovery > 0;
export const isDashing = (actor: Actor): boolean => actor.dashTime > 0;
const canWalk = (actor: Actor): boolean =>
  actor.alive && !actor.fall && actor.dashCooldown <= 0 && !isLunging(actor);

/** Actor.StartPushback. `direction` is a Web-unit velocity-like vector. */
export function startPushback(actor: Actor, direction: Vec2, duration: number, stun = 0): void {
  if (!actor.alive) return;
  const slide = actor.slideFactor ?? 1;
  actor.velocity = add(actor.velocity, mul(direction, A.pushbackImpulse * RULES.dt * slide));
  actor.pushDuration = duration;
  actor.pushTime = duration;
  actor.pushDirection = normalize(direction);
  actor.pushStrength = A.pushbackStrength * length(direction);
  if (stun > 0) {
    actor.stunDirection = mul(direction, -1);
    actor.stun = stun;
    breakDisguise(actor);
  }
}

/** Actor.StopAiming → Player.OnActorStopAiming. */
export function stopAiming(actor: Actor, moving = false): void {
  if (actor.aiming && moving) actor.aimMoveLag = 1;
  actor.aiming = false;
  actor.charge = 0;
  actor.facingHistory = [];
  if (actor.inputHeld) {
    actor.throwBlocked = true;
    actor.inputHeld = false;
  }
  actor.retrieveCharge = 0;
  actor.recalling = false;
  actor.controlling = false;
}

/** Actor.GetStunned. */
export function getStunned(actor: Actor, direction: Vec2, duration = 0.66): void {
  actor.attackTime = 0;
  stopAiming(actor);
  actor.velocity = v();
  startPushback(actor, direction, 0.5, actor.stun > 0 ? 0 : duration);
}

/** Actor.StopLunge. */
export function stopLunge(actor: Actor, reduceVelocity = true): void {
  if (actor.lungeTime <= 0) return;
  actor.lungeTime = 0;
  if (reduceVelocity) actor.velocity = mul(clampLength(actor.velocity, A.speedLimit), 0.5 * 0.3);
}

/** Actor.StopDash: the unused dash time is refunded from the cooldown. */
export function stopDash(actor: Actor): void {
  if (actor.dashTime > 0) {
    actor.dashCooldown = Math.max(0, actor.dashCooldown - actor.dashTime);
    actor.dashTime = 0;
  }
}

/** Dash checks teleport before the ordinary dash cooldown, as Player.Dash does. */
export function tryTeleport(state: GameState, actor: Actor): boolean {
  if (!actor.powers.includes('teleport') || (actor.fall && !canRescueFall(actor))) return false;
  const disc = state.discs.find(
    (candidate) =>
      candidate.ownerId === actor.id &&
      !candidate.dead &&
      safePosition(state.arena, candidate.position, RULES.playerRadius),
  );
  if (!disc) return false;
  if (
    distance(actor.position, disc.position) < RULES.playerRadius * 3 &&
    lineOfSight(state.arena, actor.position, disc.position)
  )
    return true;
  const origin = { ...actor.position };
  if (actor.fall) rescueFall(actor);
  actor.position = { ...disc.position };
  actor.previous = { ...disc.position };
  actor.velocity = v();
  actor.stored = v();
  actor.phaseOrigin = undefined;
  actor.dashTime = 0;
  actor.attackCooldown = 0;
  stopAiming(actor);
  breakDisguise(actor);
  for (const other of state.actors)
    if (
      other.id !== actor.id &&
      other.alive &&
      distance(other.position, actor.position) < RULES.playerRadius * 1.8
    ) {
      other.killerId = actor.id;
      other.killerType = 'Telefrag';
      other.killerTimer = 0;
      damageActor(state, other, actor.id, sub(other.position, origin), 'telefrag');
    }
  state.zones = state.zones.filter(
    (zone) => zone.ownerId !== actor.id || distance(zone.position, actor.position) > 4,
  );
  // Disc.Explode removes an explosive projectile; it is not Grenade.Explode.
  recoverDisc(state, disc, !disc.explosive);
  state.events.push({
    type: 'teleport',
    position: origin,
    destination: { ...actor.position },
    actorId: actor.id,
    entityType: 'actor',
  });
  return true;
}

/** Actor.CollisionEnter2D, locomotion branch. */
function respondToActor(actor: Actor, normal: Vec2, other: Actor): void {
  if (!actor.alive) return;
  const slide = actor.slideFactor ?? 1;
  const stored = actor.stored ?? actor.velocity;
  const otherStored = other.stored ?? other.velocity;
  if (!isLunging(actor)) actor.velocity = mul(reflect(stored, normal), slide);
  const reflected = reflect(sub(stored, otherStored), normal);
  const C = NATIVE.combat;
  if (!isDashing(actor)) {
    if (isDashing(other)) {
      stopAiming(actor);
      stopLunge(actor);
      startPushback(
        actor,
        mul(normalize(otherStored), C.actorDashPush),
        C.actorDashPushTime,
        C.actorDashStun,
      );
    } else {
      actor.velocity = add(actor.velocity, mul(otherStored, slide));
      startPushback(actor, reflected, C.actorBumpTime);
    }
  } else if (isDashing(other)) {
    startPushback(actor, mul(reflected, 0.75), C.actorBumpTime, C.actorDashBumpStun);
  } else {
    // A dash that hits an actor is cut to its last third.
    actor.dashTime = Math.min(actor.dashTime, A.dashDuration * (1 - 0.66));
    actor.velocity = v();
  }
}

/** Actor.GetMoveSpeed (Web units). */
function moveSpeed(state: GameState, actor: Actor, dt: number): number {
  let amount = actor.disarmed && !actor.armed ? A.walkDisarmed : A.walk;
  if (actor.powers.includes('haste')) amount *= A.hasteFactor;
  if (actor.aiming) amount = 0;
  else if (actor.aimMoveLag > 0) {
    actor.aimMoveLag = Math.max(0, actor.aimMoveLag - dt * A.aimMoveLagRate);
    amount *= 1 - easeOut(actor.aimMoveLag);
  }
  if ((actor.retrieveCharge ?? 0) > 0)
    amount = state.discs.some(
      (disc) => !disc.dead && disc.ownerId === actor.id && disc.powers?.includes('controlled'),
    )
      ? A.controlledWalk
      : 0;
  if (actor.slowed) amount *= 0.33;
  return amount;
}

/** Sweeps the actor's displacement against other living actors. */
function actorContact(
  state: GameState,
  actor: Actor,
  delta: Vec2,
): { other: Actor; t: number } | null {
  if (actor.phaseOrigin && isDashing(actor)) return null;
  let best: { other: Actor; t: number } | null = null;
  for (const other of state.actors) {
    if (other === actor || !other.alive || other.fall) continue;
    if (other.phaseOrigin && isDashing(other)) continue;
    // Already overlapping pairs are separated positionally, not as a new contact.
    if (distance(actor.position, other.position) < RULES.playerRadius * 2 - 1e-6) continue;
    const hit = segmentCircle(actor.position, delta, other.position, RULES.playerRadius * 2);
    if (hit && hit.t <= 1 && (!best || hit.t < best.t)) best = { other, t: hit.t };
  }
  return best;
}

/** Actor.FixedUpdate: forces, rotation, drag, speed limit and collision. */
export function tickActorMotion(
  state: GameState,
  actor: Actor,
  command: Command,
  dt: number,
): void {
  actor.previous = { ...actor.position };
  if (!actor.alive) return;
  for (const table of [actor.deflectedDiscs, actor.deflectedMelees])
    if (table)
      for (const key of Object.keys(table)) {
        const id = Number(key);
        if (--table[id] <= 0) delete table[id];
      }
  actor.wetFloor =
    state.arena.surfaces?.some(
      (surface) => surface.kind === 'ice' && shapeContains(surface, actor.position),
    ) ?? false;
  if (actor.wetFloor && (actor.dashTime <= 0 || actor.dashTime < A.dashDuration * 0.2)) {
    actor.slideFactor = A.wetSlide;
    actor.surfaceDrag = A.wetDrag;
  } else if (1 - (actor.slideFactor ?? 1) < 0.1) {
    actor.slideFactor = 1;
    actor.surfaceDrag = A.drag;
  } else {
    const t = Math.min(1, dt * 7);
    actor.slideFactor = (actor.slideFactor ?? 1) + (1 - (actor.slideFactor ?? 1)) * t;
    actor.surfaceDrag =
      (actor.surfaceDrag ?? A.drag) + (A.drag - (actor.surfaceDrag ?? A.drag)) * t;
  }
  const frozen = (actor.frozenTime ?? 0) > 0;
  const drag = frozen ? A.frozenDrag : (actor.surfaceDrag ?? A.drag);
  const slide = actor.slideFactor ?? 1;
  const hasted = actor.powers.includes('haste');
  const movement = clampLength(mul(command.move, (actor.reverseTime ?? 0) > 0 ? -1 : 1), 1);
  const moving = length(movement) > 0;
  const walkable = canWalk(actor);
  // Actor.CalculateWalk: rotation memory updates even when walking is blocked.
  if (walkable) {
    if (moving) {
      actor.lastMove = normalize(movement);
      actor.turning = true;
    } else actor.aimMoveLag = 0;
  }
  actor.controlDirection = { ...movement };

  // Pushback: the source multiplies this force by fixedDeltaTime twice.
  if ((actor.pushTime ?? 0) > 0 && !actor.fall) {
    const amount = (actor.pushStrength ?? 0) * ((actor.pushTime ?? 0) / (actor.pushDuration || 1));
    actor.pushTime = Math.max(0, (actor.pushTime ?? 0) - dt);
    actor.velocity = add(actor.velocity, mul(actor.pushDirection ?? v(), amount * dt * dt * slide));
  } else {
    actor.pushTime = 0;
    actor.pushStrength = 0;
  }
  if (walkable && actor.stun <= 0 && !frozen && moving)
    actor.velocity = add(actor.velocity, mul(movement, moveSpeed(state, actor, dt) * dt * slide));
  else if (walkable) moveSpeed(state, actor, dt);
  if (isDashing(actor)) {
    const elapsed = A.dashDuration - actor.dashTime;
    const force = A.dashForce * (hasted ? 1.25 : 1) * (1 - easeIn(elapsed / A.dashDuration));
    actor.velocity = add(actor.velocity, mul(actor.dashDirection, force * dt * slide));
  }
  // Actor.CooldownDash follows the dash force; walking resumes on the next step.
  actor.dashCooldown = Math.max(0, actor.dashCooldown - dt - 1e-12);
  if (actor.lungeTime > 0) {
    const t = actor.lungeTime / A.lungeDuration;
    const force = A.lungeForce * t * t * t;
    actor.velocity = add(actor.velocity, mul(actor.facing, force * dt * slide));
    actor.lungeTime = Math.max(0, actor.lungeTime - dt - 1e-12);
  }
  // Actor rotation follows the remembered input, or faces the attacker when stunned.
  if (walkable && !frozen) {
    // A released stick still finishes its turn; a stale memory never overrides facing.
    const target =
      actor.stun > 0 && actor.stunDirection
        ? actor.stunDirection
        : actor.turning
          ? actor.lastMove
          : undefined;
    if (target && length(target) > 1e-6) {
      const angle = angleBetween(actor.facing, normalize(target));
      actor.facing = normalize(rotate(actor.facing, angle * Math.min(1, dt * A.turnRate)));
      if (Math.abs(angle) < 1e-4 && !moving) actor.turning = false;
    }
  }
  if (actor.charge > 0.05) {
    actor.facingHistory.push(intendedDirection(actor, movement));
    if (actor.facingHistory.length > 10) actor.facingHistory.shift();
  }

  // Actor.MoveActor.
  actor.velocity = mul(actor.velocity, Math.max(0, 1 - drag * dt));
  actor.velocity = clampLength(actor.velocity, A.speedLimit * (isDashing(actor) ? 2 : 1));
  const delta = mul(actor.velocity, dt);
  const contact = length(delta) > 0 ? actorContact(state, actor, delta) : null;
  const phasing = actor.phaseOrigin !== undefined && isDashing(actor);
  let next: Vec2;
  if (contact) {
    const normal = normalize(
      sub(add(actor.position, mul(delta, contact.t)), contact.other.position),
    );
    respondToActor(actor, normal, contact.other);
    respondToActor(contact.other, normalize(sub(contact.other.position, actor.position)), actor);
    // The source returns a displacement here that MoveActor multiplies by dt again.
    const toContact = sub(mul(delta, contact.t), mul(normalize(delta), 0.01 * NATIVE.scale));
    next = moveAndSlide(state.arena, actor.position, mul(toContact, dt), RULES.playerRadius);
  } else if (phasing) next = add(actor.position, delta);
  else {
    next = moveAndSlide(state.arena, actor.position, delta, RULES.playerRadius);
    // Actor.CollideWithObstacles: the blocked normal component leaves the velocity.
    const moved = sub(next, actor.position);
    if (length(sub(moved, delta)) > 1e-6 && dt > 0) actor.velocity = mul(moved, 1 / dt);
  }
  // Gentle fall protection applies to walking; a dash can cross a gap or miss its landing.
  if (
    !actor.fall &&
    !isDashing(actor) &&
    actor.stun <= 0 &&
    (actor.pushTime ?? 0) <= 0 &&
    onGround(state.arena, actor.position, RULES.playerRadius * 0.45) &&
    !onGround(state.arena, next, RULES.playerRadius * 0.45)
  ) {
    const horizontal = v(next.x, actor.position.y),
      vertical = v(actor.position.x, next.y);
    next = onGround(state.arena, horizontal, RULES.playerRadius * 0.45)
      ? horizontal
      : onGround(state.arena, vertical, RULES.playerRadius * 0.45)
        ? vertical
        : { ...actor.position };
  }
  actor.position = next;
  actor.stored = { ...actor.velocity };
  actor.dashTime = Math.max(0, actor.dashTime - dt - 1e-12);
  if (actor.phaseOrigin && actor.dashTime <= 0) {
    if (traceObstacles(state.arena, actor.position, v(), 0.3 * NATIVE.scale)) {
      actor.dashTime = A.dashDuration * 0.4;
      if (actor.dashCooldown < actor.dashTime) actor.dashCooldown = A.dashDuration;
    } else actor.phaseOrigin = undefined;
  }
  tickFall(state, actor, dt);
  tickActorBoundary(state, actor, dt);
}

/** Disguise.Update runs after PlayerInput, so a fresh aim or move reveals at once. */
export function tickActorDisguise(state: GameState, actor: Actor, dt: number): void {
  const canDisguise =
    actor.alive &&
    actor.powers.includes('disguise') &&
    !actor.fall &&
    actor.stun <= 0 &&
    actor.dashTime <= 0 &&
    !isLunging(actor) &&
    actor.charge <= 0 &&
    !actor.recalling &&
    actor.attackTime <= 0 &&
    (actor.burnTime ?? 0) <= 0 &&
    length(actor.velocity) < 5.5 * NATIVE.scale;
  if (!canDisguise) breakDisguise(actor);
  else if (!actor.disguised && length(actor.velocity) < 0.5 * NATIVE.scale) {
    actor.disguiseTime = (actor.disguiseTime ?? 0) + dt;
    if (actor.disguiseTime >= 0.2 - 1e-10) {
      actor.disguised = true;
      state.events.push({ type: 'disguise', position: { ...actor.position }, actorId: actor.id });
    }
  }
}

function chipIce(actor: Actor): void {
  if ((actor.freezeChipCooldown ?? 0) > 0) return;
  actor.frozenTime = Math.max(0, (actor.frozenTime ?? 0) - 7 / 12);
  actor.freezeChipCooldown = 0.2;
}

/** Actor.Dash. */
function tryDash(state: GameState, actor: Actor, command: Command): boolean {
  if (!actor.alive) return false;
  if ((actor.frozenTime ?? 0) > 0) {
    chipIce(actor);
    return false;
  }
  if (actor.stun > 0 || isLunging(actor)) return false;
  if (tryTeleport(state, actor)) {
    spawnDecoy(state, actor);
    return true;
  }
  if (actor.dashCooldown > 0) return false;
  if (actor.fall && !rescueFall(actor)) return false;
  breakDisguise(actor);
  const hasted = actor.powers.includes('haste');
  const movement = clampLength(mul(command.move, (actor.reverseTime ?? 0) > 0 ? -1 : 1), 1);
  actor.dashDirection = length(movement) > 0 ? normalize(movement) : { ...actor.facing };
  stopAiming(actor, length(movement) > 0);
  actor.dashTime = A.dashDuration * (hasted ? 0.8 : 1);
  actor.dashCooldown = A.dashCooldown * (hasted ? 0.6 : 1);
  actor.velocity = add(
    actor.velocity,
    mul(actor.dashDirection, A.speedLimit * A.dashImpulseFactor),
  );
  actor.stored = mul(actor.velocity, Math.max(0, 1 - A.drag * RULES.dt));
  actor.facing = { ...actor.dashDirection };
  actor.lastMove = { ...actor.dashDirection };
  actor.turning = false;
  if (actor.powers.includes('wallDash')) actor.phaseOrigin = { ...actor.position };
  state.events.push({ type: 'dash', position: { ...actor.position }, actorId: actor.id });
  spawnDecoy(state, actor);
  return true;
}

/** Player.Attack → Actor.Attack. Unarmed attacks are disarms. */
function tryAttack(state: GameState, actor: Actor, command: Command): boolean {
  if (!actor.alive || actor.fall || actor.stun > 0 || actor.aiming) return false;
  const held = heldDiscs(actor);
  if ((actor.attacksLeft ?? held) <= 0 && (held > 0 || (actor.disarmsLeft ?? 1) <= 0)) return false;
  breakDisguise(actor);
  if ((actor.frozenTime ?? 0) > 0) {
    chipIce(actor);
    return true;
  }
  if (actor.phaseOrigin && traceObstacles(state.arena, actor.position, v(), 0.3 * NATIVE.scale))
    return false;
  if (held > 0) actor.retrieveCharge = 0;
  actor.coolingAttack = true;
  actor.attackCooldown = A.attackCooldown;
  // Actor.Attack: cancel a dash, refunding its unused time.
  stopDash(actor);
  const movement = clampLength(mul(command.move, (actor.reverseTime ?? 0) > 0 ? -1 : 1), 1);
  const direction = canWalk(actor) ? intendedDirection(actor, movement) : { ...actor.facing };
  actor.facing = direction;
  actor.lastMove = { ...direction };
  actor.turning = false;
  actor.attackTime = A.meleeDuration;
  actor.lungeTime = A.lungeDuration;
  actor.lungeRecovery = A.lungeCooldown;
  const slide = actor.slideFactor ?? 1;
  actor.velocity = add(actor.velocity, mul(direction, A.speedLimit * A.lungeImpulseFactor * slide));
  actor.stored = mul(actor.velocity, Math.max(0, 1 - A.drag * RULES.dt));
  actor.attackSerial++;
  actor.hitTargets = [];
  actor.meleeContacts = [];
  actor.disarmContacts = [];
  if (held > 0) {
    actor.attackArmed = true;
    actor.disarmsLeft = 0;
    actor.attacksLeft = (actor.attacksLeft ?? held) - 1;
  } else {
    actor.attackArmed = false;
    actor.lungeRecovery *= A.disarmLungeFactor;
    actor.disarmsLeft = (actor.disarmsLeft ?? 1) - 1;
    actor.attacksLeft = 0;
  }
  state.events.push({
    type: 'slash',
    position: { ...actor.position },
    actorId: actor.id,
    value: held > 0 ? 1 : 0,
  });
  return true;
}

/** Player.TryThrow; the projectile itself is created by Disc.StartThrow. */
export function throwDisc(state: GameState, actor: Actor): boolean {
  breakDisguise(actor);
  const held = heldDiscs(actor);
  if (
    !actor.alive ||
    (actor.attacksLeft ?? held) <= 0 ||
    actor.stun > 0 ||
    (actor.frozenTime ?? 0) > 0 ||
    held <= 0 ||
    (actor.retrieveCharge ?? 0) !== 0
  )
    return false;
  actor.attacksLeft = (actor.attacksLeft ?? held) - 1;
  launchDisc(
    state,
    actor,
    aimPower(actor),
    spinAngle(actor),
    canWalk(actor) ? intendedDirection(actor, actor.controlDirection ?? v()) : actor.facing,
  );
  return true;
}

/**
 * External-agent aim (the MUNDI bridge sets rotation before each frame). Facing
 * snaps to the aim while the actor is alive, standing and not stunned; the
 * normal turn then eases back toward the last movement, and throws still follow
 * that movement, exactly as Actor rotation and Player.ThrowDisc do.
 */
export function applyAim(actor: Actor, aim: Vec2): void {
  if (length(aim) <= 0.01 || !actor.alive || actor.fall || actor.stun > 0) return;
  actor.facing = normalize(aim);
  actor.turning = true;
}

/** Player.lastInputMove: current input, else a turn still in progress, else facing. */
function intendedDirection(actor: Actor, movement: Vec2): Vec2 {
  if (length(movement) > 0) return normalize(movement);
  if (actor.turning && actor.lastMove && length(actor.lastMove) > 0)
    return normalize(actor.lastMove);
  return { ...actor.facing };
}

/** Player.ThrowDisc: signed degrees between the current aim and the oldest queued aim. */
function spinAngle(actor: Actor): number {
  const old = actor.facingHistory[0];
  const current = intendedDirection(actor, actor.controlDirection ?? v());
  if (!old || length(current) < 1e-6 || length(old) < 1e-6) return 0;
  const a = normalize(current),
    b = normalize(old);
  let angle = (dacos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
  if (a.x * b.y - a.y * b.x < 0) angle = -angle;
  return Math.max(-90, Math.min(90, angle));
}

/** Player.Aim: charge with a held weapon, or retrieve an owned one with empty hands. */
function aim(state: GameState, actor: Actor, dt: number): void {
  breakDisguise(actor);
  const held = heldDiscs(actor);
  if (held > 0 && (actor.retrieveCharge ?? 0) === 0 && (actor.frozenTime ?? 0) <= 0)
    actor.charge = Math.min(RULES.chargeTime, actor.charge + dt);
  if (actor.charge >= RULES.aimStart) actor.aiming = true;
  const owned = ownedWeapons(state, actor);
  if (actor.charge === 0 && !isDashing(actor) && !isLunging(actor) && owned > 0 && held < 2) {
    if ((actor.retrieveCharge ?? 0) < NATIVE.disc.retrieveMax)
      actor.retrieveCharge = (actor.retrieveCharge ?? 0) + dt * NATIVE.disc.retrieveRate;
  } else if ((owned === 0 || held > 1) && (actor.retrieveCharge ?? 0) > 0) {
    actor.retrieveCharge = 0;
    if (actor.inputHeld) {
      actor.throwBlocked = true;
      actor.inputHeld = false;
    }
  }
}

function remember(actor: Actor, kind: 'attack' | 'throw' | 'dash'): void {
  actor.inputBuffer ??= [];
  if (actor.inputBuffer.length === 8) actor.inputBuffer.shift();
  actor.inputBuffer.push({ kind, age: 0 });
}

/** PlayerInput.Update: fresh melee, throw release, held aim, dash, then buffered retries. */
export function tickActorInput(state: GameState, actor: Actor, command: Command, dt: number): void {
  if (!actor.alive) return;
  // Buffered entries age in scaled time (TimeKeeper.timeCounter differences).
  for (const entry of actor.inputBuffer ?? []) entry.age += dt;
  actor.inputHeld = command.throwHeld;
  const ready = !actor.fall;
  const attempt = (kind: 'attack' | 'throw' | 'dash'): boolean =>
    kind === 'attack'
      ? tryAttack(state, actor, command)
      : kind === 'throw'
        ? throwDisc(state, actor)
        : tryDash(state, actor, command);
  if (ready) {
    if (command.attack) {
      if (attempt('attack')) actor.inputBuffer = [];
      else remember(actor, 'attack');
    }
    if (command.throwReleased && !actor.throwBlocked) {
      if (attempt('throw')) actor.inputBuffer = [];
      else if (ownedWeapons(state, actor) === 0) remember(actor, 'throw');
    } else if (command.throwReleased) actor.throwBlocked = false;
    if (actor.inputHeld && !actor.throwBlocked) aim(state, actor, dt);
  }
  if (command.dash) {
    if (attempt('dash')) actor.inputBuffer = [];
    else remember(actor, 'dash');
  }
  if (command.throwReleased) stopAiming(actor, length(command.move) > 0);
  if (!command.throwHeld && !command.throwReleased) {
    // Releasing outside a frame (pause, control change) leaves no stale charge.
    if (actor.charge > 0 || (actor.retrieveCharge ?? 0) > 0) stopAiming(actor);
    actor.throwBlocked = false;
  }
  actor.recalling = (actor.retrieveCharge ?? 0) > 0;
  // Retrieving a controlled-power disc steers it instead (Actor.controlledDisc).
  actor.controlling =
    actor.recalling &&
    state.discs.some(
      (disc) => !disc.dead && disc.ownerId === actor.id && disc.powers?.includes('controlled'),
    );
  // Mirrors of the buffered actions for older readers.
  actor.bufferedAttack = 0;
  actor.bufferedDash = 0;
  if (command.attack || command.dash || !ready || !actor.alive) return;
  for (const failed of actor.inputBuffer ?? []) {
    const limit = failed.kind === 'dash' ? RULES.dashBuffer : RULES.attackBuffer;
    if (failed.age > limit + 1e-9) continue;
    if (failed.kind === 'throw' && (actor.throwBlocked || ownedWeapons(state, actor) > 0)) continue;
    if (attempt(failed.kind)) {
      actor.inputBuffer = [];
      return;
    }
  }
  for (const failed of actor.inputBuffer ?? []) {
    const remaining = (failed.kind === 'dash' ? RULES.dashBuffer : RULES.attackBuffer) - failed.age;
    if (remaining <= 0) continue;
    if (failed.kind === 'dash') actor.bufferedDash = Math.max(actor.bufferedDash, remaining);
    else if (failed.kind === 'attack')
      actor.bufferedAttack = Math.max(actor.bufferedAttack, remaining);
  }
}

/** Actor/Player Update timers, killer attribution and the attack budget. */
export function tickActorTimers(actor: Actor, dt: number): void {
  if (!actor.alive) return;
  actor.stun = Math.max(0, actor.stun - dt - 1e-12);
  if (actor.stun <= 0) actor.stunDirection = undefined;
  const wasInvulnerable = actor.invulnerable > 0;
  actor.invulnerable = Math.max(0, actor.invulnerable - dt - 1e-12);
  if (wasInvulnerable && actor.invulnerable <= 0) actor.justVulnerable = true;
  if (actor.killerId !== undefined && actor.killerId !== actor.id) {
    if ((actor.killerTimer ?? 0) > 0) actor.killerTimer = (actor.killerTimer ?? 0) - dt;
    else {
      actor.killerId = actor.id;
      actor.killerType = 'Suicide';
      actor.killerTimer = 0;
    }
  }
  if (actor.attackCooldown > 0)
    actor.attackCooldown = Math.max(0, actor.attackCooldown - dt - 1e-12);
  else actor.coolingAttack = false;
  actor.attackTime = Math.max(0, actor.attackTime - dt - 1e-12);
  actor.lungeRecovery = Math.max(0, actor.lungeRecovery - dt - 1e-12);
  const held = heldDiscs(actor);
  if (held > 0) actor.disarmed = false;
  if (!actor.coolingAttack) {
    actor.attacksLeft = held;
    actor.disarmsLeft = 1;
  }
}

/** One frame for a single actor; Game.step interleaves these phases across actors. */
export function tickActor(state: GameState, actor: Actor, command: Command, dt: number): void {
  tickActorMotion(state, actor, command, dt);
  tickActorInput(state, actor, command, dt);
  tickActorTimers(actor, dt);
  tickActorDisguise(state, actor, dt);
}
