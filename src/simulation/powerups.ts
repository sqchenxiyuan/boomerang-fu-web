import { RULES } from '../core/config';
import { distance } from '../core/math';
import type { Random } from '../core/math';
import type { Actor, GameState, PowerupKind } from '../core/types';

export function grantPowerup(state: GameState, actor: Actor, kind: PowerupKind): void {
  if (!actor.powers.includes(kind)) actor.powers.push(kind);
  if (actor.powers.length > RULES.powerupLimit) actor.powers.shift();
  if (kind === 'shield') actor.shield = true;
  state.events.push({
    type: 'pickup',
    position: { ...actor.position },
    actorId: actor.id,
    power: kind,
  });
}

export function tickPowerups(state: GameState, random: Random, dt: number): void {
  state.pickupTimer -= dt;
  if (state.pickupTimer <= 0 && state.pickups.length < 3) {
    const candidates = state.arena.pickupSpawns.filter(
      (p) => !state.pickups.some((pickup) => distance(p, pickup.position) < 1),
    );
    if (candidates.length)
      state.pickups.push({
        id: state.nextId++,
        position: { ...random.pick(candidates) },
        kind: random.pick(['shield', 'haste', 'explosive'] as const),
        age: 0,
      });
    state.pickupTimer = RULES.powerupInterval;
  }
  for (const pickup of state.pickups) {
    pickup.age += dt;
    if (pickup.age < 0.35) continue;
    const collector = state.actors.find(
      (a) => a.alive && distance(a.position, pickup.position) < 0.9,
    );
    if (collector) {
      grantPowerup(state, collector, pickup.kind);
      pickup.age = -1;
    }
  }
  state.pickups = state.pickups.filter((p) => p.age >= 0 && p.age < 30);
}
