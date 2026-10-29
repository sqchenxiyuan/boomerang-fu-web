import { integer } from './control';
import { MAX_REPLAY_TICKS, ReplayPlayer } from './recording';
import type { ReplayData } from './recording';

export interface ReplayLoop {
  start: number;
  end: number;
}
export interface ReplayTransportSnapshot {
  /** Process-local player identity, independent of the persisted recording identity. */
  id: number;
  tick: number;
  durationTicks: number;
  status: ReplayPlayer['status'];
  label: string;
  loop: ReplayLoop | null;
  scrubbing: boolean;
  /** Changes on discontinuities, so a host can invalidate visual/audio effects. */
  revision: number;
}

/** Clock-agnostic replay controls. No DOM, storage, renderer, timers or audio. */
let nextTransportId = 0;
export class ReplayTransport {
  private readonly id = ++nextTransportId;
  readonly player: ReplayPlayer;
  private range: ReplayLoop | null = null;
  private scrub: { tick: number; playing: boolean } | null = null;
  private revision = 0;
  constructor(data: ReplayData | string) {
    this.player = new ReplayPlayer(data);
  }
  snapshot(): ReplayTransportSnapshot {
    return {
      id: this.id,
      tick: this.player.tick,
      durationTicks: this.player.durationTicks,
      status: this.player.status,
      label: this.player.label,
      loop: this.range && { ...this.range },
      scrubbing: !!this.scrub,
      revision: this.revision,
    };
  }
  pause(): void {
    this.player.pause();
  }
  resume(): void {
    if (this.scrub) return;
    if (
      this.player.status === 'ended' ||
      (this.range && (this.player.tick < this.range.start || this.player.tick >= this.range.end))
    )
      this.seek(this.range?.start ?? 0);
    this.player.resume();
  }
  toggle(): void {
    this.player.status === 'playing' ? this.pause() : this.resume();
  }
  seek(tick: number): void {
    this.player.seek(tick);
    this.revision++;
  }
  /** Signed tick movement always leaves playback paused, including at either boundary. */
  stepFrames(delta: number): void {
    integer(delta, -MAX_REPLAY_TICKS, MAX_REPLAY_TICKS, 'delta');
    this.scrub = null;
    this.pause();
    this.seek(Math.max(0, Math.min(this.player.durationTicks, this.player.tick + delta)));
  }
  setLoop(range: ReplayLoop | null): void {
    if (range) {
      integer(range.start, 0, this.player.durationTicks, 'loop.start');
      integer(range.end, 0, this.player.durationTicks, 'loop.end');
      if (range.end <= range.start) throw new RangeError('Loop end must follow its start');
    }
    this.range = range && { ...range };
  }
  beginScrub(): void {
    if (this.scrub) return;
    this.scrub = { tick: this.player.tick, playing: this.player.status === 'playing' };
    this.pause();
  }
  endScrub(cancel = false): void {
    const scrub = this.scrub;
    this.scrub = null;
    if (!scrub) return;
    if (cancel) this.seek(scrub.tick);
    if (scrub.playing && this.player.status !== 'ended') this.player.resume();
  }
  /** Consume host-supplied simulation ticks, wrapping an A–B loop without changing physics dt. */
  advance(ticks = 1): void {
    integer(ticks, 1, MAX_REPLAY_TICKS, 'ticks');
    for (let left = ticks; left > 0 && this.player.status === 'playing'; ) {
      if (this.range && (this.player.tick < this.range.start || this.player.tick >= this.range.end))
        this.seek(this.range.start);
      const count = Math.min(
        left,
        (this.range?.end ?? this.player.durationTicks) - this.player.tick,
      );
      if (count <= 0) break;
      this.player.step(count);
      left -= count;
      if (this.range && this.player.tick >= this.range.end) this.seek(this.range.start);
    }
  }
}
