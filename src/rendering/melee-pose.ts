import { RULES } from '../core/config';
import type { Actor } from '../core/types';

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const smooth = (value: number): number => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const MELEE_SETTLE = 0.38;

/** Existing melee-only recovery distinguishes a slash from throw cooldown.
 * No wall clock or renderer history: pause, late attachment and rewind agree. */
export function meleeAge(actor: Actor, alpha = 1): number | null {
  if (
    !actor.alive ||
    actor.fall ||
    actor.disguised ||
    (actor.frozenTime ?? 0) > 0 ||
    actor.dashTime > 0
  )
    return null;
  let age: number;
  if (actor.attackTime > 0) age = RULES.attackDuration - actor.attackTime;
  else if (actor.attackSerial > 0 && actor.lungeRecovery > 0)
    age = RULES.lungeRecovery * (actor.attackArmed ? 1 : 0.85) - actor.lungeRecovery;
  else return null;
  age = Math.max(0, age - (1 - clamp(alpha)) * RULES.dt);
  return age < MELEE_SETTLE ? age : null;
}

export function sampleMeleePose(age: number, armed: boolean) {
  const load = smooth(age / 0.028);
  const sweep = smooth((age - 0.028) / 0.1);
  const follow = smooth((age - 0.128) / 0.07);
  const recover = smooth((age - 0.198) / (MELEE_SETTLE - 0.198));
  const weight = load * (1 - recover);
  const strike = Math.sin(Math.PI * sweep) * (1 - recover);
  const angle = mix(1.2, -1.15, sweep) - follow * 0.13;
  return {
    weight,
    angle,
    twist: (0.28 * load - 0.82 * sweep + 0.12 * follow) * (1 - recover),
    lean: (0.13 * sweep - 0.04 * load) * (1 - recover),
    height: (-0.055 * load + 0.13 * strike - 0.025 * follow) * (1 - recover),
    stretch: 1 + (-0.055 * load + 0.13 * strike) * (1 - recover),
    step: (0.24 * sweep + 0.04 * strike) * (1 - recover),
    handX: armed ? Math.sin(angle) * (0.93 + strike * 0.08) : 0.22,
    handZ: armed
      ? Math.cos(angle) * (0.93 + strike * 0.08)
      : 0.35 + 0.72 * Math.sin(Math.PI * sweep * 0.75),
    handY: armed ? 0.05 + 0.13 * strike : 0.04,
    trail: armed ? smooth((age - 0.026) / 0.035) * (1 - smooth((age - 0.15) / 0.075)) : 0,
  };
}
