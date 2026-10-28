import { RULES } from '../core/config';

/** Fixed simulation clock. Long background gaps are discarded, never fast-forwarded. */
export class FixedLoop {
  private accumulator = 0;
  private previous = 0;
  private handle = 0;
  private elapsed = 0;
  private running = false;
  paused = false;
  onStep = (): void => {};
  onFrame = (_alpha: number, _elapsed: number, _dt: number): void => {};

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
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= RULES.dt && steps < 6) {
        this.onStep();
        this.accumulator -= RULES.dt;
        steps++;
      }
    } else this.accumulator = 0;
    this.onFrame(this.paused ? 1 : this.accumulator / RULES.dt, this.elapsed, dt);
    if (this.running) this.handle = requestAnimationFrame(this.frame);
  };
  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
  }
}
