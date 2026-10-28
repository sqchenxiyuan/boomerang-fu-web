import { clamp, normalize } from '../core/math';
import type { Actor, DeathState } from '../core/types';

/** Stateless Web presentation. Serialized original values and adaptations are in
 * docs/death-feedback-analysis.md. Nothing here decides whether an actor dies. */
export const DEATH_VISUALS = {
  faceplantTime: 0.75,
  sliceSpeed: 8,
  sliceUpward: 4,
  sliceGravity: 9.82 * 7 * 0.4,
  sliceBounce: 0.7,
  sliceDrag: 2.5,
  splatIn: 1,
  splatLifetime: 4,
  splatOut: 0.5,
} as const;

export interface DeathPose {
  baseVisible: boolean;
  pieceVisible: boolean;
  baseHeight: number;
  baseTilt: number;
  baseScale: { x: number; y: number; z: number };
  piece: { x: number; y: number; z: number; spin: number };
}

function randomAt(seed: number, index: number): number {
  let n = (seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
  n = Math.imul(n ^ (n >>> 15), 0x735a2d97);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => {
  const p = clamp(t, 0, 1);
  return p * p * (3 - 2 * p);
};

/** An analytical bounce is seekable: sampling order and frame rate cannot change it. */
function sliceHeight(age: number): { height: number; flightTime: number } {
  let height = 0.84;
  let upward = DEATH_VISUALS.sliceUpward;
  const floor = 0.27;
  const gravity = DEATH_VISUALS.sliceGravity;
  let remaining = age;
  let flightTime = 0;
  for (let bounce = 0; bounce < 5; bounce++) {
    const duration = (upward + Math.sqrt(upward ** 2 + 2 * gravity * (height - floor))) / gravity;
    if (remaining < duration)
      return {
        height: height + upward * remaining - (gravity * remaining ** 2) / 2,
        flightTime: age,
      };
    remaining -= duration;
    flightTime += duration;
    upward = (gravity * duration - upward) * DEATH_VISUALS.sliceBounce;
    height = floor;
  }
  return { height: floor, flightTime };
}

export function sampleDeathPose(death: DeathState, time: number): DeathPose {
  const age = Math.max(0, time - death.time);
  const isSlice = death.variant === 'slice';
  const isSquash = death.variant === 'squash';
  const direction = normalize(death.direction);
  const flight = sliceHeight(age);
  const travel =
    (DEATH_VISUALS.sliceSpeed * (1 - Math.exp(-DEATH_VISUALS.sliceDrag * age))) /
    DEATH_VISUALS.sliceDrag;
  const fall = smooth((age - 0.12) / (DEATH_VISUALS.faceplantTime - 0.12));
  return {
    baseVisible: isSlice || isSquash,
    pieceVisible: isSlice,
    baseHeight: isSquash ? 0.18 : 0.82 - fall * 0.43,
    baseTilt: isSlice ? fall * Math.PI * 0.48 : 0,
    baseScale: isSquash ? { x: 1.28, y: 0.22, z: 1.22 } : { x: 1, y: 1, z: 1 },
    piece: {
      x: direction.x * travel,
      y: flight.height,
      z: direction.y * travel,
      spin: flight.flightTime * 6.1,
    },
  };
}

export function sampleFallPose(fall: NonNullable<Actor['fall']>): {
  height: number;
  tilt: number;
  scale: number;
} {
  const progress = clamp(fall.elapsed / Math.max(0.001, fall.duration), 0, 1);
  if (fall.kind === 'cliff')
    return { height: -5 * smooth((fall.elapsed - 0.3) / 0.44), tilt: -0.1 * progress, scale: 1 };
  return {
    height: -0.9 * smooth((progress - 0.28) / 0.72),
    tilt: Math.sin(progress * Math.PI * 5) * 0.1,
    scale: 1 - smooth((progress - 0.65) / 0.35) * 0.28,
  };
}

export interface DeathParticleSample {
  kind: 'juice' | 'water' | 'bubble' | 'cloud' | 'burst' | 'dust';
  x: number;
  y: number;
  z: number;
  radius: number;
  opacity: number;
}

export function sampleDeathParticles(death: DeathState, time: number): DeathParticleSample[] {
  const age = Math.max(0, time - death.time);
  const output: DeathParticleSample[] = [];
  const water = death.variant === 'water';
  const cliff = death.variant === 'cliff';
  const burst = death.variant === 'burst';
  const direction = normalize(death.direction);
  const count = water ? 26 : cliff ? 12 : burst ? 22 : 24;
  for (let index = 0; index < count; index++) {
    const r = (n: number): number => randomAt(death.seed, index * 7 + n);
    const bubble = water && index >= 18;
    const start = bubble ? 0.18 + r(0) * 0.65 : 0;
    const duration = bubble
      ? 0.5 + r(1) * 0.4
      : cliff
        ? 0.5 + r(1) * 0.5
        : water
          ? 0.55 + r(1) * 0.1
          : burst
            ? 0.35 + r(1) * 0.35
            : 1 + r(1) * 0.66;
    const t = age - start;
    if (t < 0 || t >= duration) continue;
    const angle = r(2) * Math.PI * 2;
    const speed = bubble ? 0.25 : cliff ? 0.5 + r(3) : water ? 0.9 + r(3) * 1.8 : 1.2 + r(3) * 3;
    const travel = (speed * (1 - Math.exp(-t * 2))) / 2;
    const directed = !water && !cliff && !burst ? 0.6 * travel : 0;
    const opacity = (1 - t / duration) ** 0.6;
    output.push({
      kind: bubble ? 'bubble' : water ? 'water' : cliff ? 'cloud' : burst ? 'burst' : 'juice',
      x: Math.cos(angle) * travel + direction.x * directed,
      z: Math.sin(angle) * travel + direction.y * directed,
      y: bubble
        ? 0.04 + t * 0.17
        : cliff
          ? -0.6 + t * 0.5
          : Math.max(0.035, (water ? 0.05 : 0.7) + (1.4 + r(4) * 2.2) * t - 5 * t ** 2),
      radius: bubble
        ? (0.05 + r(5) * 0.07) * Math.sin((Math.PI * t) / duration)
        : cliff
          ? (0.16 + r(5) * 0.13) * (1 + t)
          : (0.045 + r(5) * 0.065) * Math.sqrt(opacity),
      opacity,
    });
  }
  if (death.variant === 'slice') {
    const t = age - DEATH_VISUALS.faceplantTime;
    if (t >= 0 && t < 0.4)
      for (let i = 0; i < 8; i++) {
        const angle = (i * Math.PI) / 4;
        output.push({
          kind: 'dust',
          x: Math.cos(angle) * t * 1.8,
          y: 0.08 + t * 0.2,
          z: Math.sin(angle) * t * 1.8,
          radius: 0.09 * (1 - t / 0.4),
          opacity: 1 - t / 0.4,
        });
      }
  }
  return output;
}

export interface DeathRingSample {
  radius: number;
  opacity: number;
}
export function sampleDeathRings(death: DeathState, time: number): DeathRingSample[] {
  const age = time - death.time;
  if (death.variant !== 'water' && death.variant !== 'burst') return [];
  const rings: DeathRingSample[] = [];
  for (let i = 0; i < (death.variant === 'water' ? 3 : 1); i++) {
    const t = age - i * 0.17;
    const duration = death.variant === 'burst' ? 0.2 : 0.85;
    if (t >= 0 && t < duration)
      rings.push({
        radius: 0.2 + t * (death.variant === 'burst' ? 5 : 1.8),
        opacity: (1 - t / duration) * 0.7,
      });
  }
  return rings;
}

export interface DeathSplatSample {
  x: number;
  z: number;
  radius: number;
  angle: number;
  opacity: number;
}
export function sampleDeathSplats(death: DeathState, time: number): DeathSplatSample[] {
  if (death.variant !== 'slice' && death.variant !== 'squash') return [];
  const age = time - death.time;
  const arrival = death.variant === 'squash' ? 0 : 0.18;
  const scale = smooth((age - arrival) / DEATH_VISUALS.splatIn);
  const opacity = clamp(
    1 -
      (age - arrival - DEATH_VISUALS.splatIn - DEATH_VISUALS.splatLifetime) /
        DEATH_VISUALS.splatOut,
    0,
    1,
  );
  if (scale === 0 || opacity === 0) return [];
  return Array.from({ length: death.variant === 'squash' ? 3 : 5 }, (_, i) => ({
    x: (randomAt(death.seed, 300 + i * 3) - 0.5) * 1.5,
    z: (randomAt(death.seed, 301 + i * 3) - 0.5) * 1.5,
    radius: (0.18 + randomAt(death.seed, 302 + i * 3) * 0.25) * scale,
    angle: randomAt(death.seed, 400 + i) * Math.PI,
    opacity: opacity * 0.72,
  }));
}
