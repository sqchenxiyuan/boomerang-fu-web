import { lineOfSight, segmentCircle, sweepPaths, traceObstacles } from '../core/collision';
import { NATIVE, RULES } from '../core/config';
import {
  add,
  clampLength,
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
import type { Vec2 } from '../core/math';
import type { Actor, Disc, DiscMovement, GameState, PowerupKind } from '../core/types';
import {
  breakCrate,
  circleTouchesPolygon,
  explode,
  lineBlocked,
  meleeCenter,
  meleePolygon,
  triggerDamage,
  triggerDiscParry,
  triggerShieldDisc,
} from './combat';
import { tracePortal, teleportDisc } from './portals';
import { grantDisc, heldDiscs, recoverDisc, setHeldDiscs } from './inventory';
import { addZone, hitDecoy } from './status-effects';
import { strikeEnvironment } from './environment';
import { clockOf, slowMo } from './clock';
import { startPushback } from './actors';
export { throwDisc } from './actors';

/*
 * Disc physics and state machine from the reference Disc.cs / Projectile.cs
 * simulation: forces are integrated with mass .6 and drag 2.8, the throw force
 * eases out over .45 s, spin and homing steer without adding speed, returning
 * discs accelerate toward their owner, and settled discs can become public.
 */
const D = NATIVE.disc;
const U = NATIVE.scale;
const easeIn = (t: number): number => 1 - Math.cos((Math.PI / 2) * t);
const cubicOut = (t: number): number => 1 + (t - 1) ** 3;
const quartOut = (t: number): number => 1 - (t - 1) ** 4;
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
const deg = Math.PI / 180;
/** Projectile.Force: value / mass × fixedDeltaTime, or an impulse without dt. */
const force = (value: Vec2, dt: number): Vec2 => mul(value, dt / D.mass);
const has = (disc: Disc, power: PowerupKind): boolean => disc.powers?.includes(power) ?? false;
const justDeflected = (disc: Disc): boolean => (disc.deflectedTimer ?? 0) > 0;
const ownerOf = (state: GameState, disc: Disc): Actor | undefined =>
  disc.ownerId >= 0 ? state.actors.find((actor) => actor.id === disc.ownerId) : undefined;
const retrieveOf = (owner: Actor | undefined): number =>
  owner?.alive ? (owner.retrieveCharge ?? 0) : 0;

function setMovement(disc: Disc, movement: DiscMovement): void {
  if (disc.movement !== movement) disc.stateTime = 0;
  disc.movement = movement;
  disc.state =
    movement === 'returning'
      ? 'returning'
      : movement === 'dropped' || movement === 'squished'
        ? 'dropped'
        : 'outbound';
}

/** Fills reference fields for discs built by older code paths or snapshots. */
function ensureDisc(disc: Disc): void {
  disc.movement ??=
    disc.state === 'returning' ? 'returning' : disc.state === 'dropped' ? 'dropped' : 'throwing';
  disc.stored ??= { ...disc.velocity };
  disc.speedLimit ??= D.speedLimit;
  disc.throwDuration ??= D.throwDuration;
  disc.throwTimer ??= disc.movement === 'throwing' ? 0 : disc.throwDuration;
  disc.throwStrength ??= disc.movement === 'throwing' ? D.throwSpeed : 0;
  disc.throwDirection ??= length(disc.velocity) > 0 ? normalize(disc.velocity) : v(0, -1);
  disc.spinAngle ??= 0;
  disc.spinTimer ??= 0;
  disc.spinning ??= true;
  disc.returnTimer ??= 0;
  disc.returnDirection ??= v();
  disc.freeStrength ??= 0;
  disc.homingRadius ??= D.homingKeyboard;
  disc.canHome ??= true;
  disc.canReturn ??= !disc.explosive;
  disc.canBeControlled ??= true;
  disc.controlledFactor ??= 0;
  disc.canCollideWithOwner ??= disc.movement !== 'throwing';
  disc.startedDropped ??= false;
  disc.deflectedTimer ??= 0;
  disc.pickable ??= !disc.explosive;
  disc.colliderDisabled ??= 0;
  disc.projectile ??= disc.movement !== 'dropped' && disc.movement !== 'squished';
  disc.damageContacts ??= [];
  disc.shieldContacts ??= [];
  disc.meleeContacts ??= [];
}

function baseDisc(
  state: GameState,
  owner: Actor,
  position: Vec2,
  direction: Vec2,
  powers: readonly PowerupKind[],
  mini: boolean,
  groupId?: number,
): Disc {
  const id = state.nextId++;
  return {
    id,
    groupId: groupId ?? id,
    powers: [...powers],
    mini,
    ownerId: owner.id,
    damageOwnerId: owner.id,
    position: { ...position },
    previous: { ...position },
    velocity: v(),
    stored: v(),
    state: 'outbound',
    movement: 'throwing',
    age: 0,
    stateTime: 0,
    charge: 0,
    curve: 0,
    bounces: 0,
    explosive: powers.includes('explosive') && !powers.includes('multi'),
    fuse: 0,
    grace: 0,
    lastDeflector: -1,
    dead: false,
    speedLimit: D.speedLimit,
    throwTimer: 0,
    throwDuration: D.throwDuration,
    throwStrength: 0,
    throwDirection: { ...direction },
    spinAngle: 0,
    spinTimer: 0,
    spinning: true,
    returnTimer: 0,
    returnDirection: v(),
    freeStrength: 0,
    homingRadius: D.homingKeyboard,
    canHome: true,
    canReturn: true,
    canBeControlled: true,
    controlledFactor: 0,
    canCollideWithOwner: false,
    startedDropped: false,
    deflectedTimer: 0,
    pickable: true,
    colliderDisabled: 0,
    projectile: true,
    damageContacts: [],
    shieldContacts: [],
    meleeContacts: [],
  };
}

/** Disc.StartThrow. `reset` is used when a parry re-throws the owner's disc. */
export function startThrow(state: GameState, disc: Disc, reset = false, inherit = false): void {
  ensureDisc(disc);
  const owner = ownerOf(state, disc);
  setMovement(disc, 'throwing');
  disc.throwTimer = 0;
  const aim = disc.charge;
  disc.throwStrength = D.throwSpeed * (1 + aim);
  disc.homingRadius = D.homingKeyboard;
  disc.throwDuration = D.throwDuration;
  disc.controlledFactor = 0;
  if (!reset) {
    disc.speedLimit = disc.speedLimit! + disc.speedLimit! * aim * 0.5;
    disc.throwDuration -= aim * D.chargeDurationCut;
    disc.homingRadius += disc.homingRadius * aim;
  }
  if (disc.mini) disc.throwDuration = D.miniThrowDuration * (has(disc, 'explosive') ? 0.2 : 1);
  disc.velocity = mul(
    force(mul(disc.throwDirection!, disc.throwStrength), RULES.dt),
    D.throwVelocityFactor,
  );
  disc.stored = { ...disc.velocity };
  if (inherit && owner) disc.velocity = add(disc.velocity, owner.velocity);
}

function startReturn(disc: Disc): void {
  disc.canCollideWithOwner = true;
  setMovement(disc, 'returning');
  disc.returnTimer = 0;
}

/** Disc.StartFreeform: a weaponless slide that settles into a dropped disc. */
export function startFreeform(state: GameState, disc: Disc, boost = 0, stayDropped = false): void {
  ensureDisc(disc);
  const direction = normalize(disc.velocity);
  disc.freeStrength = length(disc.velocity) * D.bounciness;
  if (!stayDropped) setMovement(disc, 'free');
  if (boost !== 0) disc.velocity = add(disc.velocity, mul(direction, boost / D.mass));
  const owner = ownerOf(state, disc);
  if (owner && heldDiscs(owner) === 0) owner.disarmed = true;
}

function startDropped(state: GameState, disc: Disc): void {
  disc.startedDropped = true;
  disc.projectile = false;
  disc.velocity = mul(disc.throwDirection!, D.throwSpeed * 0.5);
  setMovement(disc, 'dropped');
  startFreeform(state, disc);
  disc.canBeControlled = false;
  disc.charge = 0;
  disc.spinAngle = 0;
  disc.curve = 0;
}

/** Projectile.Bounce. */
export function bounceDisc(state: GameState, disc: Disc, incoming: Vec2, normal: Vec2): void {
  ensureDisc(disc);
  const minimum = disc.speedLimit! * 0.05;
  if (length(incoming) < minimum) incoming = mul(normalize(incoming), minimum);
  disc.velocity = mul(reflect(incoming, normal), D.bounciness);
  if (disc.movement === 'throwing') {
    if (disc.throwTimer! > disc.throwDuration! * 0.1) disc.throwTimer! -= 0.01;
    disc.throwDirection = normalize(disc.velocity);
  }
  if (disc.movement === 'returning' && dot(disc.returnDirection!, normalize(incoming)) > 0.01)
    startFreeform(state, disc);
  disc.spinning = false;
  disc.controlledFactor = 0;
  const owner = ownerOf(state, disc);
  const retrieve = retrieveOf(owner);
  if (retrieve > 0)
    disc.velocity = sub(
      disc.velocity,
      force(
        mul(
          disc.returnDirection!,
          D.returnStrength * quartOut(retrieve) * (disc.movement === 'dropped' ? 0.33 : 0.66),
        ),
        RULES.dt,
      ),
    );
}

/* -------------------------------------------------------------- creation */

/** Player.ThrowDisc → Disc.Init. */
export function launchDisc(
  state: GameState,
  actor: Actor,
  aim: number,
  spinAngle: number,
  aimDirection: Vec2,
): Disc {
  const up = normalize(actor.facing);
  const origin = sub(actor.position, mul(up, 0.1 * U));
  let spawn = add(actor.position, mul(up, D.spawnOffset));
  const hit = traceObstacles(state.arena, origin, mul(up, 1.5 * U), D.colliderRadius);
  if (hit) spawn = sub(add(origin, mul(up, 1.5 * U * hit.t)), mul(up, 0.1 * U));
  const direction = length(aimDirection) > 0 ? normalize(aimDirection) : up;
  const disc = baseDisc(state, actor, spawn, direction, actor.powers, false);
  disc.charge = aim;
  disc.spinAngle = spinAngle;
  disc.curve = spinAngle * deg;
  startThrow(state, disc);
  if (disc.explosive) {
    disc.canReturn = false;
    disc.pickable = false;
    disc.canCollideWithOwner = false;
  }
  // Disc.Init dispatches StartThrow twice; only the second inherits the owner's velocity.
  startThrow(state, disc, false, true);
  if (disc.explosive) disc.fuse = RULES.explosionFuse;
  state.discs.push(disc);
  setHeldDiscs(actor, heldDiscs(actor) - 1);
  actor.disguised = false;
  actor.disguiseTime = 0;
  state.events.push({
    type: 'throw',
    position: { ...spawn },
    actorId: actor.id,
    value: aim,
  });
  return disc;
}

/** Player.DropDisc: a disarmed weapon slides away and later becomes public. */
export function dropDisc(state: GameState, actor: Actor, direction: Vec2): Disc | null {
  if (heldDiscs(actor) === 0) return null;
  const normal = normalize(direction);
  let reach = 0.75 * U;
  const origin = sub(actor.position, mul(normal, 0.1 * U));
  const hit = traceObstacles(state.arena, origin, mul(normal, reach), D.colliderRadius);
  if (hit)
    reach = Math.max(
      0,
      distance(add(origin, mul(normal, reach * hit.t)), actor.position) - 0.25 * U,
    );
  const disc = baseDisc(
    state,
    actor,
    add(actor.position, mul(normal, reach)),
    direction,
    actor.powers,
    false,
  );
  disc.explosive = false;
  startDropped(state, disc);
  startDropped(state, disc);
  state.discs.push(disc);
  setHeldDiscs(actor, heldDiscs(actor) - 1);
  return disc;
}

/** Player.MultidiscBurst: four or five mini discs fan out over 180°. */
function multidiscBurst(state: GameState, parent: Disc): void {
  const owner = ownerOf(state, parent);
  if (!owner) {
    parent.dead = true;
    return;
  }
  const explosive = has(parent, 'explosive');
  const count = explosive || has(parent, 'fire') ? 4 : 5;
  const direction = normalize(parent.velocity);
  const powers = (parent.powers ?? []).filter((power) => power !== 'multi');
  for (let index = 0; index < count; index++) {
    const angle = (-90 + (180 * index) / (count - 1)) * deg;
    const child = baseDisc(
      state,
      owner,
      parent.position,
      rotate(direction, angle),
      powers,
      true,
      parent.groupId ?? parent.id,
    );
    child.explosive = explosive;
    startThrow(state, child);
    if (explosive) {
      child.canReturn = false;
      child.pickable = false;
      child.canCollideWithOwner = false;
    }
    startThrow(state, child);
    if (explosive) child.fuse = 0.931 + index * 0.1;
    state.discs.push(child);
  }
  parent.dead = true;
  if (explosive) (owner.discRespawns ??= []).push(3.25);
  state.events.push({
    type: 'split',
    position: { ...parent.position },
    actorId: parent.ownerId,
    value: count,
  });
}

function detonate(state: GameState, disc: Disc): void {
  explode(state, disc.position, disc.damageOwnerId, disc.powers, disc.mini ? 0.5 : 1);
  disc.dead = true;
  const owner = state.actors.find((actor) => actor.id === disc.damageOwnerId);
  if (!disc.mini && owner?.alive) (owner.discRespawns ??= []).push(1.75);
}

/* ----------------------------------------------------------------- forces */

function endThrow(state: GameState, disc: Disc): void {
  if (disc.explosive) {
    startFreeform(state, disc);
    return;
  }
  if (has(disc, 'multi') && !disc.mini) {
    multidiscBurst(state, disc);
    return;
  }
  if (disc.canReturn && ownerOf(state, disc)) startReturn(disc);
  else startFreeform(state, disc);
  disc.throwTimer = disc.throwDuration;
  disc.throwStrength = 0;
}

function calculateThrow(state: GameState, disc: Disc, dt: number): Vec2 {
  if (disc.throwTimer! < disc.throwDuration!) {
    disc.throwTimer! += dt;
    const t = clamp01(disc.throwTimer! / disc.throwDuration!);
    return mul(disc.throwDirection!, disc.throwStrength! * (1 - easeIn(t)));
  }
  endThrow(state, disc);
  return v();
}

function towardOwner(disc: Disc, owner: Actor, dt: number): Vec2 {
  const direction = normalize(sub(owner.position, disc.position));
  return normalize(lerpV(normalize(disc.velocity), direction, Math.min(1, dt * 60)));
}

function calculateReturn(disc: Disc, owner: Actor, dt: number): Vec2 {
  disc.returnDirection = towardOwner(disc, owner, dt);
  let amount: number;
  if (disc.returnTimer! < disc.throwDuration!) {
    amount = D.returnStrength * easeIn(clamp01(disc.returnTimer! / disc.throwDuration!));
    disc.returnTimer! += dt;
  } else {
    disc.returnTimer = disc.throwDuration;
    amount = D.throwSpeed;
  }
  return mul(disc.returnDirection, amount);
}

function calculateRetrieve(disc: Disc, owner: Actor, dt: number): Vec2 {
  disc.returnDirection = towardOwner(disc, owner, dt);
  const amount = clamp01(quartOut(owner.retrieveCharge ?? 0) - 0.2);
  return mul(disc.returnDirection, D.returnStrength * amount);
}

function calculateControlled(
  state: GameState,
  disc: Disc,
  owner: Actor | undefined,
  dt: number,
): Vec2 {
  if (!owner?.alive || (owner.retrieveCharge ?? 0) === 0) {
    const speed = length(disc.velocity);
    if (speed > 1 * U) {
      setMovement(disc, 'throwing');
      const fraction = (speed / disc.speedLimit!) * (owner?.retrieveCharge ?? 0) * 4;
      disc.throwTimer = Math.sin((Math.PI / 2) * (1 - clamp01(fraction))) * disc.throwDuration!;
      disc.throwDirection = normalize(disc.velocity);
    } else if (disc.throwTimer! < disc.throwDuration!) setMovement(disc, 'throwing');
    else if (disc.canReturn) startReturn(disc);
    else startFreeform(state, disc);
    disc.controlledFactor = 0;
    return v();
  }
  disc.controlledFactor = Math.min(1, disc.controlledFactor! + dt * 4);
  disc.spinning = false;
  return mul(owner.controlDirection ?? v(), D.controlledForce * disc.controlledFactor);
}

function calculateFreeform(disc: Disc, dt: number): Vec2 {
  disc.freeStrength = disc.freeStrength! * (1 - clamp01(dt * D.freeDecay));
  return mul(normalize(disc.velocity), disc.freeStrength);
}

/** Disc.ApplySpin: a sideways force that only bends the path. */
function applySpin(disc: Disc, dt: number): void {
  disc.spinTimer! += dt;
  const duration = disc.throwDuration! * 1.2;
  const amount = D.throwSpeed * (Math.abs(disc.spinAngle!) / 90);
  const magnitude = length(disc.velocity);
  const sign = disc.spinAngle! >= 0 ? 1 : -1;
  let vector = mul(rotate(normalize(disc.throwDirection!), -sign * 90 * deg), amount);
  if (disc.spinTimer! > duration)
    vector = mul(rotate(normalize(disc.returnDirection!), sign * 90 * deg), amount);
  disc.velocity = add(
    disc.velocity,
    force(
      disc.spinTimer! < duration ? mul(vector, cubicOut(disc.spinTimer! / duration)) : vector,
      dt,
    ),
  );
  disc.velocity = clampLength(disc.velocity, magnitude);
}

/** Disc.ApplyHoming: a short, forward-only correction toward visible opponents. */
function applyHoming(state: GameState, disc: Disc, dt: number): void {
  if (!disc.canHome) return;
  let target: Vec2 | null = null;
  let nearest = disc.homingRadius!;
  const heading = normalize(disc.velocity);
  const candidates: Vec2[] = [];
  for (const actor of state.actors)
    if (actor.alive && actor.id !== disc.ownerId && actor.dashTime <= 0 && !actor.disguised)
      candidates.push(actor.position);
  for (const decoy of state.decoys ?? [])
    if (decoy.alive && decoy.ownerId !== disc.ownerId) candidates.push(decoy.position);
  for (const position of candidates) {
    const offset = sub(position, disc.position);
    const d = length(offset);
    if (dot(normalize(offset), heading) > D.homingDot && d < nearest) {
      nearest = d;
      target = position;
    }
  }
  if (!target) return;
  let lhs = sub(target, disc.position);
  // The source compares an unnormalized Unity-space vector here; keep that scale.
  if (dot(mul(lhs, 1 / U), disc.throwDirection!) < 0.75)
    lhs = mul(lhs, 0.75 + clamp01(disc.charge * 0.8) * 0.25);
  if (!lineOfSight(state.arena, disc.position, add(disc.position, lhs))) return;
  const magnitude = length(disc.velocity);
  const amount = D.throwSpeed * 1.25 + D.throwSpeed * disc.charge * 3;
  disc.velocity = clampLength(
    add(disc.velocity, force(mul(normalize(lhs), amount), dt)),
    magnitude,
  );
}

/* ------------------------------------------------------------- triggers */

interface StepGuards {
  discs: Set<string>;
  shields: Set<string>;
}
let guards: StepGuards = { discs: new Set(), shields: new Set() };

function collideWithDisc(state: GameState, receiver: Disc, collider: Disc, normal: Vec2): boolean {
  const key = `${receiver.id}:${collider.id}`;
  if (guards.discs.has(key)) return false;
  guards.discs.add(key);
  if (!receiver.startedDropped) receiver.canCollideWithOwner = true;
  const incoming = sub(receiver.velocity, collider.stored ?? collider.velocity);
  receiver.deflectedTimer = D.deflectProtection;
  const owner = ownerOf(state, receiver);
  if (owner && collider.ownerId !== receiver.ownerId) {
    const d = distance(receiver.position, owner.position);
    if (d < D.minOwnerDistance * 2 && d < distance(collider.position, owner.position)) {
      owner.deflectedDiscs ??= {};
      owner.deflectedDiscs[collider.id] = NATIVE.combat.protectionFrames;
    }
  }
  bounceDisc(state, receiver, incoming, normal);
  return true;
}

/** CombatWorld.TriggerDiscContact: both discs respond along the line between them. */
function triggerDiscContact(state: GameState, moving: Disc, other: Disc): void {
  for (const [receiver, collider] of [
    [other, moving],
    [moving, other],
  ] as const) {
    if (receiver.mini || collider.projectile === false) continue;
    const normal = normalize(sub(collider.position, receiver.position));
    if (!collideWithDisc(state, receiver, collider, normal)) continue;
    const different = receiver.ownerId !== collider.ownerId;
    state.events.push({
      type: 'clash',
      position: { ...receiver.position },
      actorId: receiver.damageOwnerId,
      entityId: receiver.id,
      value: different ? 1 : 0,
    });
    if (different && !clockOf(state).slowMo) {
      const { hold, lerpIn, scale } = NATIVE.slowMo.discClash;
      slowMo(state, hold, lerpIn, scale);
    }
  }
}

function shieldOnce(state: GameState, actor: Actor, disc: Disc): void {
  const key = `${disc.id}:${actor.id}`;
  if (guards.shields.has(key)) return;
  guards.shields.add(key);
  triggerShieldDisc(state, actor, disc);
}

/** Player.Collect / PickUpDisc / CollectMini. */
export function triggerPickup(state: GameState, actor: Actor, disc: Disc): boolean {
  if (disc.dead || !actor.alive || (actor.fall && actor.fall.elapsed > 0.33)) return false;
  const held = heldDiscs(actor);
  if (held >= 2 || disc.pickable === false) return false;
  if (disc.ownerId === actor.id) {
    if (held + (actor.discRespawns?.length ?? 0) > 1 || !disc.canCollideWithOwner) return false;
  } else if (disc.ownerId >= 0 || disc.movement !== 'dropped') return false;
  if (disc.mini && disc.ownerId === actor.id) {
    disc.dead = true;
    const group = disc.groupId ?? disc.id;
    if (state.discs.some((d) => !d.dead && (d.groupId ?? d.id) === group)) return true;
  } else if (disc.ownerId === actor.id && (justDeflected(disc) || disc.charge > 0.15)) {
    let direction = mul(sub(actor.stored ?? actor.velocity, disc.stored ?? disc.velocity), -1);
    if (justDeflected(disc)) direction = mul(direction, 1.2);
    if (length(direction) < 1 * U)
      direction = mul(normalize(sub(actor.position, disc.position)), 50 * U);
    if (justDeflected(disc)) startPushback(actor, direction, 0.1, 0.15);
    else startPushback(actor, direction, 0.02);
  }
  disc.dead = true;
  grantDisc(actor);
  if (actor.discRespawns?.length)
    actor.discRespawns = actor.discRespawns.slice(0, Math.max(0, 2 - heldDiscs(actor)));
  if (actor.recalling || actor.controlling) actor.throwBlocked = true;
  state.events.push({ type: 'catch', position: { ...actor.position }, actorId: actor.id });
  return true;
}

/** CombatWorld.SweepDisc: ordered trigger callbacks along this step's displacement. */
function sweepDisc(state: GameState, disc: Disc, amount: Vec2, incoming: Vec2, dt: number): Vec2 {
  const segment = mul(amount, dt);
  if (length(segment) < 1e-9) return amount;
  type Hit = { t: number; run: () => Vec2 | void };
  const hits: Hit[] = [];
  const active = disc.movement !== 'dropped' && !disc.startedDropped;
  const cast = (center: Vec2, radius: number): number | null => {
    const hit = segmentCircle(disc.position, segment, center, radius);
    return hit && hit.t > 0 ? hit.t : null;
  };
  if (active)
    for (const other of state.discs) {
      if (other === disc || other.dead || other.projectile === false || other.mini) continue;
      if ((other.colliderDisabled ?? 0) > 0) continue;
      const t = cast(other.position, D.queryRadius + D.colliderRadius);
      if (t !== null) hits.push({ t, run: () => triggerDiscContact(state, disc, other) });
    }
  for (const actor of state.actors) {
    if (!actor.alive) continue;
    if (actor.shield && disc.projectile !== false) {
      const t = cast(actor.position, NATIVE.shieldRadius + D.queryRadius);
      if (t !== null) hits.push({ t, run: () => shieldOnce(state, actor, disc) });
    }
    if (
      actor.attackTime > 0 &&
      actor.attackArmed &&
      active &&
      (disc.ownerId !== actor.id || disc.canCollideWithOwner)
    ) {
      const polygon = meleePolygon(actor);
      if (!circleTouchesPolygon(disc.position, D.queryRadius, polygon)) {
        const hit = sweepPaths(disc.position, segment, D.queryRadius, [polygon]);
        if (hit && hit.t > 0)
          hits.push({
            t: hit.t,
            run: () => {
              triggerDiscParry(state, actor, disc);
              const center = meleeCenter(actor);
              if (!lineBlocked(state, disc.position, center))
                return add(
                  mul(segment, hit.t),
                  reflect(incoming, normalize(sub(disc.position, center))),
                );
            },
          });
      }
    }
    const pickup = cast(actor.position, NATIVE.pickupRadius + D.queryRadius);
    if (pickup !== null)
      hits.push({ t: pickup, run: () => void triggerPickup(state, actor, disc) });
    if (active) {
      const t = cast(actor.position, NATIVE.damageRadius + D.queryRadius);
      if (t !== null)
        hits.push({
          t,
          run: () => {
            disc.damageContacts = [...(disc.damageContacts ?? []), actor.id];
            triggerDamage(state, actor, disc);
          },
        });
    }
  }
  if (active)
    for (const decoy of state.decoys ?? []) {
      if (!decoy.alive || decoy.ownerId === disc.damageOwnerId) continue;
      const t = cast(decoy.position, NATIVE.damageRadius + D.queryRadius);
      if (t !== null) hits.push({ t, run: () => void hitDecoy(state, decoy, disc.damageOwnerId) });
    }
  hits.sort((a, b) => a.t - b.t);
  for (const hit of hits.slice(0, 16)) {
    if (disc.dead) break;
    const result = hit.run();
    if (result) return result;
  }
  return amount;
}

/** Projectile.MoveProjectile: drag, speed limit, wall bounce and trigger sweep. */
function moveProjectile(state: GameState, disc: Disc, dt: number): void {
  if (length(disc.velocity) > 0) disc.velocity = mul(disc.velocity, clamp01(1 - D.drag * dt));
  disc.velocity = clampLength(disc.velocity, disc.speedLimit!);
  let amount = { ...disc.velocity };
  const incoming = { ...disc.velocity };
  const delta = mul(disc.velocity, dt);
  const wall =
    length(delta) > 0 ? traceObstacles(state.arena, disc.position, delta, D.queryRadius) : null;
  const portal = tracePortal(state.arena, disc.position, delta, D.queryRadius, disc.portalCooldown);
  if (portal && (!wall || portal.t < wall.t)) {
    sweepDisc(state, disc, mul(amount, portal.t), incoming, dt);
    if (!disc.dead) teleportDisc(state, disc, portal);
    disc.stored = { ...disc.velocity };
    return;
  }
  if (wall) {
    if (!disc.startedDropped) disc.canCollideWithOwner = true;
    if (wall.obstacle?.kind === 'crate') breakCrate(state, wall.obstacle, disc.damageOwnerId);
    bounceDisc(state, disc, disc.velocity, wall.normal);
    disc.canHome = false;
    disc.bounces++;
    // The source returns a displacement here that is then multiplied by dt again.
    amount = sub(mul(delta, wall.t), mul(normalize(delta), 0.001 * U));
    if (wall.t <= 1e-6) disc.position = add(disc.position, mul(wall.normal, 0.01));
    state.events.push({
      type: 'bounce',
      position: { ...disc.position },
      actorId: disc.damageOwnerId,
      value: length(incoming) / disc.speedLimit!,
    });
  }
  // Only the actual swept segment hits switches; a teleport never strikes across the map.
  strikeEnvironment(state, {
    kind: 'disc',
    from: disc.position,
    position: add(disc.position, mul(amount, dt)),
    direction: normalize(disc.velocity),
    radius: D.queryRadius,
    actorId: disc.damageOwnerId,
    fire: has(disc, 'fire'),
    ice: has(disc, 'ice'),
  });
  amount = sweepDisc(state, disc, amount, incoming, dt);
  if (disc.dead) return;
  disc.position = add(disc.position, mul(amount, dt));
  disc.stored = { ...disc.velocity };
}

/** Disc.FixedUpdate. */
function fixedStep(state: GameState, disc: Disc, dt: number): void {
  const owner = ownerOf(state, disc);
  switch (disc.movement) {
    case 'throwing':
      applyHoming(state, disc, dt);
      break;
    case 'returning':
      if (!owner?.alive) {
        startFreeform(state, disc);
        break;
      }
      disc.velocity = add(disc.velocity, force(calculateReturn(disc, owner, dt), dt));
      if (!disc.canBeControlled && !justDeflected(disc) && retrieveOf(owner) > 0.15)
        disc.canBeControlled = true;
      break;
    case 'free':
      disc.velocity = add(disc.velocity, force(calculateFreeform(disc, dt), dt));
      if (length(disc.velocity) < D.freeSettle) settle(disc);
      break;
    case 'dropped':
      if (owner && length(disc.velocity) < D.publicSpeed && !disc.mini && disc.startedDropped) {
        disc.ownerId = -1;
        disc.startedDropped = false;
      }
      if (owner && length(disc.stored!) > D.retrieveWakeSpeed && retrieveOf(owner) > 0.1) {
        setMovement(disc, 'returning');
        disc.projectile = true;
      }
      break;
    case 'controlled': {
      disc.velocity = add(disc.velocity, force(calculateControlled(state, disc, owner, dt), dt));
      if (owner && disc.movement === 'controlled') {
        const radial = sub(disc.position, owner.position);
        const d = length(radial);
        if (d >= D.controlledRange) {
          const normal = normalize(radial);
          const padding = clamp01((d - D.controlledRange) / (4 * U));
          disc.velocity = sub(
            disc.velocity,
            mul(normal, Math.max(0, dot(disc.velocity, normal) * padding)),
          );
        }
      }
      break;
    }
  }
  if (disc.dead) return;
  if (disc.spinning) applySpin(disc, dt);
  const currentOwner = ownerOf(state, disc);
  if (
    disc.movement !== 'squished' &&
    disc.movement !== 'controlled' &&
    retrieveOf(currentOwner) > 0 &&
    !justDeflected(disc)
  )
    disc.velocity = add(disc.velocity, force(calculateRetrieve(disc, currentOwner!, dt), dt));
  switch (disc.movement) {
    case 'throwing':
      disc.velocity = add(disc.velocity, force(calculateThrow(state, disc, dt), dt));
      break;
    case 'free':
      disc.velocity = add(disc.velocity, force(calculateFreeform(disc, dt), dt));
      if (length(disc.velocity) < D.freeSettle) settle(disc);
      break;
    case 'dropped':
      if (length(disc.velocity) < 1 * U && disc.startedDropped) disc.startedDropped = false;
      break;
  }
  if (disc.dead) return;
  moveProjectile(state, disc, dt);
  const after = ownerOf(state, disc);
  if (
    !disc.canCollideWithOwner &&
    after &&
    distance(disc.position, after.position) > D.minOwnerDistance
  )
    disc.canCollideWithOwner = true;
}

function settle(disc: Disc): void {
  disc.charge = 0;
  setMovement(disc, 'dropped');
  disc.projectile = false;
  disc.canBeControlled = false;
  disc.canCollideWithOwner = true;
}

/** Disc.Update plus Grenade and BecomePublic coroutines. */
function frameStep(state: GameState, disc: Disc, dt: number): void {
  if (disc.movement === 'dropped' && !(disc.explosive && disc.fuse > 0)) disc.pickable = true;
  disc.deflectedTimer = Math.max(0, (disc.deflectedTimer ?? 0) - dt);
  disc.colliderDisabled = Math.max(0, (disc.colliderDisabled ?? 0) - dt);
  const owner = ownerOf(state, disc);
  if (disc.movement === 'returning' && owner && !owner.alive) {
    startFreeform(state, disc, -10 * U);
    disc.canBeControlled = false;
  }
  if (
    (disc.movement === 'throwing' || disc.movement === 'returning') &&
    disc.canBeControlled &&
    owner?.alive &&
    has(disc, 'controlled') &&
    retrieveOf(owner) > 0
  ) {
    setMovement(disc, 'controlled');
    disc.charge = 0;
  }
  if (disc.explosive && disc.fuse > 0) {
    disc.fuse -= dt;
    if (disc.fuse <= 0) {
      detonate(state, disc);
      return;
    }
  }
  if (disc.publicTimer !== undefined) {
    disc.publicTimer -= dt;
    if (disc.publicTimer <= 0) {
      disc.publicTimer = undefined;
      if (disc.mini) disc.dead = true;
      else disc.ownerId = -1;
    }
  }
}

export function tickDiscs(state: GameState, dt: number): void {
  guards = { discs: new Set(), shields: new Set() };
  // New fragments begin on the following fixed step, independent of array append behavior.
  const count = state.discs.length;
  for (let index = 0; index < count; index++) {
    const disc = state.discs[index];
    if (disc.dead) continue;
    ensureDisc(disc);
    disc.previous = { ...disc.position };
    disc.age += dt;
    disc.stateTime += dt;
    disc.grace = Math.max(0, disc.grace - dt);
    disc.portalCooldown = Math.max(0, (disc.portalCooldown ?? 0) - dt);
    fixedStep(state, disc, dt);
    if (!disc.dead) frameStep(state, disc, dt);
    if (disc.dead) continue;
    if (
      !has(disc, 'multi') &&
      disc.movement !== 'dropped' &&
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
      const owner = ownerOf(state, disc);
      if (disc.explosive) detonate(state, disc);
      else if (owner?.alive && disc.movement !== 'returning') startReturn(disc);
      else if (!owner) disc.dead = true;
      // A weapon far outside every boundary is returned rather than lost.
      if (
        !disc.dead &&
        (Math.abs(disc.position.x) > state.arena.halfWidth + 12 ||
          Math.abs(disc.position.y) > state.arena.halfHeight + 12)
      )
        recoverDisc(state, disc);
    }
  }
  state.discs = state.discs.filter((disc) => !disc.dead);
}

/** Native trigger overlaps after every disc has moved (enter-only for damage/shield/melee). */
export function discOverlapPhase(state: GameState): void {
  for (const disc of state.discs) {
    if (disc.dead) continue;
    ensureDisc(disc);
    if ((disc.colliderDisabled ?? 0) > 0) {
      disc.damageContacts = [];
      disc.meleeContacts = [];
      continue;
    }
    const meleeNow: number[] = [];
    for (const actor of state.actors) {
      if (!actor.alive || !(actor.attackTime > 0 && actor.attackArmed)) continue;
      if (!circleTouchesPolygon(disc.position, D.colliderRadius, meleePolygon(actor))) continue;
      meleeNow.push(actor.id);
      if (!disc.meleeContacts!.includes(actor.id)) triggerDiscParry(state, actor, disc);
      if (disc.dead) break;
    }
    disc.meleeContacts = meleeNow;
    const damageNow: number[] = [];
    const shieldNow: number[] = [];
    for (const actor of state.actors) {
      if (disc.dead) break;
      if (!actor.alive) continue;
      const d = distance(disc.position, actor.position);
      if (actor.shield && disc.projectile !== false && d < NATIVE.shieldRadius + D.colliderRadius) {
        shieldNow.push(actor.id);
        if (!disc.shieldContacts!.includes(actor.id)) shieldOnce(state, actor, disc);
      }
      if (
        disc.projectile !== false &&
        disc.movement !== 'dropped' &&
        !disc.startedDropped &&
        d < NATIVE.damageRadius + D.colliderRadius
      ) {
        damageNow.push(actor.id);
        if (!disc.damageContacts!.includes(actor.id) || actor.justVulnerable) {
          actor.justVulnerable = false;
          triggerDamage(state, actor, disc);
        }
      }
      if (!disc.dead && d < NATIVE.pickupRadius + D.colliderRadius)
        triggerPickup(state, actor, disc);
    }
    disc.damageContacts = damageNow;
    disc.shieldContacts = shieldNow;
  }
  state.discs = state.discs.filter((disc) => !disc.dead);
}

/** Player.RequestRespawn/AdvanceRespawns for discs lost to explosions. */
export function tickDiscRespawns(state: GameState, dt: number): void {
  for (const actor of state.actors) {
    if (!actor.discRespawns?.length) continue;
    if (!actor.alive) {
      actor.discRespawns = [];
      continue;
    }
    const remaining: number[] = [];
    for (const time of actor.discRespawns) {
      const left = time - dt;
      if (left > 0) remaining.push(left);
      else if (heldDiscs(actor) < 2 && !(actor.fall && actor.fall.elapsed > 0.33)) grantDisc(actor);
    }
    actor.discRespawns = remaining;
  }
}
