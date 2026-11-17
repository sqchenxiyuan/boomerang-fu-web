import { Rng, levelTo, roomImpulse, type Mono } from './dsp';
import { RECIPES, SOUND_NAMES, chime, type Recipe, type SoundName } from './recipes';

/*
 * Plays the generated sound bank on a WebAudio context. Buffers are rendered
 * from the recipes in small idle slices after unlock (or on demand), then
 * played with variant rotation, slight pitch/level jitter, stereo position,
 * a shared room reverb and per-sound voice limits. Presentation only: nothing
 * here reads or changes the simulation.
 */
export interface PlayOptions {
  /** -1 (left) .. 1 (right). */
  pan?: number;
  gain?: number;
  /** Playback-rate multiplier (pitch and speed). */
  rate?: number;
  /** Seconds from now. */
  delay?: number;
  /** Pitch/level randomisation (default true). */
  jitter?: boolean;
}
export interface LoopOptions {
  gain: number;
  rate?: number;
  pan?: number;
}

interface Voice {
  source: AudioBufferSourceNode;
  started: number;
}
interface LoopVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode;
  touched: boolean;
}

const MAX_VOICES = 28;

export class SfxPlayer {
  private readonly raw: BaseAudioContext;
  private readonly input: GainNode;
  private readonly reverbSend: GainNode;
  private readonly buffers = new Map<string, AudioBuffer[]>();
  private readonly lastVariant = new Map<string, number>();
  private readonly lastStart = new Map<string, number>();
  private readonly active = new Map<string, Voice[]>();
  private readonly loops = new Map<string, LoopVoice>();
  private readonly rng = new Rng(0x5f1);
  private queue: SoundName[] = [];
  private warming = 0;
  private total = 0;
  private disposed = false;
  played = 0;

  /** `connect` attaches a node of this context to the effects bus. */
  constructor(raw: BaseAudioContext, connect: (node: AudioNode) => void) {
    this.raw = raw;
    this.input = raw.createGain();
    connect(this.input);
    // A small, bright room: glues the effects together without washing them out.
    const convolver = raw.createConvolver();
    const [left, right] = roomImpulse(raw.sampleRate, 77);
    const impulse = raw.createBuffer(2, left.length, raw.sampleRate);
    impulse.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
    impulse.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
    convolver.buffer = impulse;
    this.reverbSend = raw.createGain();
    const wet = raw.createGain();
    wet.gain.value = 0.55;
    this.reverbSend.connect(convolver);
    convolver.connect(wet);
    connect(wet);
  }

  /** Render the whole bank in idle slices (most used sounds first). */
  prewarm(): void {
    if (this.queue.length || this.disposed) return;
    const first: SoundName[] = [
      'footstep',
      'throw',
      'catch',
      'melee',
      'dash',
      'ricoStone',
      'deathSlice',
      'parry',
    ];
    this.queue = [...first, ...SOUND_NAMES.filter((name) => !first.includes(name))].filter(
      (name) => !this.buffers.has(name),
    );
    const slice = () => {
      if (this.disposed) return;
      const started = performance.now();
      while (this.queue.length && performance.now() - started < 8) this.ensure(this.queue.shift()!);
      if (this.queue.length) this.warming = window.setTimeout(slice, 16);
    };
    this.warming = window.setTimeout(slice, 30);
  }

  private toBuffer(data: Mono): AudioBuffer {
    const buffer = this.raw.createBuffer(1, data.length, this.raw.sampleRate);
    buffer.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    return buffer;
  }

  private ensure(name: SoundName): AudioBuffer[] {
    let list = this.buffers.get(name);
    if (!list) {
      const recipe: Recipe = RECIPES[name];
      list = Array.from({ length: recipe.variants }, (_, variant) =>
        // Even perceived loudness first; the recipe gain then sets the mix.
        this.toBuffer(
          levelTo(
            recipe.render(this.raw.sampleRate, new Rng(hash(name) + variant * 7919), variant),
            this.raw.sampleRate,
          ),
        ),
      );
      this.buffers.set(name, list);
    }
    return list;
  }

  private now(): number {
    return this.raw.currentTime;
  }

  private voice(
    buffer: AudioBuffer,
    gain: number,
    pan: number,
    rate: number,
    send: number,
    at: number,
  ): AudioBufferSourceNode {
    const source = this.raw.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const level = this.raw.createGain();
    level.gain.value = gain;
    const panner = this.raw.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    source.connect(level);
    level.connect(panner);
    panner.connect(this.input);
    if (send > 0) {
      const sendGain = this.raw.createGain();
      sendGain.gain.value = send;
      panner.connect(sendGain);
      sendGain.connect(this.reverbSend);
      source.addEventListener('ended', () => sendGain.disconnect(), { once: true });
    }
    source.addEventListener(
      'ended',
      () => {
        level.disconnect();
        panner.disconnect();
      },
      { once: true },
    );
    source.start(at);
    return source;
  }

  play(name: SoundName, options: PlayOptions = {}): boolean {
    if (this.disposed) return false;
    const recipe: Recipe = RECIPES[name];
    const at = this.now() + Math.max(0, options.delay ?? 0);
    if (at - (this.lastStart.get(name) ?? -1) < (recipe.cooldown ?? 0.025)) return false;
    const voices = (this.active.get(name) ?? []).filter((v) => v.started > this.now() - 4);
    if (voices.length >= (recipe.voices ?? 4)) {
      // Steal the oldest voice of this sound rather than piling up.
      try {
        voices.shift()!.source.stop();
      } catch {
        /* already ended */
      }
    }
    if (this.total >= MAX_VOICES) return false;
    const list = this.ensure(name);
    let variant = Math.floor(this.rng.next() * list.length);
    if (list.length > 1 && variant === this.lastVariant.get(name))
      variant = (variant + 1) % list.length;
    this.lastVariant.set(name, variant);
    this.lastStart.set(name, at);
    const jitter = options.jitter !== false;
    const rate = (options.rate ?? 1) * (jitter ? this.rng.range(0.96, 1.04) : 1);
    const gain = recipe.gain * (options.gain ?? 1) * (jitter ? this.rng.range(0.9, 1.05) : 1);
    const source = this.voice(
      list[variant],
      gain,
      options.pan ?? 0,
      rate,
      recipe.reverb ?? 0.1,
      at,
    );
    const entry = { source, started: at };
    voices.push(entry);
    this.active.set(name, voices);
    this.total++;
    this.played++;
    source.addEventListener(
      'ended',
      () => {
        this.total--;
        const list = this.active.get(name);
        if (list) {
          const i = list.indexOf(entry);
          if (i >= 0) list.splice(i, 1);
        }
      },
      { once: true },
    );
    return true;
  }

  private notes = new Map<number, AudioBuffer>();
  /** A pitched chime by MIDI note (pickup motifs, streak runs). */
  note(midi: number, options: PlayOptions = {}): void {
    if (this.disposed || this.total >= MAX_VOICES) return;
    let buffer = this.notes.get(midi);
    if (!buffer) {
      buffer = this.toBuffer(chime(this.raw.sampleRate, midi, 0.5));
      this.notes.set(midi, buffer);
    }
    const source = this.voice(
      buffer,
      0.32 * (options.gain ?? 1),
      options.pan ?? 0,
      1,
      0.25,
      this.now() + (options.delay ?? 0),
    );
    this.total++;
    source.addEventListener('ended', () => this.total--, { once: true });
  }

  /** Keep a looping sound alive this frame; untouched loops fade out in `endFrame`. */
  loop(key: string, name: SoundName, options: LoopOptions): void {
    if (this.disposed) return;
    let loop = this.loops.get(key);
    const now = this.now();
    if (!loop) {
      const source = this.raw.createBufferSource();
      source.buffer = this.ensure(name)[0];
      source.loop = true;
      const gain = this.raw.createGain();
      gain.gain.value = 0;
      const panner = this.raw.createStereoPanner();
      source.connect(gain);
      gain.connect(panner);
      panner.connect(this.input);
      source.start(now, this.rng.next() * (source.buffer.duration * 0.9));
      loop = { source, gain, panner, touched: true };
      this.loops.set(key, loop);
    }
    loop.touched = true;
    loop.gain.gain.setTargetAtTime((RECIPES[name] as Recipe).gain * options.gain, now, 0.06);
    loop.source.playbackRate.setTargetAtTime(options.rate ?? 1, now, 0.05);
    loop.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, options.pan ?? 0)), now, 0.05);
  }

  endFrame(): void {
    const now = this.now();
    for (const [key, loop] of this.loops) {
      if (loop.touched) {
        loop.touched = false;
        continue;
      }
      loop.gain.gain.setTargetAtTime(0, now, 0.08);
      loop.source.stop(now + 0.5);
      this.loops.delete(key);
    }
  }

  /** Stop every loop (pause, round reset). One-shots finish naturally. */
  silenceLoops(): void {
    for (const loop of this.loops.values()) loop.touched = false;
    this.endFrame();
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.warming);
    for (const loop of this.loops.values())
      try {
        loop.source.stop();
      } catch {
        /* ended */
      }
    this.loops.clear();
    this.input.disconnect();
    this.reverbSend.disconnect();
  }
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
