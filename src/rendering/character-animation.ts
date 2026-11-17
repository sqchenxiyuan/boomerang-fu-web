import { NATIVE, RULES } from '../core/config';
import { length } from '../core/math';
import type { Actor } from '../core/types';
import { isLunging } from '../simulation/actors';
import { heldDiscs } from '../simulation/inventory';
import { meleeAge } from './melee-pose';

/*
 * Character clip playback, ported from the Godot reference:
 * - OriginalActorMotion.move_speed_parameter (|velocity| / 11 before drag, ×slide,
 *   0 while lunging, cut below 0.25, held while stunned/frozen/dashing);
 * - main.gd's clip choice (death/burnt, frozen, stunned, fall, walk by held discs,
 *   idle) and set_clip, which restarts the clip time only when the clip changes;
 * - OriginalCharacterPreview.advance: clip time += scaled frame delta × speed,
 *   idle at its state speed, walk at move_speed_parameter, loops wrap.
 * Clip durations are the reference timings; the poses themselves are our own.
 */
export type ClipName =
  | 'idle'
  | 'walk-zero'
  | 'walk'
  | 'walk-two'
  | 'stunned'
  | 'fall'
  | 'frozen'
  | 'death'
  | 'burnt';

export const CLIP_TIMING: Readonly<Record<ClipName, { duration: number; loop: boolean }>> = {
  idle: { duration: 1.3166667, loop: true },
  'walk-zero': { duration: 0.65, loop: true },
  walk: { duration: 0.65, loop: true },
  'walk-two': { duration: 0.65, loop: true },
  stunned: { duration: 0.75, loop: false },
  fall: { duration: 0.7666667, loop: false },
  frozen: { duration: 0.0166667, loop: true },
  death: { duration: 1.3, loop: false },
  burnt: { duration: 1.25, loop: false },
};
/** Idle Animator state speed (round-intro idle_state.m_Speed). */
export const IDLE_SPEED = 0.65;
/** OriginalActorMotion: walk animation reaches speed 1 at 11 Unity units/s. */
const WALK_REFERENCE_SPEED = 11;
const WALK_THRESHOLD = 0.25;

export interface CharacterAnimation {
  clip: ClipName;
  /** Seconds into the current clip (scaled by its playback speed). */
  time: number;
  /** move_speed_parameter, also the walk clip's playback speed. */
  moveSpeed: number;
  /** A melee (windup → melee action steps) owns the pose; the base clip restarts after it. */
  inMelee: boolean;
  /** Continuous scaled display time, for secondary wobbles and shakes. */
  clock: number;
}

export const createAnimation = (): CharacterAnimation => ({
  clip: 'idle',
  time: 0,
  moveSpeed: 0,
  inMelee: false,
  clock: 0,
});

const walkClip = (discs: number): ClipName =>
  discs <= 0 ? 'walk-zero' : discs === 1 ? 'walk' : 'walk-two';

/**
 * move_speed_parameter from the latest simulated tick. The Web stores velocity
 * after drag, so the reference's pre-drag magnitude is recovered by undoing it.
 */
export function updateMoveSpeed(animation: CharacterAnimation, actor: Actor, tickDt: number): void {
  const frozen = (actor.frozenTime ?? 0) > 0;
  if (actor.stun > 0 || frozen || actor.dashTime > 0 || !actor.alive) return;
  const drag = actor.surfaceDrag ?? NATIVE.actor.drag;
  const retained = Math.max(1e-6, 1 - drag * tickDt);
  const unity = length(actor.velocity) / retained / NATIVE.scale;
  let speed = Math.min(unity / WALK_REFERENCE_SPEED, 2);
  const slide = actor.slideFactor ?? 1;
  if (slide < 1) speed *= Math.min(1, Math.max(0, slide * 2));
  else if (isLunging(actor)) speed = 0;
  animation.moveSpeed = speed <= WALK_THRESHOLD ? 0 : speed;
}

/** main.gd clip selection, in the reference's order of precedence. */
export function selectClip(actor: Actor, moveSpeed: number): ClipName {
  const dead = !actor.alive;
  let clip: ClipName = dead
    ? 'death'
    : moveSpeed > WALK_THRESHOLD
      ? walkClip(heldDiscs(actor))
      : 'idle';
  if (dead && actor.death?.cause === 'fire') clip = 'burnt';
  else if ((actor.frozenTime ?? 0) > 0) clip = 'frozen';
  if (actor.stun > 0 && !dead) clip = 'stunned';
  if (actor.fall) clip = 'fall';
  return clip;
}

/** Advance one rendered frame by the scaled game delta (0 while paused or frozen). */
export function advanceAnimation(
  animation: CharacterAnimation,
  actor: Actor,
  delta: number,
  tickDt = RULES.dt,
): void {
  updateMoveSpeed(animation, actor, tickDt);
  const clip = selectClip(actor, animation.moveSpeed);
  // Death, stun and falling clear the action steps (the melee is cancelled).
  const melee = actor.alive && actor.stun <= 0 && !actor.fall && meleeAge(actor, 1) !== null;
  if (melee) animation.inMelee = true;
  else if (animation.inMelee || clip !== animation.clip) {
    // set_clip: a new clip (or the clip after a melee) starts from its beginning.
    animation.inMelee = false;
    animation.clip = clip;
    animation.time = 0;
  }
  const speed =
    animation.clip === 'idle'
      ? IDLE_SPEED
      : animation.clip.startsWith('walk')
        ? animation.moveSpeed
        : 1;
  if (!melee) animation.time += delta * speed;
  animation.clock += delta;
}

/** The sampled time within the clip: wrapped when looping, clamped otherwise. */
export function clipTime(animation: Pick<CharacterAnimation, 'clip' | 'time'>): number {
  const { duration, loop } = CLIP_TIMING[animation.clip];
  if (duration <= 0) return 0;
  return loop
    ? ((animation.time % duration) + duration) % duration
    : Math.min(animation.time, duration);
}
