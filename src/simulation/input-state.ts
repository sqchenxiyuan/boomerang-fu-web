import type { Actor } from '../core/types';

/** Control changes and pause cancel held actions without generating release edges.
 * Replays record this mutation as well as the commands consumed by physics. */
export function clearActorInput(actor: Actor): boolean {
  const changed =
    actor.charge !== 0 ||
    actor.recalling !== false ||
    actor.controlling !== false ||
    actor.controlDirection?.x !== 0 ||
    actor.controlDirection?.y !== 0 ||
    actor.throwBlocked !== false ||
    actor.facingHistory?.length !== 0 ||
    actor.aimMoveLag !== 0 ||
    actor.bufferedDash !== 0 ||
    actor.bufferedAttack !== 0;
  actor.charge = 0;
  actor.recalling = false;
  actor.controlling = false;
  actor.controlDirection = { x: 0, y: 0 };
  actor.throwBlocked = false;
  actor.facingHistory = [];
  actor.aimMoveLag = 0;
  actor.bufferedDash = 0;
  actor.bufferedAttack = 0;
  return changed;
}
