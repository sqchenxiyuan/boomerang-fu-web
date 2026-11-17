import { NATIVE, RULES } from '../core/config';
import { clamp, length } from '../core/math';
import type { Actor } from '../core/types';
import { meleeAge, sampleMeleePose } from './melee-pose';

/*
 * Procedural, exaggerated character motion with floating hands and feet.
 * Pure and state-driven (no wall clock or history), so pause, rewind and
 * replay seeks agree. Everything is in the actor's facing frame: +z forward,
 * +x the weapon hand, +y up, origin on the ground under the actor.
 */
export interface Joint {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  scale: number;
}
export interface CharacterPose {
  body: Joint & { sx: number; sy: number; sz: number };
  /** [off hand, weapon hand]. */
  hands: [Joint, Joint];
  feet: [Joint, Joint];
}
export interface MotionContext {
  /** Seconds since this actor's newest throw, while the follow-through lasts. */
  throwAge?: number | null;
}

export const BODY_HEIGHT = 0.82;
export const THROW_FOLLOW = 0.36;
const WALK_TOP = NATIVE.actor.walk / NATIVE.actor.drag;
const TAU = Math.PI * 2;
const smooth = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
/** A damped overshoot from 0 → 1, for snappy follow-through. */
const spring = (t: number, frequency = 3.2, damping = 5): number =>
  1 - Math.exp(-damping * t) * Math.cos(TAU * frequency * t);
const joint = (x: number, y: number, z: number, scale = 1): Joint => ({
  x,
  y,
  z,
  yaw: 0,
  pitch: 0,
  roll: 0,
  scale,
});
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
function blend(a: Joint, b: Joint, t: number): Joint {
  return {
    x: mix(a.x, b.x, t),
    y: mix(a.y, b.y, t),
    z: mix(a.z, b.z, t),
    yaw: mix(a.yaw, b.yaw, t),
    pitch: mix(a.pitch, b.pitch, t),
    roll: mix(a.roll, b.roll, t),
    scale: mix(a.scale, b.scale, t),
  };
}

export function sampleCharacterPose(
  actor: Actor,
  clock: number,
  context: MotionContext = {},
  alpha = 1,
): CharacterPose {
  // Frozen solid: every joint holds its pose, the floating hands included.
  const time = (actor.frozenTime ?? 0) > 0 ? 0 : clock;
  const speed = length(actor.velocity);
  const run = clamp(speed / WALK_TOP, 0, 1.6);
  const seed = actor.id * 1.7;
  const cycle =
    time * (7 + 9 * Math.min(run, 1.2)) * (actor.powers.includes('haste') ? 1.25 : 1) + seed;
  const breathe = Math.sin(time * 3.1 + seed);
  const step = Math.sin(cycle);
  // Idle breathing and a hopping run: the body leaves the ground on each step.
  const body = {
    ...joint(0, BODY_HEIGHT + breathe * 0.025 + Math.abs(step) * 0.19 * Math.min(run, 1), 0),
    sx: 1,
    sy: 1 + breathe * 0.035,
    sz: 1,
  };
  const contact = 1 - Math.abs(step);
  if (run > 0.15) {
    const squash = Math.pow(contact, 6) * 0.14 * Math.min(run, 1);
    body.sy -= squash;
    body.pitch = 0.3 * Math.min(run, 1.3);
    body.roll = step * 0.09 * Math.min(run, 1);
  }
  let left = joint(-0.64, 0.6 + Math.sin(time * 3.1 + seed + 1.3) * 0.045, 0.06);
  let right = joint(0.64, 0.6 + Math.sin(time * 3.1 + seed + 2.4) * 0.045, 0.06);
  // Big counter-swinging hands while running; feet stride in arcs.
  const swing = Math.min(run, 1.2);
  left.z += -step * 0.52 * swing;
  right.z += step * 0.52 * swing;
  left.y += Math.max(0, -step) * 0.2 * swing;
  right.y += Math.max(0, step) * 0.2 * swing;
  const footLift = (phase: number): number => Math.max(0, Math.cos(phase)) * 0.2 * Math.min(run, 1);
  let feet: [Joint, Joint] = [
    joint(-0.25, 0.15 + footLift(cycle), step * 0.4 * Math.min(run, 1.2)),
    joint(0.25, 0.15 + footLift(cycle + Math.PI), -step * 0.4 * Math.min(run, 1.2)),
  ];
  feet[0].pitch = -step * 0.5 * Math.min(run, 1);
  feet[1].pitch = step * 0.5 * Math.min(run, 1);

  const charging = actor.charge > 0.02 && actor.alive && actor.armed;
  if (charging) {
    // Wind-up: torso twists away and leans back, weapon hand drawn far behind.
    const c = smooth(actor.charge / RULES.chargeTime);
    const shake = c > 0.95 ? Math.sin(time * 70) * 0.025 : 0;
    body.yaw += 0.62 * c;
    body.pitch = mix(body.pitch, -0.2, c);
    body.sx += 0.06 * c;
    body.sy -= 0.08 * c;
    right = blend(
      right,
      { ...joint(0.82 + shake, 0.98, -0.62), yaw: -0.6, pitch: 0, roll: 0.5, scale: 1.08 },
      c,
    );
    left = blend(
      left,
      { ...joint(-0.42, 0.82, 0.68 + shake), yaw: 0, pitch: 0, roll: 0, scale: 1 },
      c,
    );
    feet = [
      blend(feet[0], joint(-0.36, 0.15, 0.2), c),
      blend(feet[1], joint(0.34, 0.15, -0.22), c),
    ];
  }
  const throwAge = context.throwAge;
  if (throwAge !== null && throwAge !== undefined && throwAge < THROW_FOLLOW && actor.alive) {
    // Follow-through: snap across the body with a springy overshoot.
    const t = throwAge / THROW_FOLLOW;
    const snap = spring(throwAge, 2.6, 7);
    const fade = 1 - smooth((t - 0.55) / 0.45);
    body.yaw += (-0.55 * snap + 0.62 * (1 - snap)) * fade;
    body.pitch = mix(body.pitch, 0.32, fade * smooth(t * 3));
    body.sz += 0.18 * fade * (1 - t);
    body.sy -= 0.1 * fade * (1 - t);
    right = blend(
      right,
      { ...joint(-0.25, 0.7, 0.9), yaw: 0.9, pitch: 0, roll: -0.3, scale: 1 },
      fade * smooth(t * 4),
    );
    left = blend(left, joint(-0.78, 0.86, -0.42), fade);
  }
  const age = meleeAge(actor, alpha);
  if (age !== null) {
    const melee = sampleMeleePose(age, actor.attackArmed);
    const w = melee.weight;
    const twist = melee.twist * 1.45;
    body.yaw += twist;
    body.pitch = mix(body.pitch, melee.lean * 1.6, w);
    body.z += melee.step * 0.42;
    body.y += melee.height * 1.3;
    body.sy *= 1 + (melee.stretch - 1) * 1.6;
    body.sx /= Math.sqrt(1 + (melee.stretch - 1) * 1.6);
    const hx = melee.handX * Math.cos(twist) - melee.handZ * Math.sin(twist);
    const hz = melee.handX * Math.sin(twist) + melee.handZ * Math.cos(twist);
    right = blend(
      right,
      {
        ...joint(hx * 1.12, BODY_HEIGHT + melee.handY * 1.1, hz * 1.12 + 0.1),
        yaw: melee.angle + Math.PI / 2 - twist,
        pitch: 0,
        roll: 0,
        scale: 1.1,
      },
      w,
    );
    left = blend(left, joint(-0.86, 0.95, -0.36), w);
    feet[0] = blend(feet[0], joint(-0.3, 0.15, 0.36 * melee.step + 0.12), w);
    feet[1] = blend(feet[1], joint(0.3, 0.15, -0.16 * melee.step), w);
  }
  if ((actor.retrieveCharge ?? 0) > 0 && actor.alive) {
    // Recall: both hands reach out, the body braces against the pull.
    const r = smooth((actor.retrieveCharge ?? 0) * 6);
    const tug = Math.sin(time * 18) * 0.03 * r;
    body.pitch = mix(body.pitch, -0.18, r);
    right = blend(right, joint(0.3 + tug, 0.92, 0.85), r);
    left = blend(left, joint(-0.3 - tug, 0.92, 0.85), r);
  }
  if (actor.dashTime > 0) {
    // Dash: stretch along the motion, hands and feet stream behind.
    const d = smooth(actor.dashTime / NATIVE.actor.dashDuration + 0.3);
    body.pitch = mix(body.pitch, 0.55, d);
    body.sz *= 1 + 0.3 * d;
    body.sy *= 1 - 0.2 * d;
    body.sx *= 1 - 0.08 * d;
    body.y = mix(body.y, BODY_HEIGHT - 0.06, d);
    right = blend(right, joint(0.52, 0.9, -0.72), d);
    left = blend(left, joint(-0.52, 0.9, -0.72), d);
    feet = [blend(feet[0], joint(-0.2, 0.34, -0.5), d), blend(feet[1], joint(0.2, 0.3, -0.62), d)];
  }
  if (actor.alive && actor.stun > 0) {
    // Dizzy: a looping wobble with floppy hands.
    const s = smooth(actor.stun * 4);
    const loop = time * 9 + seed;
    body.roll = mix(body.roll, Math.sin(loop) * 0.32, s);
    body.pitch = mix(body.pitch, Math.cos(loop) * 0.22, s);
    body.y -= 0.05 * s;
    right = blend(right, joint(0.74, 0.42 + Math.sin(loop * 1.3) * 0.12, Math.cos(loop) * 0.2), s);
    left = blend(left, joint(-0.74, 0.42 + Math.cos(loop * 1.3) * 0.12, -Math.cos(loop) * 0.2), s);
  } else if (actor.alive && (actor.pushTime ?? 0) > 0) {
    // Knocked back: thrown off balance, arms up.
    const p = smooth((actor.pushTime ?? 0) / Math.max(0.05, actor.pushDuration ?? 0.2));
    body.pitch = mix(body.pitch, -0.35, p);
    right = blend(right, joint(0.66, 1.15, 0.1), p);
    left = blend(left, joint(-0.66, 1.15, 0.1), p);
  }
  if (actor.alive && actor.fall) {
    // Flailing on the way down.
    const f = clamp(actor.fall.elapsed / Math.max(0.1, actor.fall.duration), 0, 1);
    const flail = time * 26;
    right = blend(
      right,
      joint(0.7, 1.3 + Math.sin(flail) * 0.18, Math.cos(flail) * 0.2),
      smooth(f * 4),
    );
    left = blend(
      left,
      joint(-0.7, 1.3 + Math.cos(flail) * 0.18, Math.sin(flail) * 0.2),
      smooth(f * 4),
    );
  }
  if ((actor.frozenTime ?? 0) > 0) {
    // Frozen solid mid-pose: no breathing or bob.
    body.y = BODY_HEIGHT;
    body.sy = body.sx = body.sz = 1;
  }
  return { body, hands: [left, right], feet };
}
