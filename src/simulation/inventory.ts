import type { Actor, Disc, GameState } from '../core/types';

export const discCapacity = (actor: Actor): number => (actor.powers.includes('extra') ? 2 : 1);

/** `armed` remains compatible with callers constructing older SDK snapshots. */
export const heldDiscs = (actor: Actor): number =>
  actor.armed ? Math.min(discCapacity(actor), Math.max(1, actor.heldDiscs ?? 1)) : 0;

export function setHeldDiscs(actor: Actor, count: number): void {
  actor.heldDiscs = Math.max(0, Math.min(discCapacity(actor), count));
  actor.armed = actor.heldDiscs > 0;
}

export function recoverDisc(state: GameState, disc: Disc, caught = false): void {
  if (disc.dead) return;
  disc.dead = true;
  const owner = state.actors.find((actor) => actor.id === disc.ownerId);
  if (!owner?.alive) return;
  const group = disc.groupId ?? disc.id;
  const remaining = state.discs.filter((d) => !d.dead && d.ownerId === owner.id);
  // A split weapon is one inventory unit, restored after its final fragment resolves.
  if (remaining.some((d) => (d.groupId ?? d.id) === group)) return;
  const flying = new Set(remaining.map((d) => d.groupId ?? d.id)).size;
  const available = Math.max(0, discCapacity(owner) - flying);
  setHeldDiscs(owner, Math.min(available, heldDiscs(owner) + 1));
  if (owner.recalling || owner.controlling) owner.throwBlocked = true;
  if (remaining.length === 0) {
    owner.recalling = false;
    owner.controlling = false;
  }
  if (caught)
    state.events.push({ type: 'catch', position: { ...owner.position }, actorId: owner.id });
}
