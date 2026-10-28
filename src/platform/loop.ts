import { RULES } from '../core/config';

/** Fixed simulation clock. Long background gaps are discarded, never fast-forwarded. */
export class FixedLoop {
  private accumulator = 0;
  private previous = 0;
  private handle = 0;
  private elapsed = 0;
  private running = false;
  private scale = 1;
  private discarded = 0;
  private stepsTaken = 0;
  paused = false;
  onStep = (): boolean | void => {};
  onFrame = (_alpha: number, _elapsed: number, _dt: number): void => {};

  get timeScale(): number {
    return this.scale;
  }
  set timeScale(value: number) {
    if (!Number.isFinite(value) || value < 0.25 || value > 8)
      throw new RangeError('timeScale must be between 0.25 and 8');
    this.scale = value;
    this.reset();
  }
  stats(): { steps: number; discardedSeconds: number; timeScale: number } {
    return { steps: this.stepsTaken, discardedSeconds: this.discarded, timeScale: this.scale };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.previous = performance.now();
    this.handle = requestAnimationFrame(this.frame);
  }
  reset(): void {
    this.accumulator = 0;
    this.previous = performance.now();
  }
  private frame = (now: number): void => {
    if (!this.running) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.previous) / 1000));
    this.previous = now;
    this.elapsed += dt;
    if (!this.paused) {
      this.accumulator += dt * this.scale;
      // Never change the physics timestep. Bound catch-up latency when a device
      // cannot sustain the requested speed, leaving the renderer responsive.
      const backlog = RULES.dt * 96;
      if (this.accumulator > backlog) {
        this.discarded += this.accumulator - backlog;
        this.accumulator = backlog;
      }
      let steps = 0;
      const workStarted = performance.now();
      while (!this.paused && this.accumulator >= RULES.dt && steps < 48) {
        if (this.onStep() === false) {
          this.accumulator = 0;
          break;
        }
        this.accumulator -= RULES.dt;
        steps++;
        this.stepsTaken++;
        if (performance.now() - workStarted >= 12) break;
      }
    } else this.accumulator = 0;
    this.onFrame(this.paused ? 1 : Math.min(1, this.accumulator / RULES.dt), this.elapsed, dt);
    if (this.running) this.handle = requestAnimationFrame(this.frame);
  };
  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
  }
}
