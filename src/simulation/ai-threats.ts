import { lineOfSight, safePosition, traceObstacles } from '../core/collision';
import { NATIVE, RULES } from '../core/config';
import {
  add,
  clampLength,
  distance,
  dot,
  length,
  mul,
  normalize,
  reflect,
  sub,
  v,
} from '../core/math';
import type { Vec2 } from '../core/math';
import type { Actor, Arena, Disc, GameState } from '../core/types';
import { obstacleDistance } from '../core/geometry';
import { isInBoundary } from './boundary';
import { hazardKind } from './hazards';
import { dcos } from '../core/dmath';

/*
 * Threat perception for bots: a cheap forward model of the reference disc forces
 * (throw force, return pull, free slide, drag, speed limit, wall bounce) and a
 * search over evasive moves. Read-only: it never mutates the simulation.
 */
const D = NATIVE.disc;
const easeIn = (t: number): number => 1 - dcos((Math.PI / 2) * Math.min(1, Math.max(0, t)));
/** A disc closer than this to the actor's centre deals damage. */
export const HIT_DISTANCE = NATIVE.damageRadius + D.colliderRadius;

export interface DiscSample {
  t: number;
  position: Vec2;
  velocity: Vec2;
}

/** Obstacles within reach of a disc this step; prediction never scans the whole map. */
export function nearbyArena(state: GameState, center: Vec2, reach = 14): Arena {
  return {
    ...state.arena,
    obstacles: state.arena.obstacles.filter(
      (obstacle) =>
        !obstacle.broken && !obstacle.disabled && obstacleDistance(obstacle, center) < reach,
    ),
  };
}

/**
 * Predicts where a disc will be for `horizon` seconds, ignoring actors except the
 * homing target, whose position over time is `target(t)` (Disc.ApplyHoming).
 */
export function predictDisc(
  state: GameState,
  disc: Disc,
  horizon = 0.8,
  target?: (t: number) => Vec2,
  arena: Arena = nearbyArena(state, disc.position),
  step = 1 / 60,
): DiscSample[] {
  const owner = disc.ownerId >= 0 ? state.actors.find((a) => a.id === disc.ownerId) : undefined;
  let p = { ...disc.position },
    vel = { ...disc.velocity };
  let movement =
    disc.movement ??
    (disc.state === 'returning' ? 'returning' : disc.state === 'dropped' ? 'dropped' : 'throwing');
  let throwTimer = disc.throwTimer ?? 0;
  const throwDuration = disc.throwDuration ?? D.throwDuration;
  const throwStrength = disc.throwStrength ?? D.throwSpeed;
  const throwDirection = disc.throwDirection ?? normalize(vel);
  let returnTimer = disc.returnTimer ?? 0;
  let freeStrength = disc.freeStrength ?? length(vel) * D.bounciness;
  const limit = disc.speedLimit ?? D.speedLimit;
  const samples: DiscSample[] = [];
  let canHome = disc.canHome ?? true;
  const homingRadius = disc.homingRadius ?? D.homingKeyboard;
  for (let t = step; t <= horizon + 1e-9; t += step) {
    if (movement === 'dropped' || movement === 'squished') break;
    let force = v();
    if (movement === 'throwing' && canHome && target) {
      // Homing steers toward the target inside a forward cone, without adding speed.
      const goal = target(t - step);
      const offset = sub(goal, p);
      if (
        dot(normalize(offset), normalize(vel)) > D.homingDot &&
        length(offset) < homingRadius &&
        lineOfSight(arena, p, goal)
      ) {
        const speed = length(vel);
        const amount = D.throwSpeed * 1.25 + D.throwSpeed * disc.charge * 3;
        vel = clampLength(add(vel, mul(normalize(offset), (amount * step) / D.mass)), speed);
      }
    }
    if (movement === 'throwing') {
      if (throwTimer < throwDuration) {
        throwTimer += step;
        force = mul(throwDirection, throwStrength * (1 - easeIn(throwTimer / throwDuration)));
      } else if (disc.explosive || !(disc.canReturn ?? true) || !owner?.alive) {
        movement = 'free';
        freeStrength = length(vel) * D.bounciness;
      } else {
        movement = 'returning';
        returnTimer = 0;
      }
    } else if (movement === 'returning' && owner?.alive) {
      const amount =
        returnTimer < throwDuration
          ? D.returnStrength * easeIn(returnTimer / throwDuration)
          : D.throwSpeed;
      returnTimer += step;
      force = mul(normalize(sub(owner.position, p)), amount);
      if (distance(p, owner.position) < NATIVE.pickupRadius) break;
    } else if (movement === 'free') {
      freeStrength *= 1 - Math.min(1, step * D.freeDecay);
      force = mul(normalize(vel), freeStrength * 2);
      if (length(vel) < D.freeSettle) break;
    } else if (movement === 'controlled') {
      // A steered disc is unpredictable; assume it keeps its current heading.
      force = v();
    }
    vel = add(vel, mul(force, step / D.mass));
    vel = clampLength(mul(vel, Math.max(0, 1 - D.drag * step)), limit);
    const delta = mul(vel, step);
    const wall = traceObstacles(arena, p, delta, D.queryRadius);
    if (wall) {
      canHome = false;
      vel = mul(reflect(vel, wall.normal), D.bounciness);
      p = add(add(p, mul(delta, wall.t)), mul(wall.normal, 0.01));
      if (movement === 'returning') {
        movement = 'free';
        freeStrength = length(vel) * D.bounciness;
      }
    } else p = add(p, delta);
    samples.push({ t, position: p, velocity: vel });
  }
  return samples;
}

/** Discs that could cut this actor: flying, not its own and not knocked loose. */
export function hostileDiscs(state: GameState, actor: Actor): Disc[] {
  return state.discs.filter(
    (disc) =>
      !disc.dead &&
      disc.projectile !== false &&
      disc.movement !== 'dropped' &&
      disc.movement !== 'squished' &&
      !disc.startedDropped &&
      disc.ownerId !== actor.id &&
      (disc.ownerId >= 0 || (actor.frozenTime ?? 0) > 0),
  );
}

export interface DiscThreat {
  disc: Disc;
  /** Seconds until the predicted path reaches the actor's current position. */
  time: number;
  /** Closest predicted approach within the horizon. */
  miss: number;
  /** Approach direction at the moment of impact (unit). */
  heading: Vec2;
  samples: DiscSample[];
  charged: boolean;
}

export function discThreats(state: GameState, actor: Actor, horizon = 0.8): DiscThreat[] {
  const threats: DiscThreat[] = [];
  const here = { ...actor.position },
    drift = { ...actor.velocity };
  // Judge both standing still and carrying on: a moving bot can walk into a homing disc.
  const paths = [(): Vec2 => here, (t: number): Vec2 => add(here, mul(drift, Math.min(t, 0.4)))];
  for (const disc of hostileDiscs(state, actor)) {
    let worst: Omit<DiscThreat, 'disc' | 'charged'> | null = null;
    for (const path of paths) {
      const samples = predictDisc(state, disc, horizon, path);
      let best = Infinity,
        bestSample: DiscSample | null = null;
      for (const sample of samples) {
        const d = distance(sample.position, path(sample.t));
        if (d < best) {
          best = d;
          bestSample = sample;
        }
        if (d < HIT_DISTANCE) break;
      }
      if (!bestSample || best > HIT_DISTANCE + 0.35) continue;
      const hit = best < HIT_DISTANCE;
      if (
        !worst ||
        (hit && (worst.miss >= HIT_DISTANCE || bestSample.t < worst.time)) ||
        (!hit && worst.miss >= HIT_DISTANCE && best < worst.miss)
      )
        worst = {
          time: bestSample.t,
          miss: best,
          heading: normalize(bestSample.velocity),
          samples,
        };
    }
    if (worst) threats.push({ ...worst, disc, charged: disc.charge >= 1 });
  }
  return threats.sort((a, b) => a.time - b.time);
}

/** Is a landing point standable: on ground, out of walls, inside the boundary? */
export function safeLanding(state: GameState, point: Vec2, margin = 0.1): boolean {
  return (
    safePosition(state.arena, point, RULES.playerRadius + margin) &&
    hazardKind(state.arena, point) === null &&
    isInBoundary(state.boundary, point, RULES.playerRadius)
  );
}

/** Smallest distance between a moving actor path and the predicted disc samples. */
export function clearance(
  samples: readonly DiscSample[],
  path: (t: number) => Vec2,
  from = 0,
  until = Infinity,
): number {
  let best = Infinity;
  for (const sample of samples) {
    if (sample.t < from || sample.t > until) continue;
    best = Math.min(best, distance(sample.position, path(sample.t)));
  }
  return best;
}

/** Clearance of a candidate path against a disc that homes in on that same path. */
export function pathClearance(
  state: GameState,
  disc: Disc,
  path: (t: number) => Vec2,
  from = 0,
  horizon = 0.8,
): number {
  return clearance(predictDisc(state, disc, horizon, path), path, from, horizon);
}

/** Candidate escape directions, perpendicular to the threat first. */
export function escapeDirections(heading: Vec2): Vec2[] {
  const side = v(-heading.y, heading.x);
  const back = mul(heading, -1);
  const diag = (a: Vec2, b: Vec2) => normalize(add(a, b));
  return [
    side,
    mul(side, -1),
    diag(side, heading),
    diag(mul(side, -1), heading),
    diag(side, back),
    diag(mul(side, -1), back),
    heading,
    back,
  ];
}

/** Rough distance a dash covers (impulse plus the eased force, under drag). */
export const DASH_REACH = 4.5 * (NATIVE.scale / 0.4);
export const WALK_SPEED = NATIVE.actor.walk / NATIVE.actor.drag;

/** Facing within `cosine` of a direction. */
export const facingToward = (actor: Actor, direction: Vec2, cosine: number): boolean =>
  dot(actor.facing, normalize(direction)) >= cosine;
