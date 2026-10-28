import { add, clamp, dot, length, mul, normalize, rotate, sub, v } from './math';
import {
  closestOnSegment,
  inPaths,
  localPoint,
  obstacleOverlaps,
  obstaclePaths,
  pathBounds,
  supportedAt,
} from './geometry';
import type { Vec2 } from './math';
import type { Arena, Obstacle } from './types';

export interface Hit {
  t: number;
  normal: Vec2;
  obstacle?: Obstacle;
}

/** Earliest intersection of a segment with a circle; t is in [0, 1]. */
export function segmentCircle(start: Vec2, delta: Vec2, center: Vec2, radius: number): Hit | null {
  const relative = sub(start, center);
  const c = dot(relative, relative) - radius * radius;
  if (c < -0.00001) return { t: 0, normal: normalize(relative) };
  const a = dot(delta, delta);
  if (a < 1e-12) return null;
  const b = dot(relative, delta);
  if (b >= 0) return null;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / a;
  return t >= 0 && t <= 1 ? { t, normal: normalize(sub(add(start, mul(delta, t)), center)) } : null;
}

export function pointInBox(point: Vec2, center: Vec2, half: Vec2, padding = 0): boolean {
  return (
    Math.abs(point.x - center.x) < half.x + padding &&
    Math.abs(point.y - center.y) < half.y + padding
  );
}

/** Swept circle against a rounded rectangle (faces plus corner circles). */
export function sweepBox(
  start: Vec2,
  delta: Vec2,
  radius: number,
  center: Vec2,
  half: Vec2,
): Hit | null {
  const min = sub(center, half),
    max = add(center, half);
  if (
    Math.max(start.x, start.x + delta.x) + radius < min.x ||
    Math.min(start.x, start.x + delta.x) - radius > max.x ||
    Math.max(start.y, start.y + delta.y) + radius < min.y ||
    Math.min(start.y, start.y + delta.y) - radius > max.y
  )
    return null;
  const closest = v(clamp(start.x, min.x, max.x), clamp(start.y, min.y, max.y));
  const separation = sub(start, closest);
  if (length(separation) < radius - 0.0001 || pointInBox(start, center, half)) {
    let normal = normalize(separation);
    if (length(normal) < 0.01) {
      const dx = half.x - Math.abs(start.x - center.x),
        dy = half.y - Math.abs(start.y - center.y);
      normal =
        dx < dy
          ? v(Math.sign(start.x - center.x) || 1, 0)
          : v(0, Math.sign(start.y - center.y) || 1);
    }
    return { t: 0, normal };
  }
  const candidates: Hit[] = [];
  if (Math.abs(delta.x) > 1e-9) {
    for (const side of [-1, 1]) {
      if (delta.x * side >= 0) continue;
      const x = center.x + side * (half.x + radius);
      const t = (x - start.x) / delta.x;
      const y = start.y + t * delta.y;
      if (t >= 0 && t <= 1 && y >= min.y && y <= max.y) candidates.push({ t, normal: v(side, 0) });
    }
  }
  if (Math.abs(delta.y) > 1e-9) {
    for (const side of [-1, 1]) {
      if (delta.y * side >= 0) continue;
      const y = center.y + side * (half.y + radius);
      const t = (y - start.y) / delta.y;
      const x = start.x + t * delta.x;
      if (t >= 0 && t <= 1 && x >= min.x && x <= max.x) candidates.push({ t, normal: v(0, side) });
    }
  }
  for (const x of [min.x, max.x])
    for (const y of [min.y, max.y]) {
      const hit = segmentCircle(start, delta, v(x, y), radius);
      if (hit) candidates.push(hit);
    }
  return candidates.sort((a, b) => a.t - b.t)[0] ?? null;
}

export function traceObstacles(arena: Arena, start: Vec2, delta: Vec2, radius = 0): Hit | null {
  let closest: Hit | null = null;
  for (const obstacle of arena.obstacles) {
    if (obstacle.broken || obstacle.disabled) continue;
    const localStart = localPoint(start, obstacle);
    const localDelta = rotate(delta, -(obstacle.angle ?? 0));
    const hit =
      obstacle.radius !== undefined
        ? segmentCircle(localStart, localDelta, v(), radius + obstacle.radius)
        : obstacle.paths
          ? sweepPaths(localStart, localDelta, radius, obstacle.paths)
          : sweepBox(localStart, localDelta, radius, v(), obstacle.half);
    if (hit) hit.normal = rotate(hit.normal, obstacle.angle ?? 0);
    if (hit && (!closest || hit.t < closest.t)) closest = { ...hit, obstacle };
  }
  return closest;
}

export function lineOfSight(arena: Arena, from: Vec2, to: Vec2): boolean {
  return !traceObstacles(arena, from, sub(to, from));
}

export function moveAndSlide(arena: Arena, start: Vec2, delta: Vec2, radius: number): Vec2 {
  let position = arena.floors ? depenetrate(arena, start, radius) : { ...start },
    remaining = { ...delta };
  for (let i = 0; i < 4 && length(remaining) > 1e-6; i++) {
    const hit = traceObstacles(arena, position, remaining, radius);
    if (!hit) return add(position, remaining);
    position = add(
      add(position, mul(remaining, Math.max(0, hit.t - 0.001))),
      mul(hit.normal, 0.001),
    );
    remaining = mul(remaining, 1 - hit.t);
    const inward = dot(remaining, hit.normal);
    if (inward < 0) remaining = sub(remaining, mul(hit.normal, inward));
  }
  return position;
}

/** Resolve initial body overlaps as Actor.MoveActor does; scene spawn markers stay unmodified. */
export function depenetrate(arena: Arena, start: Vec2, radius: number): Vec2 {
  let position = { ...start };
  for (let iteration = 0; iteration < 8; iteration++) {
    const obstacle = arena.obstacles.find(
      (o) => !o.broken && !o.disabled && obstacleOverlaps(o, position, radius - 1e-5),
    );
    if (!obstacle) break;
    const p = localPoint(position, obstacle);
    let target: Vec2;
    if (obstacle.radius !== undefined) {
      target = mul(length(p) > 1e-7 ? normalize(p) : v(1, 0), obstacle.radius + radius + 0.001);
    } else {
      const paths = obstaclePaths(obstacle),
        inside = inPaths(p, paths);
      let closest = v(),
        normal = v(1, 0),
        nearest = Infinity;
      for (const path of paths)
        for (let i = 0; i < path.length; i++) {
          const a = path[i],
            b = path[(i + 1) % path.length];
          const q = closestOnSegment(p, a, b),
            offset = sub(p, q),
            d = length(offset);
          if (d < nearest) {
            nearest = d;
            closest = q;
            normal =
              d > 1e-8 ? mul(offset, (inside ? -1 : 1) / d) : normalize(v(a.y - b.y, b.x - a.x));
            if (inPaths(add(q, mul(normal, 0.0001)), paths)) normal = mul(normal, -1);
          }
        }
      target = add(closest, mul(normal, radius + 0.001));
    }
    position = add(obstacle.position, rotate(target, obstacle.angle ?? 0));
  }
  return position;
}

export function onGround(arena: Arena, position: Vec2, margin = 0): boolean {
  if (arena.floors) {
    const covered = (p: Vec2) => supportedAt(arena, p);
    if (!covered(position)) return false;
    // Test the union, so seams between touching tiles never become phantom gaps.
    if (margin > 0)
      for (let i = 0; i < 16; i++) {
        const angle = (i * Math.PI) / 8;
        if (
          !covered(v(position.x + Math.cos(angle) * margin, position.y + Math.sin(angle) * margin))
        )
          return false;
      }
    return true;
  }
  return (
    Math.abs(position.x) <= arena.halfWidth - margin &&
    Math.abs(position.y) <= arena.halfHeight - margin &&
    !arena.pits.some((pit) => pointInBox(position, pit.position, pit.half, margin))
  );
}

export function safePosition(arena: Arena, position: Vec2, radius: number): boolean {
  return (
    onGround(arena, position, radius) &&
    !arena.obstacles.some((o) => !o.broken && !o.disabled && obstacleOverlaps(o, position, radius))
  );
}

/** Swept disk against arbitrary polygon edges and their round vertex caps. */
export function sweepPaths(start: Vec2, delta: Vec2, radius: number, paths: Vec2[][]): Hit | null {
  const { min, max } = pathBounds(paths),
    end = add(start, delta);
  if (
    Math.max(start.x, end.x) + radius < min.x ||
    Math.min(start.x, end.x) - radius > max.x ||
    Math.max(start.y, end.y) + radius < min.y ||
    Math.min(start.y, end.y) - radius > max.y
  )
    return null;
  let closest: Hit | null = null;
  let nearest = Infinity;
  let nearestNormal = v(1, 0);
  const inside = inPaths(start, paths);
  const consider = (hit: Hit | null): void => {
    if (hit && (!closest || hit.t < closest.t)) closest = hit;
  };
  for (const path of paths)
    for (let i = 0; i < path.length; i++) {
      const a = path[i],
        b = path[(i + 1) % path.length];
      const edge = sub(b, a),
        size = length(edge);
      if (size < 1e-9) continue;
      const tangent = mul(edge, 1 / size),
        normal = v(-tangent.y, tangent.x);
      const separation = sub(start, closestOnSegment(start, a, b));
      const dist = length(separation);
      if (dist < nearest) {
        nearest = dist;
        nearestNormal = dist > 1e-7 ? mul(normalize(separation), inside ? -1 : 1) : normal;
      }
      for (const side of [-1, 1]) {
        const n = mul(normal, side),
          speed = dot(delta, n);
        if (speed >= -1e-10) continue;
        const t = (radius - dot(sub(start, a), n)) / speed;
        if (t < 0 || t > 1) continue;
        const along = dot(sub(add(start, mul(delta, t)), a), tangent);
        if (along >= 0 && along <= size) consider({ t, normal: n });
      }
      if (radius > 0) consider(segmentCircle(start, delta, a, radius));
    }
  if (inside || nearest < radius - 1e-5) return { t: 0, normal: nearestNormal };
  return closest;
}
