/*
 * Deterministic trigonometry for the simulation.
 *
 * JavaScript engines do not specify the last bit of Math.sin/cos/atan2/acos,
 * and they really differ (measured: Node 26 vs Chromium 158 disagree on ~3–17%
 * of random inputs). A simulation that must replay bit-for-bit in another
 * browser, a newer browser, or the Node batch runner therefore cannot use
 * them. These are straight ports of the FreeBSD msun / fdlibm algorithms
 * (k_sin, k_cos, e_rem_pio2 medium path, s_atan, e_atan2, e_acos): only
 * IEEE-754 +, −, ×, ÷, sqrt and exact bit reads, so every conforming engine
 * computes identical results, accurate to < 1 ulp.
 *
 * Original code: Copyright (C) 1993 by Sun Microsystems, Inc. All rights
 * reserved. Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this software is freely
 * granted, provided that this notice is preserved.
 */
const view = new DataView(new ArrayBuffer(8));
/** Upper 32 bits of the IEEE-754 representation (sign, exponent, high mantissa). */
function highWord(x: number): number {
  view.setFloat64(0, x);
  return view.getUint32(0);
}
/** x with the lower 32 mantissa bits cleared. */
function clearLowWord(x: number): number {
  view.setFloat64(0, x);
  view.setUint32(4, 0);
  return view.getFloat64(0);
}

// ── sin / cos kernels on [-π/4, π/4]; y is the tail of the reduced argument. ──
const S1 = -1.66666666666666324348e-1,
  S2 = 8.33333333332248946124e-3,
  S3 = -1.98412698298579493134e-4,
  S4 = 2.75573137070700676789e-6,
  S5 = -2.50507602534068634195e-8,
  S6 = 1.58969099521155010221e-10;
function kernelSin(x: number, y: number, iy: number): number {
  const z = x * x,
    w = z * z,
    r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6),
    v = z * x;
  if (iy === 0) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}
const C1 = 4.16666666666666019037e-2,
  C2 = -1.38888888888741095749e-3,
  C3 = 2.48015872894767294178e-5,
  C4 = -2.75573143513906633035e-7,
  C5 = 2.0875723212981748279e-9,
  C6 = -1.13596475577881948265e-11;
function kernelCos(x: number, y: number): number {
  const z = x * x,
    w = z * z,
    r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6)),
    hz = 0.5 * z,
    v = 1 - hz;
  return v + (1 - v - hz + (z * r - x * y));
}

// ── Argument reduction x = n·π/2 + (y0 + y1), Cody–Waite with three π/2 parts. ──
const INV_PIO2 = 6.36619772367581382433e-1,
  PIO2_1 = 1.57079632673412561417,
  PIO2_1T = 6.07710050650619224932e-11,
  PIO2_2 = 6.0771005063039659766e-11,
  PIO2_2T = 2.02226624879595063154e-21,
  PIO2_3 = 2.0222662487111664558e-21,
  PIO2_3T = 8.47842766036889956997e-32;
/** Round to nearest, ties to even (|t| < 2^51), without Math.round's tie rule. */
const TO_INT = 6755399441055744; // 1.5 × 2^52
const reduced = [0, 0];
/** The medium-size path of e_rem_pio2: exact for |x| < 2^20·π/2. Returns n. */
function remPio2(x: number): number {
  const fn = x * INV_PIO2 + TO_INT - TO_INT;
  const n = fn | 0;
  let r = x - fn * PIO2_1,
    w = fn * PIO2_1T;
  const j = (highWord(x) >>> 20) & 0x7ff;
  let y0 = r - w;
  let i = j - ((highWord(y0) >>> 20) & 0x7ff);
  if (i > 16) {
    let t = r;
    w = fn * PIO2_2;
    r = t - w;
    w = fn * PIO2_2T - (t - r - w);
    y0 = r - w;
    i = j - ((highWord(y0) >>> 20) & 0x7ff);
    if (i > 49) {
      t = r;
      w = fn * PIO2_3;
      r = t - w;
      w = fn * PIO2_3T - (t - r - w);
      y0 = r - w;
    }
  }
  reduced[0] = y0;
  reduced[1] = r - y0 - w;
  return n;
}
/** Beyond the medium range (never reached by game angles), fold by 2π first: still deterministic. */
const TWO_PI = 6.283185307179586;
const MEDIUM_LIMIT = 1647099.3291652855; // 2^20 · π/2

export function dsin(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e500000) return x; // |x| < 2^-26
    return kernelSin(x, 0, 0);
  }
  if (ix >= 0x7ff00000) return NaN;
  const n = remPio2(Math.abs(x) >= MEDIUM_LIMIT ? x % TWO_PI : x);
  const [y0, y1] = reduced;
  switch (n & 3) {
    case 0:
      return kernelSin(y0, y1, 1);
    case 1:
      return kernelCos(y0, y1);
    case 2:
      return -kernelSin(y0, y1, 1);
    default:
      return -kernelCos(y0, y1);
  }
}

export function dcos(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e46a09e) return 1; // |x| < 2^-27·√2
    return kernelCos(x, 0);
  }
  if (ix >= 0x7ff00000) return NaN;
  const n = remPio2(Math.abs(x) >= MEDIUM_LIMIT ? x % TWO_PI : x);
  const [y0, y1] = reduced;
  switch (n & 3) {
    case 0:
      return kernelCos(y0, y1);
    case 1:
      return -kernelSin(y0, y1, 1);
    case 2:
      return -kernelCos(y0, y1);
    default:
      return kernelSin(y0, y1, 1);
  }
}

// ── atan / atan2 ──
const ATAN_HI = [
  4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1,
  1.570796326794896558,
];
const ATAN_LO = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17,
  6.12323399573676603587e-17,
];
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1,
  -1.1111110405462355788e-1, 9.09088713343650656196e-2, -7.69187620504482999495e-2,
  6.66107313738753120669e-2, -5.83357013379057348645e-2, 4.97687799461593236017e-2,
  -3.6531572744216915527e-2, 1.62858201153657823623e-2,
];
export function datan(input: number): number {
  const hx = highWord(input),
    ix = hx & 0x7fffffff;
  let x = input,
    id: number;
  if (ix >= 0x44100000) {
    // |x| ≥ 2^66
    if (Number.isNaN(x)) return x + x;
    return hx & 0x80000000 ? -ATAN_HI[3] - ATAN_LO[3] : ATAN_HI[3] + ATAN_LO[3];
  }
  if (ix < 0x3fdc0000) {
    // |x| < 0.4375
    if (ix < 0x3e400000) return x; // |x| < 2^-27
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) {
        id = 0;
        x = (2 * x - 1) / (2 + x);
      } else {
        id = 1;
        x = (x - 1) / (x + 1);
      }
    } else if (ix < 0x40038000) {
      id = 2;
      x = (x - 1.5) / (1 + 1.5 * x);
    } else {
      id = 3;
      x = -1 / x;
    }
  }
  const z = x * x,
    w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const result = ATAN_HI[id] - (x * (s1 + s2) - ATAN_LO[id] - x);
  return hx & 0x80000000 ? -result : result;
}

const PI = 3.141592653589793116,
  PI_LO = 1.2246467991473531772e-16,
  PI_O_2 = 1.570796326794896558,
  PI_O_4 = 7.85398163397448279e-1,
  TINY = 1e-300;
export function datan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return x + y;
  if (x === 1) return datan(y);
  const hx = highWord(x),
    hy = highWord(y),
    ix = hx & 0x7fffffff,
    iy = hy & 0x7fffffff;
  let m = ((hy >>> 31) & 1) | ((hx >>> 30) & 2);
  if (y === 0) {
    if (m < 2) return y;
    return m === 2 ? PI + TINY : -PI - TINY;
  }
  if (x === 0) return hy & 0x80000000 ? -PI_O_2 - TINY : PI_O_2 + TINY;
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000)
      return [PI_O_4 + TINY, -PI_O_4 - TINY, 3 * PI_O_4 + TINY, -3 * PI_O_4 - TINY][m];
    return [0, -0, PI + TINY, -PI - TINY][m];
  }
  if (iy === 0x7ff00000) return hy & 0x80000000 ? -PI_O_2 - TINY : PI_O_2 + TINY;
  const k = (iy - ix) >> 20;
  let z: number;
  if (k > 60) {
    z = PI_O_2 + 0.5 * PI_LO;
    m &= 1;
  } else if (hx & 0x80000000 && k < -60) z = 0;
  else z = datan(Math.abs(y / x));
  switch (m) {
    case 0:
      return z;
    case 1:
      return -z;
    case 2:
      return PI - (z - PI_LO);
    default:
      return z - PI_LO - PI;
  }
}

// ── acos ──
const PIO2_HI = 1.570796326794896558,
  PIO2_LO = 6.12323399573676603587e-17,
  PS0 = 1.66666666666666657415e-1,
  PS1 = -3.25565818622400915405e-1,
  PS2 = 2.01212532134862925881e-1,
  PS3 = -4.00555345006794114027e-2,
  PS4 = 7.91534994289814532176e-4,
  PS5 = 3.4793310759602116757e-5,
  QS1 = -2.40339491173441421878,
  QS2 = 2.02094576023350569471,
  QS3 = -6.8828397160545329303e-1,
  QS4 = 7.70381505559019352791e-2;
const rational = (z: number): number =>
  (z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))))) /
  (1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4))));
export function dacos(x: number): number {
  const hx = highWord(x),
    ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    if (x === 1) return 0;
    if (x === -1) return PI + 2 * PIO2_LO;
    return NaN;
  }
  if (ix < 0x3fe00000) {
    if (ix <= 0x3c600000) return PIO2_HI + PIO2_LO;
    return PIO2_HI - (x - (PIO2_LO - x * rational(x * x)));
  }
  if (hx & 0x80000000) {
    const z = (1 + x) * 0.5,
      s = Math.sqrt(z),
      w = rational(z) * s - PIO2_LO;
    return PI - 2 * (s + w);
  }
  const z = (1 - x) * 0.5,
    s = Math.sqrt(z),
    df = clearLowWord(s),
    c = (z - df * df) / (s + df),
    w = rational(z) * s + c;
  return 2 * (df + w);
}
