import * as Tone from 'tone';
import type { GameEvent, GameState } from '../core/types';
import { SfxDirector } from './sfx/director';
import { SfxPlayer } from './sfx/player';

import type { MusicScene, AudioSettings } from './audio-types';
const CHORDS = [
  ['D4', 'F4', 'A4'],
  ['C4', 'E4', 'G4'],
  ['Bb3', 'D4', 'F4'],
  ['C4', 'E4', 'G4'],
];
const ROOTS = ['D2', 'C2', 'Bb1', 'C2'];
const MELODY = [
  ['D5', null, 'F5', 'A5', null, 'G5', 'F5', null],
  ['E5', 'G5', null, 'C6', 'G5', null, 'E5', 'D5'],
  ['F5', null, 'D5', 'F5', 'A5', 'F5', null, 'D5'],
  ['E5', 'G5', 'A5', null, 'G5', 'E5', 'D5', null],
  ['A5', null, 'F5', 'D5', 'F5', null, 'G5', 'A5'],
  ['G5', 'E5', null, 'G5', 'C6', null, 'G5', 'E5'],
  ['D5', 'F5', 'A5', 'D6', null, 'A5', 'F5', null],
  ['E5', null, 'G5', 'A5', 'G5', 'E5', 'D5', null],
];
const TEMPO = { menu: 96, play: 132, danger: 158, victory: 112 };

/** Widest stereo position; full hard-panning is tiring on headphones. */
const PAN_WIDTH = 0.65;

/** Original score, scheduled on the supplied context rather than a global transport. */
export class GardenAudioGraph {
  readonly master: Tone.Gain;
  readonly music: Tone.Gain;
  readonly sfx: Tone.Gain;
  readonly meter: Tone.Meter;
  private limiter: Tone.Limiter;
  private echo: Tone.FeedbackDelay;
  private melody: Tone.PolySynth<Tone.FMSynth>;
  private chords: Tone.PolySynth<Tone.Synth>;
  private bass: Tone.Synth;
  private kick: Tone.MembraneSynth;
  private hat: Tone.NoiseSynth;
  private hatFilter: Tone.Filter;
  readonly effects: SfxPlayer;
  private director: SfxDirector;
  private stage = { centerX: 0, halfX: 10 };
  private scene: MusicScene = 'menu';
  private step = 0;
  private active = false;
  private schedule: number;
  private settings: AudioSettings = { music: 0.55, sfx: 0.75, muted: false };
  musicNotes = 0;
  effectEvents = 0;
  constructor(readonly context: Tone.BaseContext) {
    this.master = new Tone.Gain({ context, gain: 0.65 });
    this.music = new Tone.Gain({ context, gain: this.settings.music });
    this.sfx = new Tone.Gain({ context, gain: this.settings.sfx });
    this.limiter = new Tone.Limiter({ context, threshold: -3 });
    this.meter = new Tone.Meter({ context, normalRange: true, smoothing: 0.2 });
    this.master.connect(this.limiter);
    this.limiter.toDestination();
    this.limiter.connect(this.meter);
    this.music.connect(this.master);
    this.sfx.connect(this.master);
    this.echo = new Tone.FeedbackDelay({
      context,
      delayTime: 0.14,
      feedback: 0.15,
      wet: 0.12,
    }).connect(this.music);
    this.melody = new Tone.PolySynth({
      context,
      voice: Tone.FMSynth,
      maxPolyphony: 8,
      options: {
        harmonicity: 3,
        modulationIndex: 2.5,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.002, decay: 0.18, sustain: 0.02, release: 0.18 },
        modulationEnvelope: { attack: 0.002, decay: 0.12, sustain: 0, release: 0.1 },
        volume: -16,
      },
    }).connect(this.echo);
    this.chords = new Tone.PolySynth({
      context,
      voice: Tone.Synth,
      maxPolyphony: 8,
      options: {
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.02, decay: 0.18, sustain: 0.12, release: 0.3 },
        volume: -25,
      },
    }).connect(this.music);
    this.bass = new Tone.Synth({
      context,
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.005, decay: 0.12, sustain: 0.2, release: 0.12 },
      volume: -19,
    }).connect(this.music);
    this.kick = new Tone.MembraneSynth({
      context,
      pitchDecay: 0.025,
      octaves: 4,
      envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.03 },
      volume: -15,
    }).connect(this.music);
    this.hatFilter = new Tone.Filter({ context, frequency: 6500, type: 'highpass' }).connect(
      this.music,
    );
    this.hat = new Tone.NoiseSynth({
      context,
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.028, sustain: 0, release: 0.01 },
      volume: -29,
    }).connect(this.hatFilter);
    // Generated effects bank on the same context, feeding the effects bus.
    const raw = context.rawContext as unknown as BaseAudioContext;
    this.effects = new SfxPlayer(raw, (node) =>
      Tone.connect(node as unknown as Tone.OutputNode, this.sfx),
    );
    this.director = new SfxDirector(this.effects, (x) => this.panX(x));
    this.effects.prewarm();
    this.context.transport.bpm.value = TEMPO.menu;
    this.context.transport.swing = 0.08;
    this.schedule = this.context.transport.scheduleRepeat((time) => this.beat(time), '8n');
  }
  configure(settings: AudioSettings): void {
    this.settings = { ...settings };
    this.master.gain.rampTo(settings.muted ? 0 : 0.65, 0.025);
    this.music.gain.rampTo(this.active ? settings.music : 0, 0.08);
    this.sfx.gain.rampTo(this.active ? settings.sfx : 0, 0.03);
  }
  /** World-space horizontal span the camera frames; world +x is screen right. */
  setStage(centerX: number, halfX: number): void {
    if (Number.isFinite(centerX) && Number.isFinite(halfX) && halfX > 0)
      this.stage = { centerX, halfX };
  }
  setScene(scene: MusicScene, active: boolean): void {
    if (scene !== this.scene) {
      this.scene = scene;
      this.context.transport.bpm.rampTo(TEMPO[scene], 0.4);
    }
    if (active === this.active) return;
    this.active = active;
    this.configure(this.settings);
    if (active) this.context.transport.start();
    else {
      this.context.transport.pause();
      this.effects.silenceLoops();
      this.chords.releaseAll();
      this.melody.releaseAll();
    }
  }
  reset(): void {
    this.step = 0;
    this.director.reset();
  }
  /** Send the limited mix to an extra native node (a recorder) as well. */
  tap(node: AudioNode): void {
    Tone.connect(this.limiter, node as unknown as Tone.InputNode);
  }
  untap(node: AudioNode): void {
    try {
      this.limiter.disconnect(node as unknown as Tone.InputNode);
    } catch {
      /* already disconnected */
    }
  }
  /** Per rendered frame: state-driven effects (footsteps, loops, landings). */
  observe(state: GameState, dt: number): void {
    if (this.settings.muted || this.settings.sfx === 0) {
      this.effects.silenceLoops();
      return;
    }
    this.director.observe(state, dt, this.active);
  }
  private beat(time: number): void {
    if (!this.active) return;
    const index = this.step++ % 64,
      bar = Math.floor(index / 8),
      beat = index % 8,
      chord = bar % 4;
    const sparse = this.scene === 'menu';
    const note =
      this.scene === 'victory'
        ? ['D5', 'F#5', 'A5', 'D6', null, 'A5', 'D6', null][beat]
        : MELODY[bar][beat];
    if (note && (!sparse || beat % 2 === 0)) {
      this.melody.triggerAttackRelease(note, '16n', time, beat % 2 === 0 ? 0.75 : 0.5);
      this.musicNotes++;
    }
    if (beat === 0 || beat === 4) {
      this.bass.triggerAttackRelease(ROOTS[chord], '8n', time, 0.7);
      this.chords.triggerAttackRelease(CHORDS[chord], '8n', time, 0.5);
      if (!sparse) this.kick.triggerAttackRelease('C1', '16n', time, 0.7);
    }
    if (!sparse && (beat % 2 === 1 || this.scene === 'danger'))
      this.hat.triggerAttackRelease('32n', time, beat % 2 ? 0.6 : 0.35);
  }
  /** Stereo position of a world x against the span the camera frames. */
  private panX(x: number): number {
    const offset = (x - this.stage.centerX) / this.stage.halfX;
    return Math.max(-1, Math.min(1, offset)) * PAN_WIDTH;
  }
  play(events: readonly GameEvent[]): void {
    if (!this.active || this.settings.muted || this.settings.sfx === 0) return;
    this.effectEvents += events.length;
    this.director.events(events);
  }
  dispose(): void {
    this.context.transport.clear(this.schedule);
    this.effects.dispose();
    for (const node of [
      this.melody,
      this.chords,
      this.bass,
      this.kick,
      this.hat,
      this.hatFilter,
      this.echo,
      this.music,
      this.sfx,
      this.master,
      this.limiter,
      this.meter,
    ])
      node.dispose();
  }
}
