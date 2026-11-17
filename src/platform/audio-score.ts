import * as Tone from 'tone';
import type { GameEvent, PowerupKind } from '../core/types';

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

/** Effect voices are spread over this many panned lanes, picked round-robin. */
const SFX_LANES = 4;
/** Widest stereo position; full hard-panning is tiring on headphones. */
const PAN_WIDTH = 0.65;
/** A mono source through an equal-power panner at centre loses 3 dB per ear. */
const PAN_MAKEUP = Math.SQRT2;
/** Screen-level cues that stay centred and are deduplicated per type, not per actor. */
const CENTRED = new Set<GameEvent['type']>(['countdown', 'boundary', 'round', 'win']);
/** Pentatonic run in the score's key; kill streaks climb it. */
const STREAK_RUN = ['D5', 'F5', 'A5', 'D6', 'F6', 'A6', 'D7'];

interface Motif {
  notes: string[];
  gap: number;
  velocity: number;
  noise?: [frequency: number, duration: number, velocity: number];
  thump?: [note: string, velocity: number];
}
const PICKUP_DEFAULT: Motif = { notes: ['D5', 'F5', 'A5', 'D6'], gap: 0.055, velocity: 0.6 };
/** One short motif per power-up so a pickup can be told apart without looking. */
const PICKUP_MOTIFS: Partial<Record<PowerupKind, Motif>> = {
  shield: { notes: ['A4', 'D5', 'A5'], gap: 0.06, velocity: 0.55 },
  haste: { notes: ['D5', 'E5', 'F5', 'G5', 'A5'], gap: 0.026, velocity: 0.5 },
  explosive: { notes: ['D4', 'A4'], gap: 0.07, velocity: 0.5, thump: ['D1', 0.45] },
  wallDash: { notes: ['A4', 'E5', 'A5'], gap: 0.04, velocity: 0.45, noise: [1800, 0.12, 0.35] },
  // The one harmful pickup: a chromatic slide down reads as "uh-oh".
  reverse: { notes: ['F5', 'E5', 'D5', 'C#5'], gap: 0.075, velocity: 0.45 },
  multi: { notes: ['D6', 'A5', 'F6', 'D6'], gap: 0.03, velocity: 0.4 },
  teleport: { notes: ['D5', 'A5', 'D6'], gap: 0.03, velocity: 0.45, noise: [2200, 0.16, 0.3] },
  fire: { notes: ['A5', 'D6'], gap: 0.05, velocity: 0.45, noise: [3800, 0.18, 0.45] },
  extra: { notes: ['D6', 'D6'], gap: 0.08, velocity: 0.55 },
  ice: { notes: ['A6', 'D7', 'F7'], gap: 0.035, velocity: 0.35 },
  disguise: { notes: ['D4', 'A4'], gap: 0.07, velocity: 0.35, noise: [1600, 0.1, 0.25] },
  controlled: { notes: ['D5', 'F5', 'D5', 'A5'], gap: 0.045, velocity: 0.45 },
  shrink: { notes: ['A5', 'F5', 'D5', 'A4'], gap: 0.035, velocity: 0.45 },
  decoy: { notes: ['D5', 'A5', 'D5'], gap: 0.045, velocity: 0.4 },
};

/** Throttle key: one sound per event type and actor per window; paired reports collapse. */
function eventKey(event: GameEvent): string {
  // A disc-disc contact reports once for each disc, so both halves share one key.
  if (CENTRED.has(event.type) || event.type === 'clash') return event.type;
  if (event.type === 'death') return `death:${event.variant}:${event.actorId}`;
  return `${event.type}:${event.actorId}`;
}

/** One panned set of effect voices. Events rotate across lanes so overlapping sounds keep their own position. */
class SfxLane {
  private panner: Tone.Panner;
  private effects: Tone.PolySynth<Tone.FMSynth>;
  private impact: Tone.MembraneSynth;
  private swoosh: Tone.NoiseSynth;
  private swooshFilter: Tone.Filter;
  private lastNoise = -1;
  private lastImpact = -1;
  constructor(context: Tone.BaseContext, output: Tone.InputNode) {
    this.panner = new Tone.Panner({ context, pan: 0 }).connect(output);
    this.effects = new Tone.PolySynth({
      context,
      voice: Tone.FMSynth,
      maxPolyphony: 6,
      options: {
        harmonicity: 2.4,
        modulationIndex: 5,
        envelope: { attack: 0.001, decay: 0.09, sustain: 0.02, release: 0.12 },
        modulationEnvelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.04 },
        volume: -12,
      },
    }).connect(this.panner);
    this.impact = new Tone.MembraneSynth({
      context,
      octaves: 5,
      pitchDecay: 0.035,
      envelope: { attack: 0.001, decay: 0.14, sustain: 0.02, release: 0.15 },
      volume: -10,
    }).connect(this.panner);
    this.swooshFilter = new Tone.Filter({
      context,
      frequency: 1800,
      type: 'bandpass',
      Q: 0.7,
    }).connect(this.panner);
    this.swoosh = new Tone.NoiseSynth({
      context,
      noise: { type: 'pink' },
      envelope: { attack: 0.008, decay: 0.09, sustain: 0, release: 0.05 },
      volume: -11,
    }).connect(this.swooshFilter);
  }
  pan(value: number, time: number): void {
    this.panner.pan.setValueAtTime(value, time);
  }
  notes(notes: string[], time: number, gap = 0.055, velocity = 0.6): void {
    notes.forEach((note, i) =>
      this.effects.triggerAttackRelease(note, 0.065, time + i * gap, velocity),
    );
  }
  noise(time: number, frequency: number, duration = 0.08, velocity = 0.5): void {
    if (time - this.lastNoise < 0.018) return;
    this.lastNoise = time;
    this.swooshFilter.frequency.setValueAtTime(frequency, time);
    this.swooshFilter.frequency.exponentialRampToValueAtTime(
      Math.max(100, frequency * 0.25),
      time + duration,
    );
    this.swoosh.triggerAttackRelease(duration, time, velocity);
  }
  thump(time: number, note = 'C2', velocity = 0.55): void {
    if (time - this.lastImpact < 0.018) return;
    this.lastImpact = time;
    this.impact.triggerAttackRelease(note, 0.07, time, velocity);
  }
  motif(motif: Motif, time: number): void {
    this.notes(motif.notes, time, motif.gap, motif.velocity);
    if (motif.noise) this.noise(time, ...motif.noise);
    if (motif.thump) this.thump(time, ...motif.thump);
  }
  release(): void {
    this.effects.releaseAll();
  }
  dispose(): void {
    for (const node of [this.effects, this.impact, this.swoosh, this.swooshFilter, this.panner])
      node.dispose();
  }
}

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
  private lanes: SfxLane[];
  private lane = 0;
  private stage = { centerX: 0, halfX: 10 };
  private scene: MusicScene = 'menu';
  private step = 0;
  private active = false;
  private recent = new Map<string, number>();
  private schedule: number;
  private settings: AudioSettings = { music: 0.55, sfx: 0.75, muted: false };
  musicNotes = 0;
  effectEvents = 0;
  constructor(readonly context: Tone.BaseContext) {
    this.master = new Tone.Gain({ context, gain: 0.65 });
    this.music = new Tone.Gain({ context, gain: this.settings.music });
    this.sfx = new Tone.Gain({ context, gain: this.settings.sfx * PAN_MAKEUP });
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
    this.lanes = Array.from({ length: SFX_LANES }, () => new SfxLane(context, this.sfx));
    this.context.transport.bpm.value = TEMPO.menu;
    this.context.transport.swing = 0.08;
    this.schedule = this.context.transport.scheduleRepeat((time) => this.beat(time), '8n');
  }
  configure(settings: AudioSettings): void {
    this.settings = { ...settings };
    this.master.gain.rampTo(settings.muted ? 0 : 0.65, 0.025);
    this.music.gain.rampTo(this.active ? settings.music : 0, 0.08);
    this.sfx.gain.rampTo(this.active ? settings.sfx * PAN_MAKEUP : 0, 0.03);
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
      for (const lane of this.lanes) lane.release();
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
  private panFor(event: GameEvent): number {
    const x = event.position?.x;
    if (CENTRED.has(event.type) || !Number.isFinite(x)) return 0;
    const offset = (x - this.stage.centerX) / this.stage.halfX;
    return Math.max(-1, Math.min(1, offset)) * PAN_WIDTH;
  }
  private nextLane(event: GameEvent, time: number): SfxLane {
    const lane = this.lanes[this.lane];
    this.lane = (this.lane + 1) % this.lanes.length;
    lane.pan(this.panFor(event), time);
    return lane;
  }
  play(events: readonly GameEvent[], time = this.context.now()): void {
    if (!this.active || this.settings.muted || this.settings.sfx === 0) return;
    let played = 0;
    for (const event of events) {
      if (played >= 12) break;
      const key = eventKey(event);
      if (time - (this.recent.get(key) ?? -100) < 0.045) continue;
      this.recent.set(key, time);
      const at = time + played++ * 0.001;
      const lane = this.nextLane(event, at);
      this.effectEvents++;
      switch (event.type) {
        case 'throw': {
          // value is the release charge, 0..1; a full charge lands lower and heavier.
          const aim = Math.max(0, Math.min(1, event.value ?? 0));
          lane.noise(at, 3200 - 1500 * aim, 0.11 + 0.08 * aim, 0.48 + 0.22 * aim);
          if (aim >= 1) {
            lane.thump(at, 'D2', 0.45);
            lane.notes(['D5', 'A4', 'D4'], at, 0.04, 0.32);
          } else lane.notes(['A5', 'D5'], at, 0.045, 0.22);
          break;
        }
        case 'dash':
          lane.noise(at, 1200, 0.12, 0.48);
          break;
        case 'slash':
          lane.noise(at, 4800, 0.07, 0.7);
          lane.thump(at, 'G2', 0.25);
          break;
        case 'deflect':
          switch (event.feedback) {
            case 'parry':
              lane.notes(
                event.charged ? ['D6', 'A6', 'D7', 'F7'] : ['D6', 'A6', 'D7'],
                at,
                0.022,
                0.75,
              );
              lane.noise(at, 7200, 0.05, 0.4);
              if (event.charged) lane.thump(at, 'D2', 0.5);
              break;
            case 'clash':
              // Melee against melee: a blunt clank rather than the bright parry ring.
              lane.notes(['A5', 'E6'], at, 0.004, 0.6);
              lane.noise(at, 5200, 0.06, 0.55);
              lane.thump(at, 'A2', 0.35);
              break;
            case 'disarm':
              lane.thump(at, 'G2', 0.5);
              // value 1: the target was armed and its weapon clatters away.
              lane.notes(event.value ? ['A5', 'E5', 'C5'] : ['A5', 'E5'], at, 0.05, 0.45);
              if (event.value) lane.noise(at, 2600, 0.12, 0.4);
              break;
            default:
              lane.notes(['D6', 'A6', 'F6'], at, 0.025, 0.65);
              lane.noise(at, 6500, 0.04, 0.3);
          }
          break;
        case 'clash':
          // value 1: discs from different owners met; same-owner contacts only tick.
          if (event.value) {
            lane.notes(['E6', 'A6'], at, 0.008, 0.62);
            lane.noise(at, 8000, 0.045, 0.4);
            lane.thump(at, 'E3', 0.2);
          } else lane.notes(['E6'], at, 0, 0.28);
          break;
        case 'streak': {
          // value is the streak length (2+); land just after the kill's own impact.
          const count = Math.max(2, Math.round(event.value ?? 2)),
            start = Math.min(count - 2, 3),
            run = STREAK_RUN.slice(start, start + (count >= 4 ? 4 : 3));
          lane.notes(run, at + 0.12, 0.05, Math.min(0.9, 0.5 + 0.1 * count));
          if (count >= 3) lane.thump(at + 0.12, 'D1', 0.6);
          break;
        }
        case 'bounce':
          lane.notes(['G5'], at, 0, 0.25);
          break;
        case 'catch':
          lane.notes(['A4', 'D5'], at, 0.04, 0.32);
          break;
        case 'equip':
          lane.notes(['D5', 'A5'], at, 0.065, 0.45);
          break;
        case 'shield':
          lane.notes(['D5', 'A5', 'E6'], at, 0.025, 0.7);
          break;
        case 'crate':
          lane.thump(at, 'G1', 0.6);
          lane.noise(at, 1600, 0.09, 0.55);
          break;
        case 'death':
          if (event.variant === 'water') {
            lane.noise(at, 950, 0.22, 0.75);
            lane.notes(['G4', 'C4', 'G3'], at, 0.055, 0.3);
          } else if (event.variant === 'cliff')
            lane.notes(['D5', 'A4', 'F4', 'D4', 'A3'], at, 0.065, 0.45);
          else {
            lane.thump(at, event.variant === 'squash' ? 'G0' : 'D1', 0.85);
            lane.noise(at, 2400, 0.14, 0.7);
          }
          break;
        case 'explosion':
          lane.thump(at, 'C0', 1);
          lane.noise(at, 900, 0.3, 1);
          break;
        case 'pickup':
          lane.motif((event.power && PICKUP_MOTIFS[event.power]) || PICKUP_DEFAULT, at);
          break;
        case 'teleport':
          lane.notes(['D4', 'A4', 'D5', 'A5', 'D6'], at, 0.035, 0.5);
          lane.noise(at, 2200, 0.2, 0.35);
          break;
        case 'countdown':
          lane.notes(['A5'], at, 0, 0.5);
          break;
        case 'boundary':
          lane.notes(['D4', 'D5', 'A4', 'A5'], at, 0.11, 0.7);
          break;
        case 'freeze':
          lane.notes(['F6', 'A6', 'D7'], at, 0.025, 0.35);
          break;
        case 'burn':
          lane.noise(at, 3000, 0.12, 0.3);
          break;
        case 'split':
          lane.notes(['D6', 'F6', 'A6'], at, 0.02, 0.35);
          break;
        case 'disguise':
          lane.noise(at, 1600, 0.1, 0.25);
          lane.notes(['A4', 'D4'], at, 0.07, 0.3);
          break;
        case 'decoy':
          lane.notes(['D5', 'A5', 'D5'], at, 0.035, 0.3);
          break;
        case 'environment':
          lane.thump(at, 'G2', 0.28);
          lane.noise(at, 1400, 0.06, 0.2);
          break;
        case 'round':
          lane.notes(['A4', 'D5'], at, 0.12, 0.3);
          break;
        case 'win':
          lane.notes(['D5', 'F#5', 'A5', 'D6'], at, 0.16, 0.8);
          break;
      }
    }
  }
  dispose(): void {
    this.context.transport.clear(this.schedule);
    for (const lane of this.lanes) lane.dispose();
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
