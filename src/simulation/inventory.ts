import type { Actor, Disc, GameState } from '../core/types';

/** Player.heldDiscs never exceeds two; a public disc can fill the second hand. */
export const MAX_HELD_DISCS = 2;

/** Discs granted when a round starts (PrepareRound → RespawnDiscRoutine). */
export const discCapacity = (actor: Actor): number => (actor.powers.includes('extra') ? 2 : 1);

/** `armed` remains compatible with callers constructing older SDK snapshots. */
export const heldDiscs = (actor: Actor): number =>
  actor.armed ? Math.min(MAX_HELD_DISCS, Math.max(1, actor.heldDiscs ?? 1)) : 0;

export function setHeldDiscs(actor: Actor, count: number): void {
  actor.heldDiscs = Math.max(0, Math.min(MAX_HELD_DISCS, count));
  actor.armed = actor.heldDiscs > 0;
  if (actor.armed) actor.disarmed = false;
}

/** Discs this actor still owns in the world, counting a split weapon once. */
export function ownedWeapons(state: GameState, actor: Actor): number {
  return new Set(
    state.discs.filter((d) => !d.dead && d.ownerId === actor.id).map((d) => d.groupId ?? d.id),
  ).size;
}

/** Player.PickUpDisc cooldown and inventory change; the caller removes the disc. */
export function grantDisc(actor: Actor): void {
  actor.coolingAttack = true;
  actor.attackCooldown = actor.powers.includes('haste') || heldDiscs(actor) > 0 ? 0.05 : 0.1;
  setHeldDiscs(actor, heldDiscs(actor) + 1);
}

export function recoverDisc(state: GameState, disc: Disc, caught = false): void {
  if (disc.dead) return;
  disc.dead = true;
  const owner = state.actors.find((actor) => actor.id === disc.ownerId);
  if (!owner?.alive) return;
  // Explosive fragments never return a weapon; RequestRespawn(3.25) replaces it.
  if (disc.mini && disc.explosive) return;
  const group = disc.groupId ?? disc.id;
  const remaining = state.discs.filter((d) => !d.dead && d.ownerId === owner.id);
  // A split weapon is one inventory unit, restored after its final fragment resolves.
  if (remaining.some((d) => (d.groupId ?? d.id) === group)) return;
  grantDisc(owner);
  if (owner.recalling || owner.controlling) owner.throwBlocked = true;
  if (remaining.length === 0) {
    owner.recalling = false;
    owner.controlling = false;
    owner.retrieveCharge = 0;
  }
  if (caught)
    state.events.push({ type: 'catch', position: { ...owner.position }, actorId: owner.id });
}
