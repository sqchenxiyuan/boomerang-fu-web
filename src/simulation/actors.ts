import { moveAndSlide, onGround } from '../core/collision';
import { RULES } from '../core/config';
import {
  add,
  angleBetween,
  clampLength,
  length,
  mul,
  normalize,
  rotate,
  sub,
  v,
} from '../core/math';
import type { Actor, Command, GameState } from '../core/types';
import { damageActor } from './combat';
import { throwDisc } from './projectiles';

export function tickActor(state: GameState, actor: Actor, command: Command, dt: number): void {
  actor.previous = { ...actor.position };
  if (!actor.alive) return;
  const hasted = actor.powers.includes('haste');
  const decrease = (remaining: number): number => Math.max(0, remaining - dt - 1e-12);
  actor.dashCooldown = decrease(actor.dashCooldown);
  actor.attackCooldown = decrease(actor.attackCooldown);
  actor.attackTime = decrease(actor.attackTime);
  actor.lungeRecovery = decrease(actor.lungeRecovery);
  actor.stun = decrease(actor.stun);
  actor.invulnerable = decrease(actor.invulnerable);
  actor.bufferedDash = decrease(actor.bufferedDash);
  actor.bufferedAttack = decrease(actor.bufferedAttack);
  const movement = clampLength(command.move, 1);
  const clearBuffer = (): void => {
    actor.bufferedDash = 0;
    actor.bufferedAttack = 0;
  };
  const stopAim = (): void => {
    if (actor.charge >= RULES.aimStart && length(movement) > 0) actor.aimMoveLag = 1;
    actor.charge = 0;
    actor.recalling = false;
    actor.facingHistory = [];
  };
  const tryAttack = (): boolean => {
    if (actor.stun > 0 || actor.attackCooldown > 0 || actor.charge >= RULES.aimStart) return false;
    // A slash can cancel a dash, but cannot rotate while the dash recovery owns movement.
    if (actor.dashCooldown <= 0 && actor.lungeRecovery <= 0 && length(movement) > 0)
      actor.facing = normalize(movement);
    actor.dashCooldown = Math.max(0, actor.dashCooldown - actor.dashTime);
    actor.dashTime = 0;
    actor.attackTime = RULES.attackDuration;
    actor.attackCooldown = RULES.attackCooldown;
    actor.lungeTime = RULES.lungeDuration;
    actor.lungeRecovery = RULES.lungeRecovery * (actor.armed ? 1 : 0.85);
    actor.attackSerial++;
    actor.attackArmed = actor.armed;
    actor.hitTargets = [];
    stopAim();
    actor.throwBlocked ||= command.throwHeld;
    actor.velocity = add(actor.velocity, mul(actor.facing, RULES.lungeImpulse));
    clearBuffer();
    state.events.push({
      type: 'slash',
      position: { ...actor.position },
      actorId: actor.id,
      value: actor.armed ? 1 : 0,
    });
    return true;
  };
  const tryDash = (): boolean => {
    if (actor.stun > 0 || actor.dashCooldown > 0 || actor.lungeRecovery > 0) return false;
    actor.dashTime = RULES.dashDuration * (hasted ? 0.8 : 1);
    actor.dashCooldown = RULES.dashCooldown * (hasted ? 0.6 : 1);
    actor.dashDirection = length(movement) > 0 ? normalize(movement) : { ...actor.facing };
    actor.facing = { ...actor.dashDirection };
    stopAim();
    actor.throwBlocked ||= command.throwHeld;
    actor.velocity = add(actor.velocity, mul(actor.dashDirection, RULES.dashImpulse));
    clearBuffer();
    state.events.push({ type: 'dash', position: { ...actor.position }, actorId: actor.id });
    return true;
  };
  if (actor.stun <= 0) {
    // PlayerInput.Update evaluates fresh melee, throw release, held aim, then dash.
    if (command.attack && !tryAttack()) actor.bufferedAttack = RULES.attackBuffer;
    if (command.throwReleased) {
      if (!actor.throwBlocked) {
        if (actor.dashCooldown <= 0 && actor.lungeRecovery <= 0 && length(movement) > 0)
          actor.facing = normalize(movement);
        const heldCharge = actor.charge;
        if (throwDisc(state, actor)) clearBuffer();
        if (heldCharge >= RULES.aimStart && length(movement) > 0) actor.aimMoveLag = 1;
      }
      actor.throwBlocked = false;
      stopAim();
    }
    actor.recalling =
      command.throwHeld &&
      !actor.throwBlocked &&
      !actor.armed &&
      actor.dashTime <= 0 &&
      actor.lungeRecovery <= 0 &&
      state.discs.some((disc) => disc.ownerId === actor.id && !disc.dead);
    if (
      command.throwHeld &&
      !actor.throwBlocked &&
      actor.armed &&
      actor.dashTime <= 0 &&
      actor.lungeRecovery <= 0
    )
      actor.charge = Math.min(RULES.chargeTime, actor.charge + dt);
    if (command.dash && !tryDash()) actor.bufferedDash = RULES.dashBuffer;
    if (!command.dash && !command.attack && !command.throwReleased) {
      // Two retained action slots, ordered by age; the original keeps an eight-entry queue.
      const dashFirst =
        actor.bufferedDash > 0 &&
        (actor.bufferedAttack <= 0 ||
          RULES.dashBuffer - actor.bufferedDash >= RULES.attackBuffer - actor.bufferedAttack);
      if (dashFirst) {
        if (!tryDash() && actor.bufferedAttack > 0) tryAttack();
      } else if (actor.bufferedAttack > 0) {
        if (!tryAttack() && actor.bufferedDash > 0) tryDash();
      }
    }
    if (!command.throwHeld && !command.throwReleased) {
      stopAim();
      actor.throwBlocked = false;
    }
  } else {
    if (command.attack) actor.bufferedAttack = RULES.attackBuffer;
    if (command.dash) actor.bufferedDash = RULES.dashBuffer;
    stopAim();
  }

  const isDashing = actor.dashTime > 0;
  const canMove = actor.stun <= 0 && actor.dashCooldown <= 0 && actor.lungeRecovery <= 0;
  if (canMove) {
    if (length(movement) > 0) {
      actor.facing = rotate(
        actor.facing,
        angleBetween(actor.facing, normalize(movement)) * Math.min(1, dt * RULES.turningSpeed),
      );
    } else actor.aimMoveLag = 0;
    let force = (actor.armed ? RULES.walkForce : RULES.unarmedWalkForce) * (hasted ? 1.4 : 1);
    if (actor.charge >= RULES.aimStart || actor.recalling) force = 0;
    else if (actor.aimMoveLag > 0) {
      actor.aimMoveLag = Math.max(0, actor.aimMoveLag - dt / RULES.aimMoveRecovery);
      force *= 1 - Math.sin((Math.PI / 2) * actor.aimMoveLag);
    }
    actor.velocity = add(actor.velocity, mul(movement, force * dt));
  }
  if (actor.charge > RULES.aimStart * 0.5) {
    actor.facingHistory.push(length(movement) > 0 ? normalize(movement) : { ...actor.facing });
    if (actor.facingHistory.length > 10) actor.facingHistory.shift();
  }
  if (isDashing) {
    const elapsed = RULES.dashDuration - actor.dashTime;
    const force =
      RULES.dashForce *
      (hasted ? 1.25 : 1) *
      Math.cos((Math.PI / 2) * (elapsed / RULES.dashDuration));
    actor.velocity = add(actor.velocity, mul(actor.dashDirection, force * dt));
  }
  if (actor.lungeTime > 0) {
    const force = RULES.lungeForce * (actor.lungeTime / RULES.lungeDuration) ** 3;
    actor.velocity = add(actor.velocity, mul(actor.facing, force * dt));
  }
  actor.velocity = clampLength(
    mul(actor.velocity, Math.max(0, 1 - RULES.damping * dt)),
    RULES.speedLimit * (isDashing ? 2 : 1),
  );
  let next = moveAndSlide(state.arena, actor.position, mul(actor.velocity, dt), RULES.playerRadius);
  // Gentle fall protection applies to walking; a dash can cross a gap or miss its landing.
  if (
    !isDashing &&
    actor.stun <= 0 &&
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
  actor.dashTime = decrease(actor.dashTime);
  actor.lungeTime = decrease(actor.lungeTime);
  if (!onGround(state.arena, actor.position) && actor.dashTime <= 0)
    damageActor(state, actor, actor.id, v(), 'fall');
  if (length(actor.position) > state.safeRadius && actor.alive)
    damageActor(state, actor, actor.id, normalize(sub(v(), actor.position)), 'boundary');
}
