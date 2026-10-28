import * as Tone from 'tone';
import type { GameEvent } from '../core/types';

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
  private effects: Tone.PolySynth<Tone.FMSynth>;
  private impact: Tone.MembraneSynth;
  private swoosh: Tone.NoiseSynth;
  private swooshFilter: Tone.Filter;
  private scene: MusicScene = 'menu';
  private step = 0;
  private active = false;
  private recent = new Map<string, number>();
  private lastNoise = -1;
  private lastImpact = -1;
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
    this.effects = new Tone.PolySynth({
      context,
      voice: Tone.FMSynth,
      maxPolyphony: 16,
      options: {
        harmonicity: 2.4,
        modulationIndex: 5,
        envelope: { attack: 0.001, decay: 0.09, sustain: 0.02, release: 0.12 },
        modulationEnvelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.04 },
        volume: -12,
      },
    }).connect(this.sfx);
    this.impact = new Tone.MembraneSynth({
      context,
      octaves: 5,
      pitchDecay: 0.035,
      envelope: { attack: 0.001, decay: 0.14, sustain: 0.02, release: 0.15 },
      volume: -10,
    }).connect(this.sfx);
    this.swooshFilter = new Tone.Filter({
      context,
      frequency: 1800,
      type: 'bandpass',
      Q: 0.7,
    }).connect(this.sfx);
    this.swoosh = new Tone.NoiseSynth({
      context,
      noise: { type: 'pink' },
      envelope: { attack: 0.008, decay: 0.09, sustain: 0, release: 0.05 },
      volume: -11,
    }).connect(this.swooshFilter);
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
      this.effects.releaseAll();
      this.chords.releaseAll();
      this.melody.releaseAll();
    }
  }
  reset(): void {
    this.step = 0;
    this.recent.clear();
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
  private notes(notes: string[], time: number, gap = 0.055, velocity = 0.6): void {
    notes.forEach((note, i) =>
      this.effects.triggerAttackRelease(note, 0.065, time + i * gap, velocity),
    );
  }
  private noise(time: number, frequency: number, duration = 0.08, velocity = 0.5): void {
    if (time - this.lastNoise < 0.018) return;
    this.lastNoise = time;
    this.swooshFilter.frequency.setValueAtTime(frequency, time);
    this.swooshFilter.frequency.exponentialRampToValueAtTime(
      Math.max(100, frequency * 0.25),
      time + duration,
    );
    this.swoosh.triggerAttackRelease(duration, time, velocity);
  }
  private thump(time: number, note = 'C2', velocity = 0.55): void {
    if (time - this.lastImpact < 0.018) return;
    this.lastImpact = time;
    this.impact.triggerAttackRelease(note, 0.07, time, velocity);
  }
  play(events: readonly GameEvent[], time = this.context.now()): void {
    if (!this.active || this.settings.muted || this.settings.sfx === 0) return;
    let played = 0;
    for (const event of events) {
      if (played >= 12) break;
      const key = event.type === 'death' ? `${event.type}:${event.variant}` : event.type;
      if (time - (this.recent.get(key) ?? -100) < 0.045) continue;
      this.recent.set(key, time);
      const at = time + played++ * 0.001;
      this.effectEvents++;
      switch (event.type) {
        case 'throw':
          this.noise(at, 3200, 0.11, 0.48);
          this.notes(['A5', 'D5'], at, 0.045, 0.22);
          break;
        case 'dash':
          this.noise(at, 1200, 0.12, 0.48);
          break;
        case 'slash':
          this.noise(at, 4800, 0.07, 0.7);
          this.thump(at, 'G2', 0.25);
          break;
        case 'deflect':
          this.notes(['D6', 'A6', 'F6'], at, 0.025, 0.65);
          this.noise(at, 6500, 0.04, 0.3);
          break;
        case 'bounce':
          this.notes(['G5'], at, 0, 0.25);
          break;
        case 'catch':
          this.notes(['A4', 'D5'], at, 0.04, 0.32);
          break;
        case 'equip':
          this.notes(['D5', 'A5'], at, 0.065, 0.45);
          break;
        case 'shield':
          this.notes(['D5', 'A5', 'E6'], at, 0.025, 0.7);
          break;
        case 'crate':
          this.thump(at, 'G1', 0.6);
          this.noise(at, 1600, 0.09, 0.55);
          break;
        case 'death':
          if (event.variant === 'water') {
            this.noise(at, 950, 0.22, 0.75);
            this.notes(['G4', 'C4', 'G3'], at, 0.055, 0.3);
          } else if (event.variant === 'cliff')
            this.notes(['D5', 'A4', 'F4', 'D4', 'A3'], at, 0.065, 0.45);
          else {
            this.thump(at, event.variant === 'squash' ? 'G0' : 'D1', 0.85);
            this.noise(at, 2400, 0.14, 0.7);
          }
          break;
        case 'explosion':
          this.thump(at, 'C0', 1);
          this.noise(at, 900, 0.3, 1);
          break;
        case 'pickup':
          this.notes(['D5', 'F5', 'A5', 'D6'], at, 0.055, 0.6);
          break;
        case 'teleport':
          this.notes(['D4', 'A4', 'D5', 'A5', 'D6'], at, 0.035, 0.5);
          this.noise(at, 2200, 0.2, 0.35);
          break;
        case 'countdown':
          this.notes(['A5'], at, 0, 0.5);
          break;
        case 'boundary':
          this.notes(['D4', 'D5', 'A4', 'A5'], at, 0.11, 0.7);
          break;
        case 'freeze':
          this.notes(['F6', 'A6', 'D7'], at, 0.025, 0.35);
          break;
        case 'burn':
          this.noise(at, 3000, 0.12, 0.3);
          break;
        case 'split':
          this.notes(['D6', 'F6', 'A6'], at, 0.02, 0.35);
          break;
        case 'disguise':
          this.noise(at, 1600, 0.1, 0.25);
          this.notes(['A4', 'D4'], at, 0.07, 0.3);
          break;
        case 'decoy':
          this.notes(['D5', 'A5', 'D5'], at, 0.035, 0.3);
          break;
        case 'environment':
          this.thump(at, 'G2', 0.28);
          this.noise(at, 1400, 0.06, 0.2);
          break;
        case 'round':
          this.notes(['A4', 'D5'], at, 0.12, 0.3);
          break;
        case 'win':
          this.notes(['D5', 'F#5', 'A5', 'D6'], at, 0.16, 0.8);
          break;
      }
    }
  }
  dispose(): void {
    this.context.transport.clear(this.schedule);
    for (const node of [
      this.melody,
      this.chords,
      this.bass,
      this.kick,
      this.hat,
      this.hatFilter,
      this.effects,
      this.impact,
      this.swoosh,
      this.swooshFilter,
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
