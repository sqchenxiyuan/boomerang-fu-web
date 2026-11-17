import {
  Biquad,
  Brown,
  Pink,
  Rng,
  bell,
  buffer,
  crackle,
  droplets,
  envelope,
  expLerp,
  fade,
  fmBell,
  loopable,
  mixInto,
  modal,
  modes,
  normalize,
  removeDC,
  rustle,
  saturate,
  squelch,
  thump,
  trim,
  whoosh,
  type Mono,
} from './dsp';

/*
 * Sound recipes, designed from scratch for this game. Each recipe layers the
 * DSP primitives (transient + body + tail) and renders several variants from
 * different seeds. Mix levels, reverb sends and voice limits live beside them.
 */
export interface Recipe {
  render(sr: number, rng: Rng, variant: number): Mono;
  variants: number;
  /** Relative mix level after peak normalisation. */
  gain: number;
  /** Room reverb send, 0..1. */
  reverb?: number;
  /** Seconds before the same sound may start again. */
  cooldown?: number;
  /** Simultaneous voices of this sound. */
  voices?: number;
  loop?: boolean;
}

const TAU = Math.PI * 2;
type Layer = [signal: Mono, at: number, gain: number];
/** Sum layers (offsets in seconds), normalise, fade and trim. */
function stack(sr: number, layers: Layer[], target = 0.9): Mono {
  let length = 0;
  for (const [signal, at] of layers) length = Math.max(length, signal.length + Math.round(at * sr));
  const out = new Float32Array(length);
  for (const [signal, at, gain] of layers) mixInto(out, signal, at * sr, gain);
  removeDC(out);
  return fade(normalize(trim(normalize(out, target), sr), target), sr);
}
const vary = (rng: Rng, value: number, amount = 0.08): number =>
  value * rng.range(1 - amount, 1 + amount);

/** Boomerang release: a whirring whoosh whose weight grows with the charge. */
function throwSound(sr: number, rng: Rng, charge: number): Mono {
  const duration = 0.17 + 0.17 * charge;
  return stack(sr, [
    [
      whoosh(sr, rng, {
        duration,
        from: vary(rng, 900 - 350 * charge),
        mid: vary(rng, 2600 - 900 * charge),
        to: vary(rng, 700 - 250 * charge),
        q: 1.3 - 0.4 * charge,
        peak: 0.3,
        wobble: vary(rng, 22 - 6 * charge, 0.12),
        wobbleDepth: 0.45 + 0.25 * charge,
        air: 0.45,
      }),
      0,
      1,
    ],
    // The flick of the wrist.
    [
      crackle(sr, rng, { duration: 0.012, density: 220, low: 3500, high: 7000, grain: 0.003 }),
      0,
      0.35,
    ],
    ...(charge > 0.4
      ? ([
          [
            thump(sr, rng, { from: 190, to: 70, duration: 0.18, decay: 0.05, click: 0.2 }),
            0,
            0.35 * charge,
          ],
        ] as Layer[])
      : []),
  ]);
}

function swish(sr: number, rng: Rng, high: number, duration: number): Mono {
  return whoosh(sr, rng, {
    duration,
    from: vary(rng, high * 0.35),
    mid: vary(rng, high),
    to: vary(rng, high * 0.3),
    q: 0.9,
    peak: 0.28,
    air: 0.6,
    wobble: 55,
    wobbleDepth: 0.18,
    noise: 'white',
  });
}

/** A struck bar: inharmonic partials with gently beating doubles. */
function metal(sr: number, rng: Rng, base: number, decay: number, brightness = 1): Mono {
  const ratios = [1, 2.756, 5.404, 8.933],
    amps = [1, 0.55 * brightness, 0.32 * brightness, 0.18 * brightness];
  const partials = ratios.flatMap((r, i) => [
    { freq: base * r, decay: decay / (1 + i * 0.7), amp: amps[i] },
    { freq: base * r * 1.0035, decay: (decay / (1 + i * 0.7)) * 0.8, amp: amps[i] * 0.5 },
  ]);
  return modal(sr, rng, partials, decay * 2.2, { exciter: 0.9, exciterFreq: base * 3.2 });
}
/** Wood: fast-decaying, near-harmonic plate modes. */
function wood(sr: number, rng: Rng, base: number, decay: number): Mono {
  return modal(
    sr,
    rng,
    modes(
      vary(rng, base, 0.05),
      [1, 2.57, 4.36, 6.5],
      [decay, decay * 0.55, decay * 0.35, decay * 0.2],
      [1, 0.5, 0.25, 0.12],
    ),
    decay * 4,
    { exciter: 0.7, exciterFreq: base * 2.5 },
  );
}
/** Air puff / dust: low-passed noise swell. */
function puff(sr: number, rng: Rng, duration: number, cutoff: number): Mono {
  const out = buffer(duration, sr),
    lp = new Biquad(sr),
    pink = new Pink();
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    lp.lowpass(expLerp(cutoff, cutoff * 0.3, t / duration), 0.7);
    out[i] = lp.process(pink.next(rng.white()) * 3) * bell(t, duration, 0.15, 1.2);
  }
  return out;
}
/** Hiss: high-passed noise with a decay (steam, sizzle). */
function hiss(sr: number, rng: Rng, duration: number, low: number, decay: number): Mono {
  const out = buffer(duration, sr),
    hp = new Biquad(sr).highpass(low, 0.6);
  for (let i = 0; i < out.length; i++)
    out[i] = hp.process(rng.white()) * envelope(i / sr, 0.01, decay);
  return out;
}
/** Low rumble bed. */
function rumble(sr: number, rng: Rng, duration: number, cutoff: number, wobble = 3): Mono {
  const out = buffer(duration, sr),
    lp = new Biquad(sr).lowpass(cutoff, 0.8),
    brown = new Brown();
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i] =
      lp.process(brown.next(rng.white())) *
      (0.7 + 0.3 * Math.sin(TAU * wobble * t + rng.next() * 0.02));
  }
  return out;
}
/** Glass and ice: a cloud of short bright pings. */
function shards(
  sr: number,
  rng: Rng,
  duration: number,
  count: number,
  low: number,
  high: number,
): Mono {
  const out = buffer(duration, sr);
  for (let k = 0; k < count; k++) {
    const at = Math.pow(rng.next(), 2.2) * duration * 0.7,
      freq = expLerp(low, high, rng.next());
    const ping = modal(
      sr,
      rng,
      [
        { freq, decay: rng.range(0.02, 0.12), amp: rng.range(0.2, 1) },
        { freq: freq * 2.31, decay: 0.03, amp: 0.3 },
      ],
      0.3,
    );
    mixInto(out, ping, at * sr, 1);
  }
  return out;
}
/** A two-tone synth note (saw through a low-pass), for stings and alarms. */
function synthNote(
  sr: number,
  freq: number,
  duration: number,
  cutoff: number,
  decay = duration / 2,
): Mono {
  const out = buffer(duration, sr),
    lp = new Biquad(sr).lowpass(cutoff, 1.2);
  let a = 0,
    b = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    a = (a + freq / sr) % 1;
    b = (b + (freq * 1.005) / sr) % 1;
    out[i] = lp.process((a * 2 - 1 + (b * 2 - 1)) * 0.5) * envelope(t, 0.005, decay);
  }
  return out;
}
/** Crash cymbal-ish wash. */
function crash(sr: number, rng: Rng, duration: number): Mono {
  const out = hiss(sr, rng, duration, 4500, duration / 3.5);
  const bp = new Biquad(sr).bandpass(7200, 0.7);
  for (let i = 0; i < out.length; i++) out[i] = out[i] * 0.6 + bp.process(out[i]) * 0.8;
  return out;
}
const midiFreq = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
/** A bright pitched chime (pickups, streaks, stings). */
export function chime(sr: number, midi: number, duration = 0.45): Mono {
  const f = midiFreq(midi);
  const out = fmBell(sr, { freq: f, duration, ratio: 3.01, index: 1.6, decay: duration / 3 });
  mixInto(
    out,
    fmBell(sr, {
      freq: f * 2,
      duration: duration * 0.6,
      ratio: 2,
      index: 0.6,
      decay: duration / 6,
    }),
    0,
    0.3,
  );
  return fade(normalize(out, 0.9), sr);
}

function explosion(sr: number, rng: Rng, scale: number, flavour: 'plain' | 'fire' | 'ice'): Mono {
  const duration = 0.5 + 0.9 * scale;
  const layers: Layer[] = [
    [
      thump(sr, rng, {
        from: vary(rng, 120 / scale ** 0.3),
        to: 32 / scale ** 0.2,
        duration,
        drop: 0.08,
        decay: 0.18 + 0.25 * scale,
        click: 0.6,
      }),
      0,
      1,
    ],
    [
      whoosh(sr, rng, {
        duration: duration * 0.9,
        from: 5000,
        to: 250,
        q: 0.5,
        peak: 0.03,
        air: 0.2,
        noise: 'white',
      }),
      0,
      0.9,
    ],
    [
      crackle(sr, rng, {
        duration: duration * 1.2,
        density: 140,
        low: 600,
        high: 5000,
        grain: 0.006,
        shape: (x) => Math.exp(-3 * x),
      }),
      0.03,
      0.45,
    ],
  ];
  if (flavour === 'fire')
    layers.push(
      [puff(sr, rng, duration * 1.1, 1400), 0.02, 0.8],
      [
        crackle(sr, rng, {
          duration: duration * 1.4,
          density: 300,
          low: 1500,
          high: 7000,
          grain: 0.003,
          shape: (x) => 1 - x,
        }),
        0.05,
        0.4,
      ],
    );
  if (flavour === 'ice') layers.push([shards(sr, rng, duration, 40, 2500, 9500), 0.01, 0.75]);
  const out = stack(sr, layers);
  return saturate(out, 1.6);
}

export type LoopName =
  | 'burningLoop'
  | 'recallLoop'
  | 'telekinesisLoop'
  | 'chargeLoop'
  | 'fireCellLoop'
  | 'rumbleLoop'
  | 'slideLoop';

export const RECIPES = {
  /* ---------------------------------------------------------------- combat */
  throw: {
    variants: 4,
    gain: 0.42,
    reverb: 0.12,
    cooldown: 0.03,
    render: (sr, rng) => throwSound(sr, rng, 0.1),
  },
  throwHeavy: {
    variants: 3,
    gain: 0.52,
    reverb: 0.14,
    render: (sr, rng) => throwSound(sr, rng, 0.55),
  },
  throwFull: { variants: 3, gain: 0.62, reverb: 0.18, render: (sr, rng) => throwSound(sr, rng, 1) },
  melee: {
    variants: 4,
    gain: 0.52,
    reverb: 0.08,
    render: (sr, rng) =>
      stack(sr, [
        [swish(sr, rng, 5200, 0.14), 0, 1],
        [thump(sr, rng, { from: 260, to: 140, duration: 0.08, decay: 0.025, click: 0.1 }), 0, 0.25],
      ]),
  },
  swingEmpty: {
    variants: 3,
    gain: 0.38,
    render: (sr, rng) => stack(sr, [[swish(sr, rng, 2600, 0.12), 0, 1]]),
  },
  parry: {
    variants: 3,
    gain: 0.85,
    reverb: 0.3,
    voices: 3,
    render: (sr, rng) =>
      stack(sr, [
        [metal(sr, rng, vary(rng, 1850, 0.06), 0.42), 0, 1],
        [wood(sr, rng, 760, 0.05), 0, 0.5],
        [hiss(sr, rng, 0.06, 3500, 0.015), 0, 0.5],
      ]),
  },
  parryCharged: {
    variants: 2,
    gain: 1.1,
    reverb: 0.4,
    render: (sr, rng) =>
      stack(sr, [
        [metal(sr, rng, vary(rng, 1250, 0.05), 0.75, 1.2), 0, 1],
        [metal(sr, rng, 2480, 0.3, 0.6), 0.01, 0.4],
        [thump(sr, rng, { from: 140, to: 48, duration: 0.45, decay: 0.12, click: 0.5 }), 0, 0.7],
        [crash(sr, rng, 0.5), 0, 0.35],
      ]),
  },
  clash: {
    variants: 3,
    gain: 0.85,
    reverb: 0.25,
    render: (sr, rng) =>
      stack(sr, [
        [metal(sr, rng, vary(rng, 880), 0.18, 0.8), 0, 1],
        [metal(sr, rng, vary(rng, 1160), 0.16, 0.8), 0.032, 0.8],
        [
          whoosh(sr, rng, {
            duration: 0.16,
            from: 2600,
            to: 1800,
            q: 3,
            peak: 0.1,
            noise: 'white',
            wobble: 70,
            wobbleDepth: 0.6,
          }),
          0.01,
          0.35,
        ],
        [thump(sr, rng, { from: 200, to: 110, duration: 0.12, decay: 0.03 }), 0, 0.35],
      ]),
  },
  disarmHit: {
    variants: 3,
    gain: 0.8,
    reverb: 0.15,
    render: (sr, rng) =>
      stack(sr, [
        [thump(sr, rng, { from: 170, to: 70, duration: 0.18, decay: 0.045, click: 0.5 }), 0, 1],
        [
          crackle(sr, rng, { duration: 0.03, density: 900, low: 900, high: 2600, grain: 0.004 }),
          0,
          0.6,
        ],
        [wood(sr, rng, 520, 0.06), 0.01, 0.4],
      ]),
  },
  catch: {
    variants: 3,
    gain: 0.42,
    reverb: 0.06,
    render: (sr, rng) =>
      stack(sr, [
        [thump(sr, rng, { from: 260, to: 150, duration: 0.09, decay: 0.022, click: 0.3 }), 0, 1],
        [wood(sr, rng, 560, 0.04), 0, 0.55],
      ]),
  },
  equip: {
    variants: 2,
    gain: 0.42,
    reverb: 0.2,
    render: (sr, rng) =>
      stack(sr, [
        [wood(sr, rng, 620, 0.05), 0, 0.8],
        [chime(sr, 86, 0.3), 0.02, 0.5],
        [chime(sr, 93, 0.35), 0.07, 0.45],
      ]),
  },
  dash: {
    variants: 3,
    gain: 0.48,
    reverb: 0.08,
    render: (sr, rng) =>
      stack(sr, [
        [
          whoosh(sr, rng, {
            duration: 0.2,
            from: vary(rng, 600),
            mid: vary(rng, 1700),
            to: 500,
            q: 0.8,
            peak: 0.25,
            air: 0.5,
          }),
          0,
          1,
        ],
        [puff(sr, rng, 0.08, 900), 0, 0.5],
      ]),
  },
  dashEnd: {
    variants: 3,
    gain: 0.28,
    render: (sr, rng) =>
      stack(sr, [
        [
          whoosh(sr, rng, {
            duration: 0.15,
            from: 1400,
            to: 500,
            q: 1.6,
            peak: 0.08,
            wobble: 90,
            wobbleDepth: 0.5,
          }),
          0,
          1,
        ],
        [thump(sr, rng, { from: 150, to: 90, duration: 0.07, decay: 0.02 }), 0, 0.4],
      ]),
  },
  footstep: {
    variants: 6,
    gain: 0.17,
    cooldown: 0.05,
    voices: 6,
    render: (sr, rng) => {
      const out = buffer(0.07, sr),
        lp = new Biquad(sr),
        pink = new Pink();
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        lp.lowpass(expLerp(vary(rng, 900, 0.2), 220, t / 0.07), 0.9);
        out[i] = lp.process(pink.next(rng.white()) * 3) * envelope(t, 0.002, 0.016);
      }
      return stack(sr, [
        [out, 0, 1],
        [rustle(sr, rng, { duration: 0.03, density: 300 }), 0.002, 0.25],
        [thump(sr, rng, { from: 120, to: 80, duration: 0.05, decay: 0.012, click: 0 }), 0, 0.35],
      ]);
    },
  },
  hop: {
    variants: 2,
    gain: 0.32,
    render: (sr) => {
      const out = buffer(0.12, sr);
      let phase = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        phase += (TAU * expLerp(280, 640, t / 0.09)) / sr;
        out[i] = Math.sin(phase) * envelope(t, 0.006, 0.035);
      }
      return fade(normalize(out), sr);
    },
  },
  faceplant: {
    variants: 2,
    gain: 0.5,
    reverb: 0.1,
    render: (sr, rng) =>
      stack(sr, [
        [thump(sr, rng, { from: 150, to: 60, duration: 0.2, decay: 0.05, click: 0.3 }), 0, 1],
        [rustle(sr, rng, { duration: 0.12, density: 260 }), 0, 0.4],
        [squelch(sr, rng, { duration: 0.1, from: 700, to: 300, q: 4 }), 0.005, 0.3],
      ]),
  },
  spawnWhoosh: {
    variants: 2,
    gain: 0.38,
    reverb: 0.2,
    render: (sr, rng) =>
      stack(sr, [
        [
          whoosh(sr, rng, { duration: 0.5, from: 3200, to: 600, q: 1.2, peak: 0.7, air: 0.4 }),
          0,
          1,
        ],
        [fmBell(sr, { freq: 1500, duration: 0.45, ratio: 1, index: 0.2, decay: 0.3 }), 0, 0.05],
      ]),
  },
  spawnLand: {
    variants: 2,
    gain: 0.55,
    reverb: 0.15,
    render: (sr, rng) =>
      stack(sr, [
        [thump(sr, rng, { from: 130, to: 52, duration: 0.3, decay: 0.07, click: 0.5 }), 0, 1],
        [puff(sr, rng, 0.3, 1300), 0, 0.6],
        [rustle(sr, rng, { duration: 0.16, density: 200 }), 0.01, 0.3],
      ]),
  },

  /* ---------------------------------------------------- disc ricochets */
  ricoStone: {
    variants: 4,
    gain: 0.48,
    reverb: 0.15,
    cooldown: 0.03,
    render: (sr, rng) =>
      stack(sr, [
        [
          modal(
            sr,
            rng,
            modes(vary(rng, 1450), [1, 2.31, 3.9], [0.035, 0.02, 0.012], [1, 0.6, 0.35]),
            0.15,
            { exciter: 1.2, exciterFreq: 3800 },
          ),
          0,
          1,
        ],
        [thump(sr, rng, { from: 190, to: 140, duration: 0.07, decay: 0.018, click: 0.5 }), 0, 0.5],
        [wood(sr, rng, 680, 0.035), 0, 0.35],
      ]),
  },
  ricoWood: {
    variants: 4,
    gain: 0.48,
    reverb: 0.12,
    cooldown: 0.03,
    render: (sr, rng) =>
      stack(sr, [
        [wood(sr, rng, 470, 0.09), 0, 1],
        [wood(sr, rng, 690, 0.04), 0, 0.4],
      ]),
  },
  ricoTree: {
    variants: 3,
    gain: 0.48,
    reverb: 0.12,
    render: (sr, rng) =>
      stack(sr, [
        [wood(sr, rng, 250, 0.12), 0, 1],
        [rustle(sr, rng, { duration: 0.28, density: 220 }), 0.01, 0.35],
      ]),
  },
  ricoBamboo: {
    variants: 3,
    gain: 0.48,
    reverb: 0.15,
    render: (sr, rng) =>
      stack(sr, [
        [
          modal(
            sr,
            rng,
            modes(
              vary(rng, 820),
              [1, 2, 3.02, 4.1],
              [0.11, 0.06, 0.04, 0.025],
              [1, 0.45, 0.25, 0.1],
            ),
            0.4,
            { exciter: 0.8, glide: -0.04 },
          ),
          0,
          1,
        ],
      ]),
  },
  ricoShrub: {
    variants: 3,
    gain: 0.4,
    render: (sr, rng) =>
      stack(sr, [
        [rustle(sr, rng, { duration: 0.25, density: 420, low: 1500, high: 6000 }), 0, 1],
        [thump(sr, rng, { from: 160, to: 110, duration: 0.06, decay: 0.015, click: 0 }), 0, 0.3],
      ]),
  },
  ricoDisc: {
    variants: 3,
    gain: 0.5,
    reverb: 0.12,
    render: (sr, rng) =>
      stack(sr, [
        [wood(sr, rng, 900, 0.045), 0, 1],
        [wood(sr, rng, 1060, 0.04), 0.006, 0.9],
      ]),
  },

  /* ------------------------------------------------------------- deaths */
  deathSlice: {
    variants: 4,
    gain: 1.0,
    reverb: 0.15,
    render: (sr, rng) =>
      stack(sr, [
        [
          whoosh(sr, rng, {
            duration: 0.07,
            from: 3500,
            mid: 9000,
            to: 4000,
            q: 0.8,
            peak: 0.3,
            noise: 'white',
            air: 0.2,
          }),
          0,
          0.8,
        ],
        [squelch(sr, rng, { duration: 0.22, from: vary(rng, 1500), to: 420 }), 0.02, 1],
        [thump(sr, rng, { from: 130, to: 55, duration: 0.2, decay: 0.05, click: 0.2 }), 0.02, 0.7],
        [
          crackle(sr, rng, { duration: 0.07, density: 600, low: 900, high: 4000, grain: 0.003 }),
          0.025,
          0.4,
        ],
      ]),
  },
  deathSquash: {
    variants: 3,
    gain: 1.0,
    reverb: 0.15,
    render: (sr, rng) =>
      stack(sr, [
        [thump(sr, rng, { from: 110, to: 42, duration: 0.3, decay: 0.08, click: 0.4 }), 0, 1],
        [squelch(sr, rng, { duration: 0.3, from: 900, to: 220, q: 5 }), 0.01, 0.9],
        [crackle(sr, rng, { duration: 0.15, density: 300, low: 500, high: 2500 }), 0.01, 0.3],
      ]),
  },
  deathBurn: {
    variants: 2,
    gain: 0.95,
    reverb: 0.2,
    render: (sr, rng) =>
      stack(sr, [
        [puff(sr, rng, 0.5, 1800), 0, 0.8],
        [hiss(sr, rng, 0.7, 3000, 0.2), 0.02, 0.5],
        [
          crackle(sr, rng, {
            duration: 0.8,
            density: 260,
            low: 1500,
            high: 7000,
            grain: 0.003,
            shape: (x) => 1 - x,
          }),
          0.02,
          0.6,
        ],
        [thump(sr, rng, { from: 120, to: 50, duration: 0.25, decay: 0.06 }), 0, 0.5],
      ]),
  },
  deathBoundary: {
    variants: 2,
    gain: 0.9,
    reverb: 0.25,
    render: (sr, rng) => {
      const zap = buffer(0.35, sr),
        lp = new Biquad(sr);
      let phase = 0;
      for (let i = 0; i < zap.length; i++) {
        const t = i / sr;
        phase = (phase + expLerp(1100, 160, t / 0.35) / sr) % 1;
        lp.lowpass(expLerp(4000, 600, t / 0.35), 2);
        zap[i] = lp.process(phase * 2 - 1) * envelope(t, 0.003, 0.12);
      }
      return stack(sr, [
        [zap, 0, 1],
        [puff(sr, rng, 0.3, 2200), 0, 0.6],
      ]);
    },
  },
  deathFall: {
    variants: 2,
    gain: 0.8,
    reverb: 0.35,
    render: (sr, rng) => {
      const whistle = buffer(0.8, sr);
      let phase = 0;
      for (let i = 0; i < whistle.length; i++) {
        const t = i / sr;
        phase += (TAU * expLerp(1700, 380, t / 0.8)) / sr;
        whistle[i] = Math.sin(phase + 0.3 * Math.sin(TAU * 7 * t)) * bell(t, 0.8, 0.1, 1);
      }
      return stack(sr, [
        [whistle, 0, 0.6],
        [whoosh(sr, rng, { duration: 0.6, from: 2000, to: 400, q: 1, peak: 0.2 }), 0, 0.6],
      ]);
    },
  },
  splashBig: {
    variants: 3,
    gain: 1.0,
    reverb: 0.2,
    render: (sr, rng) => {
      const plunge = buffer(0.16, sr);
      let phase = 0;
      for (let i = 0; i < plunge.length; i++) {
        const t = i / sr;
        phase += (TAU * expLerp(320, 110, t / 0.16)) / sr;
        plunge[i] = Math.sin(phase) * envelope(t, 0.004, 0.05);
      }
      return stack(sr, [
        [plunge, 0, 0.8],
        [
          whoosh(sr, rng, {
            duration: 0.45,
            from: 3200,
            to: 380,
            q: 0.6,
            peak: 0.06,
            air: 0.5,
            noise: 'white',
          }),
          0,
          1,
        ],
        [droplets(sr, rng, { duration: 0.75, count: 30, low: 700, high: 2600 }), 0.04, 0.55],
      ]);
    },
  },
  splashSmall: {
    variants: 3,
    gain: 0.45,
    reverb: 0.15,
    render: (sr, rng) =>
      stack(sr, [
        [
          whoosh(sr, rng, {
            duration: 0.18,
            from: 2800,
            to: 600,
            q: 0.7,
            peak: 0.08,
            noise: 'white',
          }),
          0,
          1,
        ],
        [droplets(sr, rng, { duration: 0.35, count: 9, low: 900, high: 2800 }), 0.02, 0.6],
      ]),
  },
  shatter: {
    variants: 3,
    gain: 0.95,
    reverb: 0.3,
    render: (sr, rng) =>
      stack(sr, [
        [shards(sr, rng, 0.55, 46, 2400, 9500), 0, 1],
        [hiss(sr, rng, 0.12, 2000, 0.03), 0, 0.6],
        [thump(sr, rng, { from: 160, to: 80, duration: 0.12, decay: 0.03 }), 0, 0.4],
      ]),
  },
  unfreeze: {
    variants: 2,
    gain: 0.5,
    reverb: 0.2,
    render: (sr, rng) =>
      stack(sr, [
        [shards(sr, rng, 0.3, 14, 1800, 6500), 0, 1],
        [
          crackle(sr, rng, { duration: 0.08, density: 700, low: 1500, high: 5000, grain: 0.002 }),
          0,
          0.6,
        ],
      ]),
  },
  oobWarning: {
    variants: 1,
    gain: 0.35,
    voices: 1,
    render: (sr) => {
      const out = fmBell(sr, { freq: 1046.5, duration: 0.12, ratio: 1, index: 0.3, decay: 0.04 });
      return fade(normalize(out), sr);
    },
  },

  /* ---------------------------------------------------------- environment */
  breakCrate: {
    variants: 3,
    gain: 0.8,
    reverb: 0.18,
    render: (sr, rng) => {
      const debris: Layer[] = Array.from(
        { length: 6 },
        () =>
          [
            wood(sr, rng, rng.range(300, 900), 0.04),
            rng.range(0.05, 0.4),
            rng.range(0.15, 0.4),
          ] as Layer,
      );
      return stack(sr, [
        [
          crackle(sr, rng, { duration: 0.08, density: 1400, low: 400, high: 2200, grain: 0.005 }),
          0,
          1,
        ],
        [wood(sr, rng, 330, 0.08), 0, 0.8],
        [
          crackle(sr, rng, {
            duration: 0.35,
            density: 240,
            low: 1500,
            high: 6000,
            grain: 0.002,
            shape: (x) => 1 - x,
          }),
          0.02,
          0.4,
        ],
        ...debris,
      ]);
    },
  },
  switch: {
    variants: 2,
    gain: 0.55,
    reverb: 0.15,
    render: (sr, rng) =>
      stack(sr, [
        [
          modal(sr, rng, modes(1150, [1, 2.4, 3.7], [0.03, 0.02, 0.01], [1, 0.5, 0.3]), 0.1, {
            exciter: 1,
          }),
          0,
          1,
        ],
        [
          modal(sr, rng, modes(980, [1, 2.4, 3.7], [0.04, 0.02, 0.01], [1, 0.5, 0.3]), 0.1, {
            exciter: 1,
          }),
          0.07,
          0.9,
        ],
        [thump(sr, rng, { from: 220, to: 120, duration: 0.1, decay: 0.03 }), 0.07, 0.5],
      ]),
  },
  gong: {
    variants: 1,
    gain: 0.8,
    reverb: 0.5,
    voices: 1,
    render: (sr, rng) =>
      stack(sr, [
        [
          modal(
            sr,
            rng,
            modes(
              104,
              [1, 1.52, 1.99, 2.43, 2.99, 3.56, 4.21],
              [3.2, 2.4, 1.7, 1.3, 0.9, 0.6, 0.4],
              [1, 0.7, 0.6, 0.45, 0.35, 0.25, 0.18],
            ),
            3.6,
            { glide: 0.006, exciter: 0.6, exciterFreq: 400 },
          ),
          0,
          1,
        ],
        [thump(sr, rng, { from: 90, to: 60, duration: 0.3, decay: 0.08 }), 0, 0.5],
      ]),
  },
  portal: {
    variants: 2,
    gain: 0.55,
    reverb: 0.35,
    render: (sr, rng) => {
      const sweep = buffer(0.45, sr),
        bp = new Biquad(sr),
        detune = rng.range(2.5, 4.5);
      let a = 0,
        b = 0;
      for (let i = 0; i < sweep.length; i++) {
        const t = i / sr,
          x = t / 0.45;
        a = (a + 220 / sr) % 1;
        b = (b + (220 + detune) / sr) % 1;
        bp.bandpass(x < 0.4 ? expLerp(400, 3200, x / 0.4) : expLerp(3200, 700, (x - 0.4) / 0.6), 4);
        sweep[i] = bp.process(a + b - 1) * bell(t, 0.45, 0.4, 1);
      }
      return stack(sr, [
        [sweep, 0, 1],
        [chime(sr, 96, 0.3), 0.12, 0.25],
        [chime(sr, 103, 0.3), 0.17, 0.2],
      ]);
    },
  },
  portalDisc: {
    variants: 2,
    gain: 0.45,
    reverb: 0.3,
    render: (sr, rng) =>
      stack(sr, [
        [
          whoosh(sr, rng, { duration: 0.22, from: 700, mid: 3800, to: 1500, q: 3, peak: 0.45 }),
          0,
          1,
        ],
        [chime(sr, 98, 0.25), 0.06, 0.3],
      ]),
  },
  teleport: {
    variants: 2,
    gain: 0.6,
    reverb: 0.3,
    render: (sr, rng) => {
      const zap = buffer(0.3, sr),
        lp = new Biquad(sr);
      let phase = 0;
      for (let i = 0; i < zap.length; i++) {
        const t = i / sr;
        phase = (phase + expLerp(300, 1600, t / 0.12) / sr) % 1;
        lp.lowpass(expLerp(1500, 6000, t / 0.3), 3);
        zap[i] = lp.process(phase * 2 - 1) * envelope(t, 0.004, 0.08);
      }
      return stack(sr, [
        [zap, 0, 0.9],
        [chime(sr, 91, 0.3), 0.04, 0.4],
        [puff(sr, rng, 0.2, 3000), 0, 0.35],
      ]);
    },
  },
  stoneGrind: {
    variants: 2,
    gain: 0.5,
    reverb: 0.25,
    render: (sr, rng) => {
      const creak = buffer(0.7, sr),
        bp = new Biquad(sr);
      let phase = 0,
        f = 190;
      for (let i = 0; i < creak.length; i++) {
        const t = i / sr;
        f = Math.min(280, Math.max(140, f + rng.white() * 1.2));
        phase = (phase + f / sr) % 1;
        bp.bandpass(f * 3, 3);
        creak[i] = bp.process(phase * 2 - 1) * bell(t, 0.7, 0.3, 1);
      }
      return stack(sr, [
        [rumble(sr, rng, 0.8, 260), 0, 1],
        [creak, 0.05, 0.35],
        [crackle(sr, rng, { duration: 0.7, density: 60, low: 400, high: 1800 }), 0, 0.3],
      ]);
    },
  },
  floorCrack: {
    variants: 3,
    gain: 0.45,
    reverb: 0.2,
    render: (sr, rng) =>
      stack(sr, [
        [
          crackle(sr, rng, { duration: 0.5, density: 120, low: 600, high: 3500, grain: 0.004 }),
          0,
          1,
        ],
        [rumble(sr, rng, 0.5, 180), 0, 0.6],
      ]),
  },
  reeds: {
    variants: 3,
    gain: 0.22,
    cooldown: 0.12,
    render: (sr, rng) =>
      stack(sr, [[rustle(sr, rng, { duration: 0.35, density: 360, low: 1800, high: 6500 }), 0, 1]]),
  },
  cloudPuff: {
    variants: 2,
    gain: 0.35,
    reverb: 0.25,
    render: (sr, rng) => stack(sr, [[puff(sr, rng, 0.35, 1600), 0, 1]]),
  },

  /* ------------------------------------------------------------- powers */
  pickup: {
    variants: 1,
    gain: 0.55,
    reverb: 0.25,
    render: (sr, rng) =>
      stack(sr, [
        [chime(sr, 81, 0.3), 0, 0.7],
        [chime(sr, 85, 0.3), 0.045, 0.7],
        [chime(sr, 88, 0.35), 0.09, 0.7],
        [chime(sr, 93, 0.45), 0.135, 0.8],
        [hiss(sr, rng, 0.35, 6500, 0.1), 0.02, 0.15],
      ]),
  },
  shieldOn: {
    variants: 1,
    gain: 0.6,
    reverb: 0.3,
    render: (sr, rng) => {
      const shimmer = buffer(0.6, sr);
      const phases = Array.from({ length: 6 }, () => rng.next() * TAU);
      for (let i = 0; i < shimmer.length; i++) {
        const t = i / sr,
          f = expLerp(520, 1250, t / 0.6);
        let s = 0;
        phases.forEach((p, k) => {
          phases[k] = p + (TAU * f * (1 + (k - 2.5) * 0.006)) / sr;
          s += Math.sin(phases[k]);
        });
        shimmer[i] = (s / 6) * bell(t, 0.6, 0.6, 1) * (0.8 + 0.2 * Math.sin(TAU * 14 * t));
      }
      return stack(sr, [
        [shimmer, 0, 1],
        [whoosh(sr, rng, { duration: 0.5, from: 800, to: 5000, q: 2, peak: 0.8 }), 0, 0.35],
      ]);
    },
  },
  shieldOff: {
    variants: 2,
    gain: 0.65,
    reverb: 0.3,
    render: (sr, rng) =>
      stack(sr, [
        [shards(sr, rng, 0.35, 22, 2000, 7000), 0, 0.9],
        [whoosh(sr, rng, { duration: 0.4, from: 2600, to: 400, q: 3, peak: 0.1 }), 0, 0.5],
        [thump(sr, rng, { from: 200, to: 90, duration: 0.12, decay: 0.03 }), 0, 0.4],
      ]),
  },
  explosion: {
    variants: 3,
    gain: 1.3,
    reverb: 0.3,
    voices: 3,
    render: (sr, rng) => explosion(sr, rng, 1, 'plain'),
  },
  explosionFire: {
    variants: 2,
    gain: 1.3,
    reverb: 0.3,
    voices: 3,
    render: (sr, rng) => explosion(sr, rng, 1, 'fire'),
  },
  explosionIce: {
    variants: 2,
    gain: 1.3,
    reverb: 0.35,
    voices: 3,
    render: (sr, rng) => explosion(sr, rng, 1, 'ice'),
  },
  explosionMini: {
    variants: 3,
    gain: 0.8,
    reverb: 0.2,
    voices: 4,
    render: (sr, rng) => explosion(sr, rng, 0.35, 'plain'),
  },
  freeze: {
    variants: 2,
    gain: 0.6,
    reverb: 0.3,
    render: (sr, rng) =>
      stack(sr, [
        [
          whoosh(sr, rng, {
            duration: 0.35,
            from: 2000,
            to: 7500,
            q: 2.5,
            peak: 0.7,
            noise: 'white',
          }),
          0,
          0.6,
        ],
        [chime(sr, 100, 0.4), 0.15, 0.4],
        [chime(sr, 104, 0.4), 0.2, 0.35],
        [
          crackle(sr, rng, { duration: 0.3, density: 200, low: 3000, high: 9000, grain: 0.002 }),
          0.05,
          0.4,
        ],
      ]),
  },
  decoySpawn: {
    variants: 2,
    gain: 0.5,
    reverb: 0.2,
    render: (sr, rng) =>
      stack(sr, [
        [puff(sr, rng, 0.3, 2400), 0, 1],
        [thump(sr, rng, { from: 420, to: 900, duration: 0.05, decay: 0.015, click: 0 }), 0, 0.5],
      ]),
  },
  decoyDie: {
    variants: 2,
    gain: 0.5,
    reverb: 0.2,
    render: (sr, rng) =>
      stack(sr, [
        [thump(sr, rng, { from: 700, to: 300, duration: 0.06, decay: 0.015 }), 0, 0.8],
        [puff(sr, rng, 0.35, 2000), 0, 1],
      ]),
  },
  split: {
    variants: 2,
    gain: 0.5,
    reverb: 0.15,
    render: (sr, rng) =>
      stack(sr, [
        [wood(sr, rng, 950, 0.04), 0, 1],
        [wood(sr, rng, 1150, 0.04), 0.018, 0.8],
        [wood(sr, rng, 830, 0.04), 0.034, 0.7],
        [
          whoosh(sr, rng, { duration: 0.2, from: 1200, mid: 3500, to: 2000, q: 1.2, peak: 0.3 }),
          0,
          0.4,
        ],
      ]),
  },
  zoneAlarm: {
    variants: 1,
    gain: 0.7,
    reverb: 0.3,
    voices: 1,
    render: (sr, rng) =>
      stack(sr, [
        [synthNote(sr, 440, 0.24, 2200), 0, 1],
        [synthNote(sr, 587.3, 0.24, 2200), 0.25, 1],
        [synthNote(sr, 440, 0.24, 2200), 0.5, 1],
        [synthNote(sr, 587.3, 0.4, 2200, 0.18), 0.75, 1],
        [rumble(sr, rng, 1.2, 140, 0.8), 0, 0.5],
      ]),
  },
  fuseTick: {
    variants: 1,
    gain: 0.3,
    cooldown: 0.05,
    render: (sr, rng) =>
      stack(sr, [
        [
          modal(sr, rng, modes(2300, [1, 2.7], [0.012, 0.006], [1, 0.4]), 0.05, { exciter: 0.6 }),
          0,
          1,
        ],
      ]),
  },
  ignite: {
    variants: 2,
    gain: 0.55,
    reverb: 0.15,
    render: (sr, rng) =>
      stack(sr, [
        [puff(sr, rng, 0.35, 1600), 0, 1],
        [thump(sr, rng, { from: 140, to: 70, duration: 0.18, decay: 0.05, click: 0 }), 0, 0.5],
        [
          crackle(sr, rng, { duration: 0.35, density: 240, low: 1500, high: 6500, grain: 0.003 }),
          0.05,
          0.5,
        ],
      ]),
  },
  extinguish: {
    variants: 2,
    gain: 0.4,
    reverb: 0.15,
    render: (sr, rng) =>
      stack(sr, [
        [hiss(sr, rng, 0.6, 3500, 0.18), 0, 1],
        [
          crackle(sr, rng, { duration: 0.3, density: 150, low: 2500, high: 7000, grain: 0.002 }),
          0,
          0.4,
        ],
      ]),
  },
  disguise: {
    variants: 1,
    gain: 0.4,
    reverb: 0.2,
    render: (sr, rng) =>
      stack(sr, [
        [puff(sr, rng, 0.3, 2000), 0, 1],
        [rustle(sr, rng, { duration: 0.25, density: 260 }), 0.03, 0.5],
      ]),
  },

  /* ---------------------------------------------------------------- UI */
  countdownTick: {
    variants: 1,
    gain: 0.4,
    render: (sr, rng) => stack(sr, [[wood(sr, rng, 1500, 0.05), 0, 1]]),
  },
  roundReady: {
    variants: 1,
    gain: 0.6,
    reverb: 0.3,
    render: (sr, rng) =>
      stack(sr, [
        [thump(sr, rng, { from: 140, to: 70, duration: 0.35, decay: 0.09, click: 0.6 }), 0, 1],
        [whoosh(sr, rng, { duration: 0.45, from: 500, to: 3000, q: 1, peak: 0.9 }), 0, 0.45],
      ]),
  },
  roundGo: {
    variants: 1,
    gain: 0.8,
    reverb: 0.35,
    render: (sr, rng) =>
      stack(sr, [
        [thump(sr, rng, { from: 160, to: 60, duration: 0.4, decay: 0.1, click: 0.7 }), 0, 1],
        [synthNote(sr, 587.3, 0.4, 3500, 0.16), 0, 0.5],
        [synthNote(sr, 740, 0.4, 3500, 0.16), 0, 0.45],
        [synthNote(sr, 880, 0.4, 3500, 0.16), 0, 0.45],
        [crash(sr, rng, 0.9), 0, 0.5],
      ]),
  },
  roundTitle: {
    variants: 1,
    gain: 0.5,
    reverb: 0.3,
    render: (sr, rng) =>
      stack(sr, [
        [whoosh(sr, rng, { duration: 0.4, from: 400, to: 2400, q: 1, peak: 0.85 }), 0, 0.8],
        [thump(sr, rng, { from: 120, to: 60, duration: 0.3, decay: 0.08 }), 0.36, 1],
      ]),
  },
  alert: {
    variants: 1,
    gain: 0.55,
    reverb: 0.25,
    render: (sr, rng) =>
      stack(sr, [
        [whoosh(sr, rng, { duration: 0.25, from: 600, to: 3000, q: 1.2, peak: 0.8 }), 0, 0.6],
        [chime(sr, 86, 0.35), 0.2, 0.8],
        [chime(sr, 93, 0.4), 0.26, 0.7],
      ]),
  },
  victory: {
    variants: 1,
    gain: 0.8,
    reverb: 0.4,
    voices: 1,
    render: (sr, rng) =>
      stack(sr, [
        [chime(sr, 74, 0.5), 0, 0.8],
        [chime(sr, 78, 0.5), 0.13, 0.8],
        [chime(sr, 81, 0.5), 0.26, 0.8],
        [chime(sr, 86, 1.1), 0.39, 1],
        [synthNote(sr, 293.7, 1.2, 2400, 0.45), 0.39, 0.4],
        [crash(sr, rng, 1.2), 0.39, 0.4],
      ]),
  },
  wipe: {
    variants: 1,
    gain: 0.35,
    reverb: 0.2,
    render: (sr, rng) =>
      stack(sr, [
        [
          whoosh(sr, rng, { duration: 0.6, from: 300, mid: 2200, to: 500, q: 0.8, peak: 0.5 }),
          0,
          1,
        ],
      ]),
  },

  /* -------------------------------------------------------------- loops */
  burningLoop: {
    variants: 1,
    gain: 0.35,
    loop: true,
    render: (sr, rng) => {
      const roar = rumble(sr, rng, 2.4, 700, 1.7);
      mixInto(
        roar,
        crackle(sr, rng, { duration: 2.4, density: 90, low: 1500, high: 7000, grain: 0.003 }),
        0,
        0.8,
      );
      return loopable(normalize(roar, 0.8), sr);
    },
  },
  fireCellLoop: {
    variants: 1,
    gain: 0.25,
    loop: true,
    render: (sr, rng) => {
      const bed = rumble(sr, rng, 2.4, 500, 1.1);
      mixInto(
        bed,
        crackle(sr, rng, { duration: 2.4, density: 60, low: 1200, high: 6000, grain: 0.003 }),
        0,
        1,
      );
      return loopable(normalize(bed, 0.8), sr);
    },
  },
  recallLoop: {
    variants: 1,
    gain: 0.3,
    loop: true,
    render: (sr, rng) => {
      // 1.25 s holds whole cycles of every partial, so the loop needs no crossfade seam.
      const out = buffer(1.25, sr);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr,
          vibrato = 1 + 0.008 * Math.sin(TAU * 4 * t);
        out[i] =
          (Math.sin(TAU * 160 * t * vibrato) +
            0.45 * Math.sin(TAU * 320 * t) +
            0.2 * Math.sin(TAU * 480 * t)) *
            (0.85 + 0.15 * Math.sin(TAU * 8 * t)) +
          rng.white() * 0.006;
      }
      return normalize(out, 0.7);
    },
  },
  telekinesisLoop: {
    variants: 1,
    gain: 0.3,
    loop: true,
    render: (sr, rng) => {
      const out = buffer(1, sr);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        out[i] =
          (Math.sin(TAU * 220 * t + 2 * Math.sin(TAU * 4 * t)) + 0.4 * Math.sin(TAU * 661 * t)) *
            (0.7 + 0.3 * Math.sin(TAU * 4 * t)) +
          rng.white() * 0.005;
      }
      return normalize(out, 0.7);
    },
  },
  chargeLoop: {
    variants: 1,
    gain: 0.22,
    loop: true,
    render: (sr, rng) => {
      const out = buffer(1.2, sr),
        lp = new Biquad(sr).lowpass(1200, 1.5);
      let phase = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        phase = (phase + 180 / sr) % 1;
        out[i] =
          lp.process(phase * 2 - 1 + rng.white() * 0.15) * (0.6 + 0.4 * Math.sin(TAU * 12 * t));
      }
      return loopable(normalize(out, 0.7), sr, 0.2);
    },
  },
  rumbleLoop: {
    variants: 1,
    gain: 0.25,
    loop: true,
    render: (sr, rng) => loopable(normalize(rumble(sr, rng, 2.4, 220, 0.9), 0.8), sr),
  },
  slideLoop: {
    variants: 1,
    gain: 0.2,
    loop: true,
    render: (sr, rng) => {
      // A flat, gently wobbling squeak-swish bed (no envelope to flatten afterwards).
      const out = buffer(1.6, sr),
        bp = new Biquad(sr),
        pink = new Pink();
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        bp.bandpass(1500 * (1 + 0.15 * Math.sin(TAU * 0.9 * t)), 2);
        out[i] = bp.process(pink.next(rng.white()) * 3) * (0.75 + 0.25 * Math.sin(TAU * 3 * t));
      }
      return loopable(normalize(out, 0.7), sr);
    },
  },
} satisfies Record<string, Recipe>;

export type SoundName = keyof typeof RECIPES;
export const SOUND_NAMES = Object.keys(RECIPES) as SoundName[];
