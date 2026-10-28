import { lineOfSight, segmentCircle, sweepPaths, traceObstacles } from '../core/collision';
import { RULES } from '../core/config';
import {
  closestOnSegment,
  floorContains,
  inPaths,
  localPoint,
  obstacleOverlaps,
  obstaclePaths,
  pathBounds,
  shapeContains,
} from '../core/geometry';
import {
  add,
  clamp,
  distance,
  dot,
  length,
  lerp,
  lerpV,
  mul,
  normalize,
  rotate,
  sub,
  v,
} from '../core/math';
import type { Random, Vec2 } from '../core/math';
import type {
  EnvironmentMechanism,
  EnvironmentStrike,
  EnvironmentWaypoint,
} from '../core/environment-types';
import type { Floor, GameState, Obstacle } from '../core/types';
import { damageActor } from './combat';
import { recoverDisc } from './inventory';
import { addZone } from './status-effects';
import { hazardContactPoints } from './hazards';

const PI2 = Math.PI * 2;
const easeIn = (t: number): number => 1 - Math.cos((Math.PI * clamp(t, 0, 1)) / 2);
const easeOut = (t: number): number => Math.sin((Math.PI * clamp(t, 0, 1)) / 2);
const easeBoth = (t: number): number => (1 - Math.cos(Math.PI * clamp(t, 0, 1))) / 2;
const cubicBoth = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const decrement = (time: number | undefined, dt: number): number =>
  Math.max(0, (time ?? 0) - dt - 1e-12);
const mechanisms = (state: GameState): EnvironmentMechanism[] =>
  state.arena.environment?.mechanisms ?? [];
const nearestAngle = (from: number, to: number): number =>
  from + Math.atan2(Math.sin(to - from), Math.cos(to - from));

function changed(state: GameState, mechanism: EnvironmentMechanism): void {
  state.arena.revision = (state.arena.revision ?? 0) + 1;
  state.events.push({
    type: 'environment',
    position: { ...mechanism.position },
    actorId: mechanism.ownerId ?? -1,
    mechanismId: mechanism.id,
  });
}

/** Trigger shape queries use the same polygon conventions as world collision. */
function touches(
  mechanism: Pick<EnvironmentMechanism, 'position' | 'angle' | 'paths' | 'radius'>,
  point: Vec2,
  padding = 0,
): boolean {
  if (mechanism.radius !== undefined)
    return distance(point, mechanism.position) <= mechanism.radius + padding;
  if (mechanism.paths?.length) {
    const local = localPoint(point, mechanism);
    const { min, max } = pathBounds(mechanism.paths);
    if (
      local.x < min.x - padding ||
      local.x > max.x + padding ||
      local.y < min.y - padding ||
      local.y > max.y + padding
    )
      return false;
    if (inPaths(local, mechanism.paths)) return true;
    if (padding > 0)
      for (const path of mechanism.paths)
        for (let i = 0; i < path.length; i++)
          if (
            distance(local, closestOnSegment(local, path[i], path[(i + 1) % path.length])) <=
            padding
          )
            return true;
    return false;
  }
  return distance(point, mechanism.position) <= (mechanism.radius ?? 0.45) + padding;
}

const floorIndexes = new WeakMap<Floor[], { count: number; byId: Map<string, Floor> }>();
function surfaceFloors(state: GameState, mechanism: EnvironmentMechanism): Floor[] {
  const floors = state.arena.floors;
  if (!floors || !mechanism.floorIds?.length) return [];
  let index = floorIndexes.get(floors);
  if (!index || index.count !== floors.length) {
    index = { count: floors.length, byId: new Map(floors.map((floor) => [floor.id, floor])) };
    floorIndexes.set(floors, index);
  }
  return mechanism.floorIds
    .map((id) => index!.byId.get(id))
    .filter((floor): floor is Floor => !!floor);
}

function setFloorSupport(state: GameState, mechanism: EnvironmentMechanism, active: boolean): void {
  let different = false;
  for (const floor of surfaceFloors(state, mechanism)) {
    different ||= floor.active !== active;
    floor.active = active;
  }
  if (different) {
    changed(state, mechanism);
    if (!active) {
      const contains = (point: Vec2): boolean =>
        surfaceFloors(state, mechanism).some((floor) => shapeContains(floor, point));
      state.zones = state.zones.filter((zone) => !contains(zone.position));
      state.pickups = state.pickups.filter((pickup) => !contains(pickup.position));
    }
  }
}

function beginPath(mechanism: EnvironmentMechanism, random?: Random): void {
  const path = mechanism.waypoints ?? [];
  if (path.length < 2) {
    mechanism.phase = 'idle';
    return;
  }
  const index = mechanism.targetIndex ?? 0;
  mechanism.startPosition = { ...path[index].position };
  mechanism.startAngle = nearestAngle(
    mechanism.angle ?? 0,
    path[index].angle ?? mechanism.angle ?? 0,
  );
  mechanism.targetIndex = (index + 1) % path.length;
  mechanism.targetPosition = { ...path[mechanism.targetIndex].position };
  let targetAngle = path[mechanism.targetIndex].angle ?? mechanism.angle ?? 0;
  if (mechanism.kind === 'movingFloor') {
    targetAngle = nearestAngle(mechanism.startAngle, targetAngle);
    if (mechanism.clockwise && targetAngle < mechanism.startAngle - 1e-8) targetAngle += PI2;
    if (mechanism.clockwise === false && targetAngle > mechanism.startAngle + 1e-8)
      targetAngle -= PI2;
  } else targetAngle = nearestAngle(mechanism.startAngle, targetAngle);
  mechanism.targetAngle = targetAngle;
  const span = sub(mechanism.targetPosition, mechanism.startPosition);
  const turn = targetAngle - mechanism.startAngle;
  mechanism.progress = clamp(
    length(span) > 1e-8
      ? dot(sub(mechanism.position, mechanism.startPosition), span) / dot(span, span)
      : Math.abs(turn) > 1e-8
        ? ((mechanism.angle ?? 0) - mechanism.startAngle) / turn
        : 0,
    0,
    1,
  );
  mechanism.elapsed = 0;
  mechanism.targetDuration =
    random?.range(
      mechanism.minDuration ?? mechanism.duration ?? 0.5,
      mechanism.maxDuration ?? mechanism.minDuration ?? mechanism.duration ?? 0.5,
    ) ??
    mechanism.duration ??
    0.5;
  mechanism.currentDuration ??= mechanism.minDuration ?? mechanism.duration ?? 0.5;
  mechanism.phase = 'moving';
}

/** Public for deterministic SDK/debug controls; switches call this same state machine. */
export function activateEnvironment(state: GameState, id: string, actorId = -1): boolean {
  const mechanism = mechanisms(state).find((candidate) => candidate.id === id);
  if (!mechanism || mechanism.active === false) return false;
  if (mechanism.kind === 'switch') {
    if ((mechanism.cooldown ?? 0) > 0) return false;
    mechanism.cooldown = mechanism.cooldownDuration ?? 0.5;
    mechanism.flashTime = 0.75;
    mechanism.ownerId = actorId;
    if (mechanism.oneShot) mechanism.active = false;
    for (const target of mechanism.targetIds ?? []) activateEnvironment(state, target, actorId);
    changed(state, mechanism);
    return true;
  }
  mechanism.ownerId = actorId;
  mechanism.flashTime = 0.6;
  if (mechanism.rotating) {
    const durations = mechanism.rotationDurations ?? [];
    if (durations.length > 1)
      mechanism.targetIndex = ((mechanism.targetIndex ?? 0) + 1) % durations.length;
    else mechanism.clockwise = !(mechanism.clockwise ?? true);
    return true;
  }
  if (mechanism.kind === 'door') {
    if (!mechanism.closed && !mechanism.canClose) return false;
    mechanism.startHeight = mechanism.closed
      ? (mechanism.closedHeight ?? 0)
      : (mechanism.openHeight ?? -3);
    mechanism.targetHeight = mechanism.closed
      ? (mechanism.openHeight ?? -3)
      : (mechanism.closedHeight ?? 0);
    mechanism.closed = !mechanism.closed;
    mechanism.progress = mechanism.phase === 'moving' ? 1 - (mechanism.progress ?? 0) : 0;
    mechanism.phase = 'moving';
    return true;
  }
  if (mechanism.kind === 'trapFloor' || mechanism.kind === 'fallingFloor') {
    if ((mechanism.phase ?? 'idle') !== 'idle') return false;
    mechanism.phase = 'warning';
    mechanism.elapsed = 0;
    changed(state, mechanism);
    return true;
  }
  const path = mechanism.waypoints ?? [];
  if (path.length < 2) return false;
  if (mechanism.phase === 'springPause') mechanism.phase = 'moving';
  else {
    const inMotion = mechanism.phase === 'moving' || mechanism.phase === 'preparing';
    const index = mechanism.targetIndex ?? 0;
    mechanism.startPosition = { ...path[index].position };
    mechanism.startAngle = nearestAngle(
      mechanism.angle ?? 0,
      path[index].angle ?? mechanism.angle ?? 0,
    );
    if (inMotion && !mechanism.reverse) {
      mechanism.targetIndex = (index + path.length - 1) % path.length;
      mechanism.reverse = true;
    } else {
      mechanism.targetIndex = (index + 1) % path.length;
      mechanism.reverse = false;
    }
    mechanism.targetPosition = { ...path[mechanism.targetIndex].position };
    mechanism.targetAngle = nearestAngle(
      mechanism.startAngle,
      path[mechanism.targetIndex].angle ?? mechanism.angle ?? 0,
    );
    mechanism.progress = inMotion ? 1 - (mechanism.progress ?? 0) : 0;
    mechanism.phase = 'preparing';
  }
  mechanism.returning = false;
  mechanism.elapsed = 0;
  return true;
}

function initialize(state: GameState, random: Random): void {
  const env = state.arena.environment;
  if (!env || env.initialized) return;
  for (const mechanism of env.mechanisms) {
    mechanism.angle ??= 0;
    mechanism.height ??= 0;
    mechanism.initialHeight ??= mechanism.height;
    mechanism.previous = { ...mechanism.position };
    mechanism.previousAngle = mechanism.angle;
    mechanism.previousHeight = mechanism.height;
    mechanism.phase ??= 'idle';
    mechanism.targetIndex ??= 0;
    mechanism.currentDuration ??= mechanism.minDuration ?? mechanism.duration ?? 0.5;
    if (
      mechanism.randomizedStart &&
      mechanism.waypoints &&
      mechanism.waypoints.length > 1 &&
      random.next() > 0.5
    ) {
      mechanism.targetIndex = 1;
      const prior = { ...mechanism.position };
      mechanism.position = { ...mechanism.waypoints[1].position };
      applyPose(state, mechanism, prior, mechanism.angle, false);
    }
    if (mechanism.rotating) {
      mechanism.phase = 'moving';
      if ((mechanism.rotationDurations?.length ?? 0) > 1)
        mechanism.rotationDuration = mechanism.rotationDurations![mechanism.targetIndex];
    } else if (mechanism.kind === 'movingFloor') beginPath(mechanism, random);
    mechanism.initialized = true;
  }
  if (env.collapse?.enabled && !env.collapse.playlist) {
    const box = state.arena.boundary?.half ?? v(state.arena.halfWidth, state.arena.halfHeight);
    env.collapse.finalPoint ??= v(
      random.range(-box.x * 0.8, box.x * 0.8),
      random.range(-box.y * 0.8, box.y * 0.8),
    );
    env.collapse.playlist = env.mechanisms
      .filter((mechanism) => mechanism.kind === 'fallingFloor')
      .sort(
        (a, b) =>
          distance(a.position, env.collapse!.finalPoint!) -
          distance(b.position, env.collapse!.finalPoint!),
      )
      .map((mechanism) => mechanism.id);
  }
  env.initialized = true;
}

function moveWaypoint(mechanism: EnvironmentMechanism, progress: number): EnvironmentWaypoint {
  const origin = mechanism.motionOrigin ?? v(),
    angle = mechanism.motionAngle ?? 0;
  const start = rotate(sub(mechanism.startPosition ?? mechanism.position, origin), -angle);
  const end = rotate(sub(mechanism.targetPosition ?? mechanism.position, origin), -angle);
  let position: Vec2;
  if (mechanism.kind !== 'movingFloor')
    position = lerpV(start, end, mechanism.reverse ? easeIn(progress) : easeOut(progress));
  else
    switch (mechanism.motion ?? 'linear') {
      case 'circular': {
        const even = (mechanism.targetIndex ?? 0) % 2 === 0;
        position = v(
          lerp(start.x, end.x, even ? easeIn(progress) : easeOut(progress)),
          lerp(start.y, end.y, even ? easeOut(progress) : easeIn(progress)),
        );
        break;
      }
      case 'supercircular': {
        const t = progress * 0.715 + progress * progress * (3 - 2 * progress) * 0.285;
        position = lerpV(
          lerpV(start, add(start, end), easeBoth(progress)),
          lerpV(add(start, end), end, easeBoth(progress)),
          t,
        );
        break;
      }
      case 'eased':
        position = v(
          lerp(start.x, end.x, cubicBoth(progress)),
          lerp(start.y, end.y, easeBoth(progress)),
        );
        break;
      case 'easedsoft':
        position = lerpV(start, end, easeBoth(progress));
        break;
      default:
        position = lerpV(start, end, progress);
    }
  return {
    position: add(origin, rotate(position, angle)),
    angle: lerp(
      mechanism.startAngle ?? mechanism.angle ?? 0,
      mechanism.targetAngle ?? mechanism.angle ?? 0,
      mechanism.kind === 'reactiveFloor' ? easeBoth(progress) : progress,
    ),
  };
}

function tickMotion(
  mechanism: EnvironmentMechanism,
  random: Random,
  dt: number,
  time: number,
): void {
  if (mechanism.rotating) {
    let duration = mechanism.rotationDuration ?? 4;
    if (mechanism.rotationModulation) {
      const wave = mechanism.rotationModulation;
      duration = wave.initialDuration + wave.amplitude * Math.sin(wave.rate * time);
    } else if ((mechanism.rotationDurations?.length ?? 0) > 1) {
      const target = mechanism.rotationDurations![mechanism.targetIndex ?? 0];
      // Unity SmoothDamp's critically damped update, smoothTime=.5.
      if (duration < target) {
        const omega = 4,
          x = omega * dt,
          decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x ** 3);
        const change = duration - target,
          temporary = ((mechanism.rotationSmoothingVelocity ?? 0) + omega * change) * dt;
        mechanism.rotationSmoothingVelocity =
          ((mechanism.rotationSmoothingVelocity ?? 0) - omega * temporary) * decay;
        duration = target + (change + temporary) * decay;
      } else duration = target;
    }
    mechanism.rotationDuration = duration;
    mechanism.angularVelocity =
      ((mechanism.clockwise === false ? 1 : -1) * PI2) / Math.max(0.05, Math.abs(duration));
    mechanism.angle = (mechanism.angle ?? 0) + mechanism.angularVelocity * dt;
    return;
  }
  if (mechanism.phase === 'preparing' || mechanism.phase === 'springPause') {
    mechanism.elapsed = (mechanism.elapsed ?? 0) + dt;
    const delay =
      mechanism.phase === 'springPause'
        ? (mechanism.springPause ?? 0.25)
        : (mechanism.preDelay ?? 0.35);
    if (mechanism.elapsed + 1e-10 < delay) return;
    mechanism.phase = 'moving';
    mechanism.elapsed = 0;
  }
  if (mechanism.phase !== 'moving') return;
  if (mechanism.kind === 'door') {
    mechanism.progress = Math.min(
      1,
      (mechanism.progress ?? 0) + dt / Math.max(0.01, mechanism.duration ?? 0.25),
    );
    mechanism.height = lerp(
      mechanism.startHeight ?? 0,
      mechanism.targetHeight ?? 0,
      easeIn(mechanism.progress),
    );
    if (mechanism.progress >= 1) mechanism.phase = 'idle';
    return;
  }
  if (mechanism.kind === 'movingFloor')
    mechanism.currentDuration = lerp(
      mechanism.currentDuration ?? 0.5,
      mechanism.targetDuration ?? 0.5,
      Math.min(dt, 1),
    );
  const duration = mechanism.returning
    ? (mechanism.returnDuration ?? 2)
    : mechanism.kind === 'movingFloor'
      ? (mechanism.currentDuration ?? 0.5)
      : (mechanism.duration ?? mechanism.minDuration ?? 0.5);
  mechanism.progress = Math.min(1, (mechanism.progress ?? 0) + dt / Math.max(0.01, duration));
  const next = moveWaypoint(mechanism, mechanism.progress);
  mechanism.position = next.position;
  mechanism.angle = next.angle;
  if (mechanism.progress >= 1) {
    if (mechanism.kind === 'movingFloor') beginPath(mechanism, random);
    else if (
      mechanism.spring &&
      !mechanism.returning &&
      mechanism.targetIndex === 1 &&
      (mechanism.waypoints?.length ?? 0) === 2
    ) {
      mechanism.startPosition = { ...mechanism.waypoints![1].position };
      mechanism.targetPosition = { ...mechanism.waypoints![0].position };
      mechanism.startAngle = nearestAngle(
        mechanism.angle ?? 0,
        mechanism.waypoints![1].angle ?? mechanism.angle ?? 0,
      );
      mechanism.targetAngle = nearestAngle(
        mechanism.startAngle,
        mechanism.waypoints![0].angle ?? mechanism.angle ?? 0,
      );
      mechanism.targetIndex = 0;
      mechanism.returning = true;
      mechanism.reverse = false;
      mechanism.progress = 0;
      mechanism.elapsed = 0;
      mechanism.phase = 'springPause';
    } else {
      mechanism.phase = 'idle';
      mechanism.reverse = false;
    }
  }
}

function applyPose(
  state: GameState,
  mechanism: EnvironmentMechanism,
  previous: Vec2,
  previousAngle: number,
  carry = true,
): void {
  const angle = (mechanism.angle ?? 0) - previousAngle;
  const transform = (point: Vec2): Vec2 =>
    add(mechanism.position, rotate(sub(point, previous), angle));
  const floors = surfaceFloors(state, mechanism);
  if (carry && (mechanism.kind === 'movingFloor' || mechanism.kind === 'reactiveFloor')) {
    for (const actor of state.actors)
      if (actor.alive && !actor.fall && actor.movingFloorId === mechanism.id) {
        actor.position = transform(actor.position);
        actor.previous = transform(actor.previous);
        actor.facing = rotate(actor.facing, angle);
        actor.dashDirection = rotate(actor.dashDirection, angle);
      }
    for (const disc of state.discs)
      if (
        !disc.dead &&
        disc.state === 'dropped' &&
        state.arena.environment?.riders?.[`disc:${disc.id}`] === mechanism.id
      ) {
        disc.position = transform(disc.position);
        disc.previous = transform(disc.previous);
      }
    for (const pickup of state.pickups)
      if (state.arena.environment?.riders?.[`pickup:${pickup.id}`] === mechanism.id)
        pickup.position = transform(pickup.position);
    for (const zone of state.zones)
      if (state.arena.environment?.riders?.[`zone:${zone.id}`] === mechanism.id)
        zone.position = transform(zone.position);
    for (const decoy of state.decoys)
      if (decoy.alive && state.arena.environment?.riders?.[`decoy:${decoy.id}`] === mechanism.id) {
        decoy.position = transform(decoy.position);
        decoy.previous = transform(decoy.previous);
      }
  }
  for (const floor of floors) {
    floor.position = transform(floor.position);
    floor.angle = (floor.angle ?? 0) + angle;
  }
  for (const obstacle of state.arena.obstacles)
    if (mechanism.obstacleIds?.includes(obstacle.id)) {
      obstacle.position = transform(obstacle.position);
      obstacle.angle = (obstacle.angle ?? 0) + angle;
    }
  for (const portal of state.arena.portals ?? [])
    if (mechanism.portalIds?.includes(portal.id)) {
      portal.position = transform(portal.position);
      portal.direction = rotate(portal.direction, angle);
      portal.angle = (portal.angle ?? 0) + angle;
    }
  for (const child of mechanisms(state))
    if (child.parentId === mechanism.id) {
      const old = { ...child.position },
        oldAngle = child.angle ?? 0;
      child.position = transform(child.position);
      child.angle = oldAngle + angle;
      for (const waypoint of child.waypoints ?? []) {
        waypoint.position = transform(waypoint.position);
        if (waypoint.angle !== undefined) waypoint.angle += angle;
      }
      if (child.startPosition) child.startPosition = transform(child.startPosition);
      if (child.targetPosition) child.targetPosition = transform(child.targetPosition);
      if (child.motionOrigin) child.motionOrigin = transform(child.motionOrigin);
      if (child.motionAngle !== undefined) child.motionAngle += angle;
      if (child.startAngle !== undefined) child.startAngle += angle;
      if (child.targetAngle !== undefined) child.targetAngle += angle;
      applyPose(state, child, old, oldAngle, carry);
    }
}

function escapePoint(obstacle: Obstacle, position: Vec2, radius: number): Vec2 {
  const point = localPoint(position, obstacle);
  if (obstacle.radius !== undefined)
    return add(
      obstacle.position,
      rotate(
        mul(length(point) > 1e-8 ? normalize(point) : v(1, 0), obstacle.radius + radius + 0.002),
        obstacle.angle ?? 0,
      ),
    );
  const paths = obstaclePaths(obstacle),
    inside = inPaths(point, paths);
  let nearest = Infinity,
    projected = point,
    direction = v(1, 0);
  for (const path of paths)
    for (let i = 0; i < path.length; i++) {
      const a = path[i],
        b = path[(i + 1) % path.length],
        closest = closestOnSegment(point, a, b),
        d = distance(point, closest);
      if (d < nearest) {
        nearest = d;
        projected = closest;
        direction = normalize(inside ? sub(closest, point) : sub(point, closest));
        if (length(direction) < 0.01) {
          const edge = sub(b, a);
          direction = normalize(v(-edge.y, edge.x));
          if (inPaths(add(closest, mul(direction, 0.01)), paths)) direction = mul(direction, -1);
        }
      }
    }
  return add(
    obstacle.position,
    rotate(add(projected, mul(direction, radius + 0.002)), obstacle.angle ?? 0),
  );
}

function pushObstacles(state: GameState, mechanism: EnvironmentMechanism): void {
  const moving = state.arena.obstacles.filter(
    (obstacle) =>
      !obstacle.broken && !obstacle.disabled && mechanism.obstacleIds?.includes(obstacle.id),
  );
  if (!moving.length) return;
  const overlaps = (point: Vec2, radius: number): boolean =>
    moving.some((obstacle) => obstacleOverlaps(obstacle, point, radius - 0.001));
  const resolve = (point: Vec2, radius: number): { position: Vec2; crushed: boolean } => {
    let next = { ...point };
    for (let iteration = 0; iteration < 5; iteration++) {
      const obstacle = state.arena.obstacles.find(
        (candidate) =>
          !candidate.disabled &&
          !candidate.broken &&
          obstacleOverlaps(candidate, next, radius - 0.001),
      );
      if (!obstacle) return { position: next, crushed: false };
      next = escapePoint(obstacle, next, radius);
    }
    return {
      position: next,
      crushed: state.arena.obstacles.some(
        (candidate) =>
          !candidate.disabled &&
          !candidate.broken &&
          obstacleOverlaps(candidate, next, radius - 0.001),
      ),
    };
  };
  for (const actor of state.actors)
    if (
      actor.alive &&
      !(actor.powers.includes('wallDash') && actor.dashTime > 0) &&
      overlaps(actor.position, RULES.playerRadius)
    ) {
      const fixed = resolve(actor.position, RULES.playerRadius);
      if (fixed.crushed)
        damageActor(
          state,
          actor,
          mechanism.ownerId ?? actor.id,
          mechanism.velocity ?? v(),
          'crush',
        );
      else {
        const drift = sub(fixed.position, actor.position);
        actor.position = fixed.position;
        const radial = sub(actor.position, mechanism.position);
        const velocity = add(
          mechanism.velocity ?? v(),
          mul(v(-radial.y, radial.x), mechanism.angularVelocity ?? 0),
        );
        const normal = normalize(drift);
        actor.velocity = add(
          actor.velocity,
          mul(normal, Math.max(0, dot(sub(velocity, actor.velocity), normal))),
        );
      }
    }
  for (const disc of state.discs)
    if (!disc.dead && overlaps(disc.position, RULES.discRadius)) {
      const fixed = resolve(disc.position, RULES.discRadius);
      if (fixed.crushed) recoverDisc(state, disc);
      else disc.position = fixed.position;
    }
  state.zones = state.zones.filter((zone) => !overlaps(zone.position, zone.radius));
  for (const obstacle of state.arena.obstacles)
    if (
      obstacle.kind === 'crate' &&
      !obstacle.broken &&
      !mechanism.obstacleIds?.includes(obstacle.id) &&
      overlaps(obstacle.position, Math.min(obstacle.half.x, obstacle.half.y))
    )
      damageEnvironmentObstacle(state, obstacle, mechanism.ownerId ?? -1);
}

function tickFloor(state: GameState, mechanism: EnvironmentMechanism, dt: number): void {
  const trap = mechanism.kind === 'trapFloor';
  const phase = mechanism.phase ?? 'idle';
  if (phase === 'idle') return;
  if (!trap && phase === 'warning' && state.arena.environment?.collapse?.enabled === false) return;
  mechanism.elapsed = (mechanism.elapsed ?? 0) + dt;
  const elapsed = mechanism.elapsed;
  const floors = surfaceFloors(state, mechanism);
  if (phase === 'warning') {
    const duration = mechanism.warningDuration ?? (trap ? 2.5 : 2);
    for (const floor of floors) floor.warning = clamp(elapsed / duration, 0, 1);
    if (elapsed + 1e-10 >= duration) {
      mechanism.phase = 'falling';
      mechanism.elapsed = 0;
      setFloorSupport(state, mechanism, false);
    }
  } else if (phase === 'falling') {
    const duration = mechanism.fallDuration ?? (trap ? 1 : 0.75);
    mechanism.progress = easeOut(elapsed / duration);
    mechanism.height =
      (mechanism.initialHeight ?? 0) -
      (mechanism.fallDistance ?? (trap ? 5 : 6) * RULES.worldScale) * mechanism.progress;
    for (const floor of floors) {
      floor.fallProgress = mechanism.progress;
      floor.warning = 0;
    }
    if (elapsed + 1e-10 >= duration) {
      mechanism.elapsed = 0;
      mechanism.phase = trap ? 'respawning' : 'cut';
      const descendants = [mechanism];
      for (let i = 0; i < descendants.length; i++)
        descendants.push(
          ...mechanisms(state).filter((child) => child.parentId === descendants[i].id),
        );
      for (const member of descendants) {
        for (const obstacle of state.arena.obstacles)
          if (member.obstacleIds?.includes(obstacle.id)) {
            if (obstacle.kind === 'crate') damageEnvironmentObstacle(state, obstacle, -1);
            else if (!trap) obstacle.disabled = true;
          }
        if (!trap && member !== mechanism) {
          member.active = false;
          member.phase = 'cut';
        }
      }
    }
  } else if (phase === 'respawning' && elapsed + 1e-10 >= (mechanism.respawnDuration ?? 4)) {
    mechanism.phase = 'rising';
    mechanism.elapsed = 0;
    changed(state, mechanism);
  } else if (phase === 'rising') {
    const duration = mechanism.riseDuration ?? 0.5;
    mechanism.progress = 1 - easeOut(elapsed / duration);
    mechanism.height =
      (mechanism.initialHeight ?? 0) -
      (mechanism.fallDistance ?? 5 * RULES.worldScale) * mechanism.progress;
    for (const floor of floors) floor.fallProgress = mechanism.progress;
    if (elapsed + 1e-10 >= (mechanism.solidAfter ?? 0.2)) setFloorSupport(state, mechanism, true);
    if (elapsed + 1e-10 >= duration) {
      mechanism.phase = 'idle';
      mechanism.elapsed = 0;
      mechanism.height = mechanism.initialHeight ?? 0;
    }
  }
}

/** Advance before player movement. Moving bodies and floor support are authoritative. */
export function tickEnvironment(state: GameState, random: Random, dt: number): void {
  const env = state.arena.environment;
  if (!env || state.phase !== 'playing') return;
  initialize(state, random);
  const platforms = env.mechanisms.filter(
    (mechanism) =>
      mechanism.active !== false &&
      (mechanism.kind === 'movingFloor' || mechanism.kind === 'reactiveFloor'),
  );
  for (const actor of state.actors) {
    const supports = (mechanism: EnvironmentMechanism): boolean =>
      actor.alive &&
      !actor.fall &&
      surfaceFloors(state, mechanism).some(
        (floor) =>
          floor.active &&
          (floorContains(floor, actor.position) ||
            (touches(floor, actor.position, RULES.playerRadius) &&
              hazardContactPoints(state.arena, actor.position, RULES.playerRadius * 0.95) > 4)),
      );
    const current = platforms.find((platform) => platform.id === actor.movingFloorId);
    if (!current || !supports(current)) actor.movingFloorId = platforms.find(supports)?.id;
  }
  const previousRiders = env.riders ?? {},
    riders: Record<string, string> = {};
  const attach = (key: string, point: Vec2): void => {
    const supports = (mechanism: EnvironmentMechanism): boolean =>
      surfaceFloors(state, mechanism).some((floor) => floorContains(floor, point));
    const current = platforms.find((platform) => platform.id === previousRiders[key]);
    const parent = current && supports(current) ? current : platforms.find(supports);
    if (parent) riders[key] = parent.id;
  };
  for (const disc of state.discs)
    if (!disc.dead && disc.state === 'dropped') attach(`disc:${disc.id}`, disc.position);
  for (const pickup of state.pickups) attach(`pickup:${pickup.id}`, pickup.position);
  for (const zone of state.zones) attach(`zone:${zone.id}`, zone.position);
  for (const decoy of state.decoys) if (decoy.alive) attach(`decoy:${decoy.id}`, decoy.position);
  env.riders = riders;
  if (env.collapse?.enabled) {
    if (state.actors.filter((actor) => actor.alive).length <= 1) env.collapse.enabled = false;
    else if ((env.collapse.playlist?.length ?? 0) > 6) {
      env.collapse.remaining -= dt;
      if (env.collapse.remaining <= 0) {
        activateEnvironment(state, env.collapse.playlist!.pop()!);
        env.collapse.remaining = env.collapse.interval * random.range(0.9, 1.111);
      }
    }
  }
  let moving = false;
  for (const mechanism of env.mechanisms) {
    mechanism.previous = { ...mechanism.position };
    mechanism.previousAngle = mechanism.angle ?? 0;
    mechanism.previousHeight = mechanism.height ?? 0;
    mechanism.cooldown = decrement(mechanism.cooldown, dt);
    mechanism.flashTime = decrement(mechanism.flashTime, dt);
    mechanism.disturbance = Math.max(0, (mechanism.disturbance ?? 0) - dt * 2);
    if (mechanism.active === false) continue;
    if (mechanism.automaticDelay !== undefined && mechanism.automaticDelay >= 0) {
      mechanism.automaticDelay -= dt;
      if (mechanism.automaticDelay <= 0) {
        mechanism.automaticDelay = -1;
        activateEnvironment(state, mechanism.id);
      }
    }
    if (mechanism.kind === 'fallingFloor' || mechanism.kind === 'trapFloor')
      tickFloor(state, mechanism, dt);
    else if (['movingFloor', 'reactiveFloor', 'movingObstacle', 'door'].includes(mechanism.kind)) {
      tickMotion(mechanism, random, dt, state.time);
      const delta = sub(mechanism.position, mechanism.previous);
      const angle = (mechanism.angle ?? 0) - mechanism.previousAngle;
      mechanism.velocity = mul(delta, 1 / Math.max(dt, 1e-9));
      mechanism.angularVelocity = angle / Math.max(dt, 1e-9);
      if (length(delta) > 1e-8 || Math.abs(angle) > 1e-8) {
        moving = true;
        if (mechanism.kind === 'movingObstacle') {
          // Small steps also catch a fast, thin wall crossing a body between fixed ticks.
          const endPosition = { ...mechanism.position },
            endAngle = mechanism.angle ?? 0;
          const reach = state.arena.obstacles
            .filter((obstacle) => mechanism.obstacleIds?.includes(obstacle.id))
            .reduce(
              (max, obstacle) =>
                Math.max(
                  max,
                  distance(obstacle.position, mechanism.previous!) + length(obstacle.half),
                ),
              0,
            );
          const steps = Math.max(
            1,
            Math.ceil((length(delta) + Math.abs(angle) * reach) / (RULES.discRadius * 0.75)),
          );
          let previous = { ...mechanism.previous },
            previousAngle = mechanism.previousAngle;
          for (let step = 1; step <= steps; step++) {
            mechanism.position = lerpV(mechanism.previous, endPosition, step / steps);
            mechanism.angle = lerp(mechanism.previousAngle, endAngle, step / steps);
            applyPose(state, mechanism, previous, previousAngle);
            pushObstacles(state, mechanism);
            previous = { ...mechanism.position };
            previousAngle = mechanism.angle;
          }
        } else applyPose(state, mechanism, mechanism.previous, mechanism.previousAngle);
      }
      if (mechanism.kind === 'door') {
        const disabled = (mechanism.height ?? 0) <= (mechanism.solidHeight ?? -0.1);
        for (const obstacle of state.arena.obstacles)
          if (mechanism.obstacleIds?.includes(obstacle.id) && obstacle.disabled !== disabled) {
            obstacle.disabled = disabled;
            changed(state, mechanism);
          }
        if (!disabled && mechanism.phase === 'moving') pushObstacles(state, mechanism);
      }
    }
  }
  env.navigationTimer = (env.navigationTimer ?? 0) + dt;
  if (moving && env.navigationTimer >= 0.15) {
    env.navigationTimer = 0;
    state.arena.revision = (state.arena.revision ?? 0) + 1;
  }
}

function cutPlant(state: GameState, mechanism: EnvironmentMechanism): void {
  if (mechanism.phase === 'cut') return;
  mechanism.phase = 'cut';
  mechanism.active = false;
  mechanism.disturbance = 0;
  changed(state, mechanism);
}

/** Original trigger overlap plus nine-point ordinary-ground support test. */
export function tickEnvironmentContacts(state: GameState, dt: number): void {
  const trapFloorIds = new Set(
    mechanisms(state)
      .filter((m) => m.kind === 'trapFloor')
      .flatMap((m) => m.floorIds ?? []),
  );
  const solidFloors = (state.arena.floors ?? []).filter((floor) => !trapFloorIds.has(floor.id));
  const supported = (position: Vec2): boolean => {
    if (solidFloors.some((floor) => floorContains(floor, position))) return true;
    const radius = RULES.playerRadius * 0.95;
    for (let i = 0; i < 8; i++) {
      const angle = -Math.PI / 2 + (i * Math.PI) / 4;
      const point = add(
        position,
        v(Math.cos(angle) * radius, Math.sin(angle) * radius * (i === 0 ? 1.25 : 1)),
      );
      if (solidFloors.some((floor) => floorContains(floor, point))) return true;
    }
    return false;
  };
  for (const mechanism of mechanisms(state)) {
    if (mechanism.active === false) continue;
    if (mechanism.kind === 'trapFloor' && (mechanism.phase ?? 'idle') === 'idle') {
      const floors = surfaceFloors(state, mechanism);
      for (const actor of state.actors)
        if (
          actor.alive &&
          !actor.fall &&
          actor.dashTime <= 0 &&
          floors.some((floor) => floor.active && touches(floor, actor.position, RULES.playerRadius))
        ) {
          if (!supported(actor.position)) {
            activateEnvironment(state, mechanism.id, actor.id);
            break;
          }
        }
    } else if (mechanism.kind === 'destroyer') {
      for (const obstacle of state.arena.obstacles)
        if (
          obstacle.kind === 'crate' &&
          !obstacle.broken &&
          touches(mechanism, obstacle.position, Math.min(obstacle.half.x, obstacle.half.y))
        )
          damageEnvironmentObstacle(state, obstacle, mechanism.ownerId ?? -1);
      state.pickups = state.pickups.filter((pickup) => !touches(mechanism, pickup.position, 0.22));
      for (const decoy of state.decoys)
        if (decoy.alive && touches(mechanism, decoy.position, RULES.playerRadius))
          decoy.alive = false;
    } else if (mechanism.kind === 'plant') {
      const zone = state.zones.find((candidate) =>
        touches(mechanism, candidate.position, candidate.radius),
      );
      if (zone?.kind === 'ice') cutPlant(state, mechanism);
      else if (zone?.kind === 'fire' || (mechanism.burnTime ?? 0) > 0) {
        mechanism.burnHealth = (mechanism.burnHealth ?? 0.4) - dt;
        mechanism.burnTime = decrement(mechanism.burnTime, dt);
        if (mechanism.burnHealth <= 0) {
          addZone(
            state,
            'fire',
            mechanism.position,
            zone?.ownerId ?? mechanism.ownerId ?? -1,
            0.42,
            1.375,
          );
          cutPlant(state, mechanism);
        }
      }
      for (const actor of state.actors)
        if (actor.alive && touches(mechanism, actor.position, RULES.playerRadius)) {
          mechanism.disturbance = Math.min(1, length(actor.velocity) / 6);
          mechanism.disturbedDirection = normalize(sub(mechanism.position, actor.position));
        }
    } else if (mechanism.kind === 'trap') {
      const touching = state.actors.filter(
        (actor) => actor.alive && touches(mechanism, actor.position, RULES.playerRadius),
      );
      if ((mechanism.phase ?? 'idle') === 'idle' && touching.length) {
        mechanism.phase = 'charging';
        mechanism.elapsed = 0;
        changed(state, mechanism);
      }
      if (mechanism.phase !== 'idle') mechanism.elapsed = (mechanism.elapsed ?? 0) + dt;
      if (mechanism.phase === 'charging' && mechanism.elapsed! >= 0.75) {
        mechanism.phase = 'attacking';
        mechanism.elapsed = 0;
        changed(state, mechanism);
      } else if (mechanism.phase === 'attacking') {
        for (const actor of touching)
          if (actor.dashTime <= 0)
            damageActor(state, actor, mechanism.ownerId ?? actor.id, v(), 'fall');
        if (mechanism.elapsed! >= 0.25) {
          mechanism.phase = 'cooldown';
          mechanism.elapsed = 0;
          changed(state, mechanism);
        }
      } else if (mechanism.phase === 'cooldown' && mechanism.elapsed! >= 0.5) {
        mechanism.phase = 'idle';
        mechanism.elapsed = 0;
      }
    }
  }
}

function freshMelee(mechanism: EnvironmentMechanism, actorId: number, serial?: number): boolean {
  if (serial === undefined) return true;
  const key = String(actorId);
  mechanism.lastMeleeSerials ??= {};
  if (mechanism.lastMeleeSerials[key] === serial) return false;
  mechanism.lastMeleeSerials[key] = serial;
  return true;
}

function switchVisible(state: GameState, mechanism: EnvironmentMechanism, contact: Vec2): boolean {
  // Switch.OnTriggerEnter casts OUT from its pivot. The shipped Physics2DSettings
  // set queriesStartInColliders=false, so a lever mounted in a backing wall works.
  const obstacles = state.arena.obstacles.filter(
    (obstacle) =>
      (obstacle.sourceLayer !== undefined
        ? obstacle.sourceLayer === 8
        : obstacle.kind !== 'crate') && !obstacleOverlaps(obstacle, mechanism.position, 0),
  );
  return !traceObstacles(
    { ...state.arena, obstacles },
    mechanism.position,
    sub(contact, mechanism.position),
  );
}

export function damageEnvironmentObstacle(
  state: GameState,
  obstacle: Obstacle,
  actorId: number,
  serial?: number,
): boolean {
  const mechanism = mechanisms(state).find(
    (candidate) =>
      candidate.kind === 'destructible' &&
      (candidate.id === obstacle.mechanismId || candidate.obstacleIds?.includes(obstacle.id)),
  );
  if (!mechanism) return false;
  if (mechanism.active === false || !freshMelee(mechanism, actorId, serial)) return true;
  mechanism.hitsLeft = (mechanism.hitsLeft ?? 1) - 1;
  mechanism.disturbance = 1;
  if (mechanism.hitsLeft <= 0) {
    mechanism.active = false;
    mechanism.ownerId = actorId;
    for (const member of state.arena.obstacles)
      if (member.mechanismId === mechanism.id || mechanism.obstacleIds?.includes(member.id))
        member.broken = true;
    state.events.push({ type: 'crate', position: { ...mechanism.position }, actorId });
    state.arena.revision = (state.arena.revision ?? 0) + 1;
  }
  return true;
}

export function strikeEnvironment(state: GameState, strike: EnvironmentStrike): void {
  for (const mechanism of mechanisms(state)) {
    if (mechanism.active === false || !['switch', 'plant', 'animated'].includes(mechanism.kind))
      continue;
    const origin = strike.from ?? strike.position;
    const intersects =
      strike.kind === 'disc'
        ? mechanism.paths?.length
          ? !!sweepPaths(
              localPoint(origin, mechanism),
              rotate(sub(strike.position, origin), -(mechanism.angle ?? 0)),
              strike.radius,
              mechanism.paths,
            )
          : !!segmentCircle(
              origin,
              sub(strike.position, origin),
              mechanism.position,
              (mechanism.radius ?? 0.45) + strike.radius,
            )
        : touches(mechanism, strike.position, strike.radius);
    if (!intersects) continue;
    if (strike.kind === 'melee') {
      if (
        dot(normalize(strike.direction), normalize(sub(mechanism.position, strike.position))) <
        Math.cos(RULES.attackArc / 2)
      )
        continue;
      if (mechanism.kind === 'switch') {
        if (!switchVisible(state, mechanism, strike.position)) continue;
      } else {
        const hit = traceObstacles(
          state.arena,
          strike.position,
          sub(mechanism.position, strike.position),
        );
        if (hit?.obstacle && !mechanism.obstacleIds?.includes(hit.obstacle.id)) continue;
      }
      if (!freshMelee(mechanism, strike.actorId, strike.serial)) continue;
    } else if (
      strike.kind === 'explosion' &&
      !lineOfSight(state.arena, strike.position, mechanism.position)
    )
      continue;
    if (mechanism.kind === 'switch') {
      if (strike.kind === 'explosion') continue;
      if (strike.kind === 'disc') {
        if (!switchVisible(state, mechanism, strike.position)) continue;
        // Unity +Y maps to Web -Y, before the exported transform rotation.
        const up = rotate(v(0, -1), mechanism.angle ?? 0);
        const actor = state.actors.find((candidate) => candidate.id === strike.actorId);
        if (
          dot(normalize(strike.direction), up) >= 0.1 &&
          (!actor || distance(strike.position, actor.position) >= RULES.discRadius * 3)
        )
          continue;
      }
      activateEnvironment(state, mechanism.id, strike.actorId);
    } else if (mechanism.kind === 'plant' && strike.kind === 'explosion') {
      if (strike.fire) {
        mechanism.burnTime = (mechanism.burnTime ?? 0) + 2.66;
        mechanism.ownerId = strike.actorId;
      } else cutPlant(state, mechanism);
    } else {
      mechanism.disturbance = strike.kind === 'melee' ? 1.333 : 1;
      mechanism.disturbedDirection = normalize(strike.direction);
    }
  }
}
