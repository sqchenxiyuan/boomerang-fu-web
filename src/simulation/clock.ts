import { NATIVE } from '../core/config';
import type { ClockState, GameState } from '../core/types';

/**
 * TimeKeeper from the reference simulation. Freeze frames stop scaled time; slow
 * motion eases from 1 to `slowScale` over `slowIn`, holds, then eases back over
 * `slowOut`. Both advance in unscaled seconds, once per rendered (60 Hz) frame.
 *
 * Unity performs fewer FixedUpdates while slowed. The Web simulation instead
 * advances every system once per frame with `dt × timeScale`, which keeps the
 * fixed-rate SDK/replay contract and smooth rendering at the cost of exact
 * fixed-step parity during slow motion.
 */
const easeIn = (t: number): number => 1 - Math.cos((Math.PI / 2) * t);
const easeOut = (t: number): number => Math.sin((Math.PI / 2) * t);
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

export const createClock = (): ClockState => ({
  timeScale: 1,
  slowScale: NATIVE.slowMo.scale,
  slowTimer: Number.MAX_VALUE,
  slowIn: 0,
  slowHold: 0,
  slowOut: 0,
  slowMo: false,
  locked: false,
});

export function clockOf(state: GameState): ClockState {
  state.clock ??= createClock();
  return state.clock;
}

/** Current scale of simulated time. Freeze frames are tracked by `state.hitStop`. */
export function timeScale(state: GameState): number {
  return state.hitStop > 0 ? 0 : (state.clock?.timeScale ?? 1);
}

export function stopSlowMo(clock: ClockState): void {
  clock.locked = false;
  clock.slowMo = false;
  clock.slowTimer = Number.MAX_VALUE;
  clock.slowIn = 0;
  clock.slowHold = 0;
  clock.slowOut = 0;
  clock.timeScale = 1;
}

export function resetClock(state: GameState): void {
  state.clock = createClock();
  state.hitStop = 0;
}

/** TimeKeeper.SlowMoEffect(holdDuration, lerpInDuration = .1, scale = .2, force). */
export function slowMo(
  state: GameState,
  hold: number,
  lerpIn = 0.1,
  scale: number = NATIVE.slowMo.scale,
  force = false,
): void {
  const clock = clockOf(state);
  if (clock.locked && !force) return;
  const current = timeScale(state);
  if (scale < current || current === 0) clock.slowScale = scale;
  if (!clock.slowMo) {
    clock.slowIn = lerpIn;
    clock.slowTimer = 0;
  }
  clock.slowOut = hold;
  if (clock.slowMo) {
    if (clock.slowTimer > clock.slowIn + clock.slowHold - clock.slowHold * 0.15) {
      clock.slowTimer = clock.slowIn;
      clock.slowHold = hold * 0.4;
    }
    clock.slowHold += hold * 0.2;
  } else clock.slowHold += hold;
}

/** TimeKeeper.EndMatch: a forced, locked crawl. */
export function endMatchSlowMo(state: GameState): void {
  const { hold, lerpIn, scale } = NATIVE.slowMo.matchEnd;
  const clock = clockOf(state);
  clock.locked = false;
  slowMo(state, hold, lerpIn, scale, true);
  clock.locked = true;
}

/** TimeKeeper.Freeze: holds scaled time at zero for `duration` unscaled seconds. */
export function freeze(state: GameState, duration: number): void {
  state.hitStop = Math.max(state.hitStop, duration);
}

/** TimeKeeper.Update for one unscaled frame. Returns the scale used for that frame. */
export function advanceClock(state: GameState, dt: number): number {
  const clock = clockOf(state);
  let scale = 1;
  const total = clock.slowIn + clock.slowHold + clock.slowOut;
  if (clock.slowTimer < total) {
    clock.slowMo = true;
    clock.slowTimer += dt;
    let amount: number;
    if (clock.slowTimer < clock.slowIn) amount = easeOut(clamp01(clock.slowTimer / clock.slowIn));
    else if (clock.slowTimer < clock.slowIn + clock.slowHold || clock.locked) amount = 1;
    else
      amount = easeIn(
        1 - clamp01((clock.slowTimer - clock.slowHold - clock.slowIn) / clock.slowOut),
      );
    scale = 1 + (clock.slowScale - 1) * clamp01(amount);
  } else if (clock.slowMo && !clock.locked) stopSlowMo(clock);
  else if (clock.locked) scale = clock.slowScale;
  clock.timeScale = scale;
  // Slow motion keeps advancing in unscaled time underneath a freeze frame.
  if (state.hitStop > 0) {
    state.hitStop = Math.max(0, state.hitStop - dt - 1e-10);
    return 0;
  }
  return scale;
}
