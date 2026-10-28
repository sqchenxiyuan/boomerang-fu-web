import { POWERUPS, RULES } from '../core/config';
import { distance } from '../core/math';
import type { Random } from '../core/math';
import type { Actor, GameState, PowerupKind } from '../core/types';
import { startShrinkingBoundary } from './boundary';
import { heldDiscs, setHeldDiscs } from './inventory';
import { safePosition } from '../core/collision';

export const ALL_POWERUPS = Object.keys(POWERUPS) as PowerupKind[];

export function grantPowerup(state: GameState, actor: Actor, kind: PowerupKind): void {
  if (kind === 'reverse') actor.reverseTime = 6;
  else if (kind === 'shrink') {
    if (state.boundary.phase !== 'shrinking')
      startShrinkingBoundary(state, actor.position, actor.id);
    actor.positivePickups = (actor.positivePickups ?? 0) + 1;
  } else {
    const before = heldDiscs(actor);
    const alreadyOwned = actor.powers.includes(kind);
    if (kind === 'fire') actor.powers = actor.powers.filter((power) => power !== 'ice');
    if (kind === 'ice') actor.powers = actor.powers.filter((power) => power !== 'fire');
    if (!actor.powers.includes(kind)) {
      actor.powers.push(kind);
      if (actor.powers.length > RULES.powerupLimit) actor.powers.shift();
    }
    if (kind === 'shield') {
      actor.shield = true;
      actor.burnTime = 0;
      actor.burnDistance = 0;
    }
    if (kind === 'extra' && !alreadyOwned && state.weaponsGranted) {
      const flying = new Set(
        state.discs
          .filter((disc) => disc.ownerId === actor.id && !disc.dead)
          .map((disc) => disc.groupId ?? disc.id),
      ).size;
      if (before + flying < 2) setHeldDiscs(actor, before + 1);
    }
    // Web rule: immediately reconcile state when FIFO removes an effect. The original
    // clears the flag without running each effect's teardown callback.
    if (!actor.powers.includes('shield')) actor.shield = false;
    if (!actor.powers.includes('disguise')) {
      actor.disguised = false;
      actor.disguiseTime = 0;
    }
    if (!actor.powers.includes('controlled')) actor.controlling = false;
    if (!actor.powers.includes('extra')) {
      const flying = new Set(
        state.discs
          .filter((disc) => disc.ownerId === actor.id && !disc.dead)
          .map((disc) => disc.groupId ?? disc.id),
      ).size;
      setHeldDiscs(actor, Math.min(actor.heldDiscs ?? before, Math.max(0, 1 - flying)));
    }
    actor.positivePickups = (actor.positivePickups ?? 0) + 1;
  }
  state.events.push({
    type: 'pickup',
    position: { ...actor.position },
    actorId: actor.id,
    power: kind,
  });
}

export function tickPowerups(state: GameState, random: Random, dt: number): void {
  const enabled = state.options.powerupPool ?? ALL_POWERUPS;
  const positive = enabled.filter(
    (kind) => kind !== 'reverse' && (kind !== 'shrink' || state.boundary.phase === 'idle'),
  );
  const available = positive.length
    ? positive
    : enabled.includes('reverse')
      ? (['reverse'] as const)
      : [];
  state.pickupTimer -= dt;
  if (state.pickupTimer <= 0 && state.pickups.length < 3) {
    const candidates = state.arena.pickupSpawns.filter(
      (p) =>
        (!state.arena.floors || safePosition(state.arena, p, 0.2)) &&
        !state.pickups.some((pickup) => distance(p, pickup.position) < 1),
    );
    if (candidates.length && available.length) {
      // Original pickups choose on collection. Web pickups display a specific effect.
      const fresh = available.filter((kind) => !state.pickups.some((p) => p.kind === kind));
      state.pickups.push({
        id: state.nextId++,
        position: { ...random.pick(candidates) },
        kind: random.pick(fresh.length ? fresh : available),
        age: 0,
      });
    }
    state.pickupTimer = RULES.powerupInterval;
  }
  for (const pickup of state.pickups) {
    pickup.age += dt;
    if (pickup.age < 0.35) continue;
    const collector = state.actors.find(
      (a) => a.alive && !a.fall && distance(a.position, pickup.position) < 0.9,
    );
    if (collector) {
      let kind = pickup.kind;
      if (
        kind !== 'reverse' &&
        enabled.includes('reverse') &&
        state.actors.some((actor) => (actor.positivePickups ?? 0) > 0) &&
        random.next() < (5 + collector.powers.length * 0.25) / 100
      )
        kind = 'reverse';
      grantPowerup(state, collector, kind);
      pickup.age = -1;
    }
  }
  state.pickups = state.pickups.filter((p) => p.age >= 0 && p.age < 30);
}
