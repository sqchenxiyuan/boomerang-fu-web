/*
 * A small offline DSP kit for sound design. Everything renders to mono
 * Float32Array buffers, deterministically from a seed, without WebAudio, so the
 * same recipes run in the browser (into AudioBuffers) and in Node (tests,
 * spectrogram sheets). No sample data is loaded from anywhere.
 */
export type Mono = Float32Array;
const TAU = Math.PI * 2;

/** mulberry32: small, fast and seedable. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  /** White noise sample in [-1, 1). */
  white(): number {
    return this.next() * 2 - 1;
  }
}

export const buffer = (seconds: number, sr: number): Mono =>
  new Float32Array(Math.max(1, Math.round(seconds * sr)));

/** Paul Kellet's refined pink filter. */
export class Pink {
  private b = [0, 0, 0, 0, 0, 0, 0];
  next(white: number): number {
    const b = this.b;
    b[0] = 0.99886 * b[0] + white * 0.0555179;
    b[1] = 0.99332 * b[1] + white * 0.0750759;
    b[2] = 0.969 * b[2] + white * 0.153852;
    b[3] = 0.8665 * b[3] + white * 0.3104856;
    b[4] = 0.55 * b[4] + white * 0.5329522;
    b[5] = -0.7616 * b[5] - white * 0.016898;
    const out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + white * 0.5362;
    b[6] = white * 0.115926;
    return out * 0.11;
  }
}
/** Leaky integrator: rumble and roar. */
export class Brown {
  private last = 0;
  next(white: number): number {
    this.last = (this.last + 0.02 * white) / 1.02;
    return this.last * 3.5;
  }
}

/** RBJ cookbook biquad; parameters may change every sample. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(private readonly sr: number) {}
  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): this {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }
  private omega(frequency: number): [number, number] {
    const w = (TAU * Math.min(frequency, this.sr * 0.45)) / this.sr;
    return [Math.cos(w), Math.sin(w)];
  }
  lowpass(frequency: number, q = 0.707): this {
    const [c, s] = this.omega(frequency),
      alpha = s / (2 * q);
    return this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }
  highpass(frequency: number, q = 0.707): this {
    const [c, s] = this.omega(frequency),
      alpha = s / (2 * q);
    return this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }
  /** Band-pass with 0 dB peak gain. */
  bandpass(frequency: number, q = 1): this {
    const [c, s] = this.omega(frequency),
      alpha = s / (2 * q);
    return this.set(alpha, 0, -alpha, 1 + alpha, -2 * c, 1 - alpha);
  }
  peaking(frequency: number, q: number, gainDb: number): this {
    const [c, s] = this.omega(frequency),
      alpha = s / (2 * q),
      a = Math.pow(10, gainDb / 40);
    return this.set(1 + alpha * a, -2 * c, 1 - alpha * a, 1 + alpha / a, -2 * c, 1 - alpha / a);
  }
  process(x: number): number {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Exponential interpolation from a to b over 0..1. */
export const expLerp = (a: number, b: number, t: number): number =>
  a * Math.pow(b / a, Math.min(1, Math.max(0, t)));
export const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
/** Smooth attack, exponential release: the default one-shot envelope. */
export function envelope(t: number, attack: number, decay: number): number {
  if (t < 0) return 0;
  if (t < attack) {
    const x = t / attack;
    return x * x * (3 - 2 * x);
  }
  return Math.exp(-(t - attack) / decay);
}
/** Rises to 1 at `peak` (fraction of duration) and falls to 0 at the end. */
export function bell(t: number, duration: number, peak = 0.35, sharpness = 1.6): number {
  const x = t / duration;
  if (x <= 0 || x >= 1) return 0;
  const shape = x < peak ? x / peak : 1 - (x - peak) / (1 - peak);
  return Math.pow(Math.sin((shape * Math.PI) / 2), sharpness);
}

export function mixInto(target: Mono, source: Mono, offset = 0, gain = 1): Mono {
  const start = Math.max(0, Math.round(offset));
  const n = Math.min(source.length, target.length - start);
  for (let i = 0; i < n; i++) target[start + i] += source[i] * gain;
  return target;
}
export function peak(signal: Mono): number {
  let max = 0;
  for (let i = 0; i < signal.length; i++) max = Math.max(max, Math.abs(signal[i]));
  return max;
}
export function normalize(signal: Mono, target = 0.9): Mono {
  const max = peak(signal);
  if (max > 0) for (let i = 0; i < signal.length; i++) signal[i] *= target / max;
  return signal;
}
/** RMS of the loudest 50 ms window: a rough perceived-loudness measure. */
export function loudness(signal: Mono, sr: number): number {
  const window = Math.max(1, Math.round(sr * 0.05));
  let sum = 0,
    best = 0;
  for (let i = 0; i < signal.length; i++) {
    sum += signal[i] * signal[i];
    if (i >= window) sum -= signal[i - window] * signal[i - window];
    best = Math.max(best, sum);
  }
  return Math.sqrt(best / Math.min(window, signal.length));
}
/** Scale to a target loudness without letting any sample exceed `ceiling`. */
export function levelTo(signal: Mono, sr: number, target = 0.2, ceiling = 0.98): Mono {
  const rms = loudness(signal, sr),
    max = peak(signal);
  if (rms <= 0 || max <= 0) return signal;
  const scale = Math.min(target / rms, ceiling / max);
  for (let i = 0; i < signal.length; i++) signal[i] *= scale;
  return signal;
}
/** Short fades so no sound ever starts or stops with a click. */
export function fade(signal: Mono, sr: number, inSeconds = 0.0015, outSeconds = 0.012): Mono {
  const fin = Math.min(signal.length, Math.round(inSeconds * sr)),
    fout = Math.min(signal.length, Math.round(outSeconds * sr));
  for (let i = 0; i < fin; i++) signal[i] *= i / fin;
  for (let i = 0; i < fout; i++) signal[signal.length - 1 - i] *= i / fout;
  return signal;
}
export function removeDC(signal: Mono): Mono {
  let x1 = 0,
    y1 = 0;
  for (let i = 0; i < signal.length; i++) {
    const y = signal[i] - x1 + 0.995 * y1;
    x1 = signal[i];
    signal[i] = y1 = y;
  }
  return signal;
}
export function saturate(signal: Mono, drive: number): Mono {
  const norm = Math.tanh(drive);
  for (let i = 0; i < signal.length; i++) signal[i] = Math.tanh(signal[i] * drive) / norm;
  return signal;
}
/** Trim trailing near-silence (after the tail has decayed). */
export function trim(signal: Mono, sr: number, threshold = 0.0008): Mono {
  let end = signal.length;
  while (end > sr * 0.02 && Math.abs(signal[end - 1]) < threshold) end--;
  return signal.subarray(0, Math.min(signal.length, end + Math.round(sr * 0.005)));
}

/* ----------------------------------------------------------- generators */

export interface WhooshOptions {
  duration: number;
  from: number;
  to: number;
  /** Optional third point: from → mid at `peak`, then → to. */
  mid?: number;
  q?: number;
  peak?: number;
  /** Amplitude-modulation rate (Hz) and depth: a boomerang's whup-whup. */
  wobble?: number;
  wobbleDepth?: number;
  /** Extra octave-up air layer, 0..1. */
  air?: number;
  noise?: 'white' | 'pink';
}
/** Band-passed noise swept through a bell envelope. */
export function whoosh(sr: number, rng: Rng, o: WhooshOptions): Mono {
  const out = buffer(o.duration, sr),
    body = new Biquad(sr),
    top = new Biquad(sr),
    pink = new Pink();
  const peakAt = o.peak ?? 0.35;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr,
      x = t / o.duration;
    const f =
      o.mid === undefined
        ? expLerp(o.from, o.to, x)
        : x < peakAt
          ? expLerp(o.from, o.mid, x / peakAt)
          : expLerp(o.mid, o.to, (x - peakAt) / (1 - peakAt));
    body.bandpass(f, o.q ?? 1.1);
    top.bandpass(f * 2.1, (o.q ?? 1.1) * 1.4);
    const w = rng.white(),
      n = o.noise === 'white' ? w : pink.next(w) * 3;
    let amp = bell(t, o.duration, peakAt);
    if (o.wobble) amp *= 1 - (o.wobbleDepth ?? 0.5) * (0.5 + 0.5 * Math.cos(TAU * o.wobble * t));
    out[i] = (body.process(n) + top.process(n) * (o.air ?? 0.35)) * amp;
  }
  return out;
}

export interface ThumpOptions {
  from: number;
  to: number;
  duration: number;
  /** Pitch-drop time constant. */
  drop?: number;
  decay?: number;
  click?: number;
}
/** A pitched body hit: sine with an exponential pitch drop and a click. */
export function thump(sr: number, rng: Rng, o: ThumpOptions): Mono {
  const out = buffer(o.duration, sr),
    hp = new Biquad(sr).highpass(2500);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = o.to + (o.from - o.to) * Math.exp(-t / (o.drop ?? 0.03));
    phase += (TAU * f) / sr;
    const click = t < 0.004 ? hp.process(rng.white()) * (1 - t / 0.004) * (o.click ?? 0.4) : 0;
    out[i] = Math.sin(phase) * envelope(t, 0.0015, o.decay ?? o.duration / 4) + click;
  }
  return out;
}

export interface Mode {
  freq: number;
  decay: number;
  amp: number;
}
/** Modal synthesis: struck objects as sums of damped sinusoids. */
export function modal(
  sr: number,
  rng: Rng,
  modes: readonly Mode[],
  duration: number,
  options: { glide?: number; exciter?: number; exciterFreq?: number } = {},
): Mono {
  const out = buffer(duration, sr);
  for (const mode of modes) {
    let phase = rng.next() * TAU;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const amp = mode.amp * Math.exp(-t / mode.decay);
      if (amp < 1e-5) break;
      phase += (TAU * mode.freq * (1 + (options.glide ?? 0) * t)) / sr;
      out[i] += Math.sin(phase) * amp;
    }
  }
  // A short filtered noise strike excites the modes audibly.
  if (options.exciter) {
    const bp = new Biquad(sr).bandpass(options.exciterFreq ?? modes[0].freq * 2, 0.8);
    const n = Math.min(out.length, Math.round(sr * 0.006));
    for (let i = 0; i < n; i++) out[i] += bp.process(rng.white()) * options.exciter * (1 - i / n);
  }
  for (let i = 0; i < Math.min(out.length, Math.round(sr * 0.0008)); i++)
    out[i] *= i / (sr * 0.0008);
  return out;
}
/** Modes from a base frequency, ratios, decays and amplitudes. */
export const modes = (
  base: number,
  ratios: readonly number[],
  decays: readonly number[],
  amps: readonly number[],
): Mode[] => ratios.map((r, i) => ({ freq: base * r, decay: decays[i], amp: amps[i] }));

/** Sparse grains of resonant noise: fire crackle, splinters, debris. */
export function crackle(
  sr: number,
  rng: Rng,
  o: {
    duration: number;
    density: number;
    low: number;
    high: number;
    grain?: number;
    shape?: (x: number) => number;
  },
): Mono {
  const out = buffer(o.duration, sr);
  const count = Math.round(o.density * o.duration);
  for (let k = 0; k < count; k++) {
    const x = rng.next(),
      start = Math.round(x * o.duration * sr);
    const level = (o.shape ? o.shape(x) : 1) * rng.range(0.25, 1);
    const length = Math.round(sr * (o.grain ?? 0.004) * rng.range(0.5, 1.6));
    const bp = new Biquad(sr).bandpass(expLerp(o.low, o.high, rng.next()), rng.range(1.5, 6));
    for (let i = 0; i < length && start + i < out.length; i++)
      out[start + i] += bp.process(rng.white()) * level * Math.exp((-4 * i) / length);
  }
  return out;
}
/** Minnaert bubbles: upward-chirping damped sines. */
export function droplets(
  sr: number,
  rng: Rng,
  o: { duration: number; count: number; low: number; high: number; spread?: number },
): Mono {
  const out = buffer(o.duration, sr);
  for (let k = 0; k < o.count; k++) {
    const start = Math.round(Math.pow(rng.next(), o.spread ?? 1.6) * o.duration * 0.8 * sr);
    const f0 = expLerp(o.low, o.high, rng.next()),
      decay = rng.range(0.008, 0.03),
      level = rng.range(0.2, 1);
    let phase = 0;
    for (let i = 0; start + i < out.length; i++) {
      const t = i / sr,
        amp = level * Math.exp(-t / decay);
      if (amp < 1e-4) break;
      phase += (TAU * f0 * (1 + t * 25)) / sr;
      out[start + i] += Math.sin(phase) * amp;
    }
  }
  return out;
}
/** Leaves and reeds: many tiny high noise flicks. */
export function rustle(
  sr: number,
  rng: Rng,
  o: { duration: number; density: number; low?: number; high?: number },
): Mono {
  return crackle(sr, rng, {
    duration: o.duration,
    density: o.density,
    low: o.low ?? 2200,
    high: o.high ?? 7000,
    grain: 0.006,
    shape: (x) => Math.sin(Math.PI * Math.min(1, x * 1.15)) ** 0.7,
  });
}
/** An FM bell or chime partial. */
export function fmBell(
  sr: number,
  o: { freq: number; duration: number; ratio?: number; index?: number; decay?: number },
): Mono {
  const out = buffer(o.duration, sr);
  let carrier = 0,
    modulator = 0;
  const ratio = o.ratio ?? 3.5,
    decay = o.decay ?? o.duration / 3;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr,
      env = envelope(t, 0.002, decay);
    modulator += (TAU * o.freq * ratio) / sr;
    carrier += (TAU * o.freq) / sr;
    const index = (o.index ?? 2.2) * Math.exp(-t / (decay * 0.4));
    out[i] = Math.sin(carrier + index * Math.sin(modulator)) * env;
  }
  return out;
}
/** Resonant noise sweeping down: wet squelch for juicy hits. */
export function squelch(
  sr: number,
  rng: Rng,
  o: { duration: number; from: number; to: number; q?: number },
): Mono {
  const out = buffer(o.duration, sr),
    bp = new Biquad(sr),
    bp2 = new Biquad(sr);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr,
      x = t / o.duration;
    const f = expLerp(o.from, o.to, Math.pow(x, 0.6));
    bp.bandpass(f, o.q ?? 6);
    bp2.bandpass(f * 2.4, (o.q ?? 6) * 0.8);
    const w = rng.white();
    const wobble = 0.75 + 0.25 * Math.sin(TAU * 38 * t + 6 * x);
    out[i] = (bp.process(w) + 0.45 * bp2.process(w)) * envelope(t, 0.004, o.duration / 3) * wobble;
  }
  return out;
}
/** Make a buffer loop seamlessly by crossfading its end into its start. */
export function loopable(signal: Mono, sr: number, crossfade = 0.15): Mono {
  const n = Math.min(Math.floor(signal.length / 3), Math.round(crossfade * sr));
  const out = new Float32Array(signal.length - n);
  out.set(signal.subarray(0, out.length));
  for (let i = 0; i < n; i++) {
    const x = i / n;
    out[i] =
      signal[out.length + i] * Math.cos((x * Math.PI) / 2) + out[i] * Math.sin((x * Math.PI) / 2);
  }
  return out;
}
/** A stereo room impulse response: decaying filtered noise, decorrelated per side. */
export function roomImpulse(sr: number, seed: number, seconds = 1.1, decay = 0.32): [Mono, Mono] {
  const sides: Mono[] = [];
  for (const side of [0, 1]) {
    const rng = new Rng(seed + side * 7919),
      lp = new Biquad(sr),
      out = buffer(seconds, sr);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      lp.lowpass(expLerp(9000, 1800, t / seconds), 0.6);
      // Sparse early reflections, then a smooth diffuse tail.
      const early = t < 0.06 && rng.next() < 0.004 ? rng.white() * 2.5 : 0;
      out[i] =
        (lp.process(rng.white()) + early) * Math.exp(-t / decay) * (t < 0.008 ? t / 0.008 : 1);
    }
    sides.push(out);
  }
  return [sides[0], sides[1]];
}
