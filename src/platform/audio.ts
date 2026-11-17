import * as Tone from 'tone';
import type { Arena, GameEvent, GameState } from '../core/types';
import { arenaCameraFrame } from '../rendering/arena-camera';
import { GardenAudioGraph } from './audio-score';
import type { AudioSettings, MusicScene } from './audio-types';
export type { AudioSettings } from './audio-types';

/** Gesture-unlocked, per-game Tone.js context. Audio never advances or randomizes physics. */
export class AudioEngine {
  private context: Tone.Context | null = null;
  private graph: GardenAudioGraph | null = null;
  private settings: AudioSettings = { music: 0.55, sfx: 0.75, muted: false };
  private scene: MusicScene = 'menu';
  private active = true;
  private disposed = false;
  private error: string | null = null;
  private stageKey = '';
  private stage = { centerX: 0, halfX: 10 };
  get muted(): boolean {
    return this.settings.muted;
  }
  getSettings(): AudioSettings {
    return { ...this.settings };
  }
  configure(settings: Partial<AudioSettings>): void {
    const next = { ...this.settings, ...settings };
    for (const key of ['music', 'sfx'] as const)
      if (!Number.isFinite(next[key]) || next[key] < 0 || next[key] > 1)
        throw new RangeError(`${key} volume must be 0..1`);
    if (typeof next.muted !== 'boolean') throw new TypeError('muted must be a boolean');
    this.settings = next;
    this.graph?.configure(next);
  }
  unlock(): void {
    if (this.disposed) return;
    try {
      if (!this.context) {
        this.context = new Tone.Context({
          latencyHint: 'interactive',
          lookAhead: 0.04,
          updateInterval: 0.02,
        });
        this.graph = new GardenAudioGraph(this.context);
        this.graph.configure(this.settings);
        this.graph.setStage(this.stage.centerX, this.stage.halfX);
        this.graph.setScene(this.scene, this.active);
      }
      void this.context.resume().catch((error: unknown) => {
        this.error = String(error);
      });
    } catch (error) {
      this.error = String(error);
    }
  }
  update(state: GameState, paused: boolean, preview: boolean): void {
    this.scene = preview
      ? 'menu'
      : state.phase === 'matchEnd'
        ? 'victory'
        : state.boundary.phase === 'shrinking'
          ? 'danger'
          : 'play';
    this.active = preview || !paused;
    this.setStage(state.arena, state.round);
    this.graph?.setScene(this.scene, this.active);
  }
  /** Pan against the span the camera frames (same framing as the renderer; world +x is screen right). */
  private setStage(arena: Arena, round: number): void {
    // Frame states are fresh clones; key like the renderer, which reframes per map and round.
    const key = `${arena.id ?? 'courtyard'}:${round}`;
    if (key === this.stageKey) return;
    this.stageKey = key;
    const frame = arenaCameraFrame(arena);
    this.stage = { centerX: arena.floors ? frame.center.x : 0, halfX: frame.half.x };
    this.graph?.setStage(this.stage.centerX, this.stage.halfX);
  }
  play(events: readonly GameEvent[]): void {
    this.graph?.play(events);
  }
  reset(): void {
    this.graph?.reset();
  }
  toggle(): boolean {
    this.configure({ muted: !this.muted });
    return this.muted;
  }
  stats(): {
    unlocked: boolean;
    contextState: string;
    scene: MusicScene;
    active: boolean;
    level: number;
    musicNotes: number;
    effectEvents: number;
    error: string | null;
  } {
    const level = this.graph?.meter.getValue() ?? 0;
    return {
      unlocked: !!this.context,
      contextState: this.context?.state ?? 'locked',
      scene: this.scene,
      active: this.active,
      level: Array.isArray(level) ? Math.max(...level) : level,
      musicNotes: this.graph?.musicNotes ?? 0,
      effectEvents: this.graph?.effectEvents ?? 0,
      error: this.error,
    };
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.graph?.dispose();
    if (this.context)
      void this.context
        .close()
        .then(() => this.context?.dispose())
        .catch(() => {});
    this.graph = null;
  }
}
