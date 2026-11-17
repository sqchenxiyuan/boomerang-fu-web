/*
 * Real-time pacing for platform-driven play. The platform asks for up to six
 * frames at a playback speed; the pacer answers once enough wall-clock time
 * has passed, as a frame count. Time accrues as credit (60 frames per second
 * × speed), bounded to two seconds so a stall never becomes a huge jump, and
 * is dropped while paused or hidden. Simulation stays exact: the caller runs
 * precisely the returned number of fixed frames.
 */
export interface PacerHooks {
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (id: unknown) => void;
  hidden?: () => boolean;
  /** Subscribe to visibility changes; returns an unsubscribe function. */
  onVisibility?: (listener: () => void) => () => void;
}

const FRAME_MS = 1000 / 60;

export class FramePacer {
  paused = false;
  credit = 0;
  /** Wall time of the last frame handed out, for render interpolation. */
  lastFrameAt: number | null = null;
  speed = 1;
  private last: number | null = null;
  private finish: ((count: number) => void) | null = null;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (id: unknown) => void;
  private readonly hidden: () => boolean;
  private readonly onVisibility: (listener: () => void) => () => void;

  constructor(hooks: PacerHooks = {}) {
    this.now = hooks.now ?? (() => performance.now());
    this.schedule = hooks.schedule ?? ((callback, ms) => setTimeout(callback, ms));
    this.cancel = hooks.cancel ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.hidden = hooks.hidden ?? (() => globalThis.document?.hidden === true);
    this.onVisibility =
      hooks.onVisibility ??
      ((listener) => {
        const target = globalThis.document;
        target?.addEventListener('visibilitychange', listener);
        return () => target?.removeEventListener('visibilitychange', listener);
      });
  }

  reset(): void {
    this.pause(false);
  }

  /** Pausing drops all accrued time and settles a waiting request with 0. */
  pause(paused: boolean): void {
    this.paused = paused;
    this.last = null;
    this.credit = 0;
    this.finish?.(0);
  }

  /** Fraction of the next frame already elapsed (0..1), for interpolation. */
  alpha(): number {
    if (this.paused || this.lastFrameAt === null) return 1;
    return Math.max(0, Math.min(1, ((this.now() - this.lastFrameAt) * this.speed) / FRAME_MS));
  }

  /**
   * Resolves with 1..maxFrames once due (at least ⌈speed⌉ frames per batch
   * below 4×, a full batch from 4×), or 0 if paused. While hidden it waits.
   */
  next(maxFrames: number, speed: number): Promise<number> {
    this.finish?.(0);
    this.speed = speed;
    const batch = speed >= 4 ? maxFrames : Math.min(maxFrames, Math.ceil(speed));
    return new Promise((resolve) => {
      let timer: unknown = null;
      let unsubscribe: (() => void) | null = null;
      const finish = (count: number) => {
        if (this.finish !== finish) return;
        this.finish = null;
        if (timer !== null) this.cancel(timer);
        unsubscribe?.();
        if (count) this.lastFrameAt = this.now();
        resolve(count);
      };
      this.finish = finish;
      const tick = () => {
        timer = null;
        if (this.finish !== finish) return;
        if (this.paused) return finish(0);
        if (this.hidden()) {
          // Keep the request pending; resume on visibility without a catch-up burst.
          this.last = null;
          this.credit = 0;
          return;
        }
        const now = this.now();
        if (this.last === null) this.last = now - FRAME_MS;
        const elapsed = Math.max(0, Math.min(2000, now - this.last));
        this.last = now;
        this.credit = Math.min(120 * speed, this.credit + (elapsed / FRAME_MS) * speed);
        const due = Math.min(maxFrames, Math.floor(this.credit + 1e-5));
        if (due >= batch) {
          this.credit -= due;
          return finish(due);
        }
        const wait = Math.max(1, Math.ceil(((batch - this.credit) * FRAME_MS) / speed));
        timer = this.schedule(tick, wait);
      };
      unsubscribe = this.onVisibility(() => {
        if (timer !== null) this.cancel(timer);
        tick();
      });
      tick();
    });
  }
}
