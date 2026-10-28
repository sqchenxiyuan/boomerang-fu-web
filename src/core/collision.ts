import { add, clamp, distance, dot, length, mul, normalize, sub, v } from './math';
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
    if (obstacle.broken) continue;
    const hit = sweepBox(start, delta, radius, obstacle.position, obstacle.half);
    if (hit && (!closest || hit.t < closest.t)) closest = { ...hit, obstacle };
  }
  return closest;
}

export function lineOfSight(arena: Arena, from: Vec2, to: Vec2): boolean {
  return !traceObstacles(arena, from, sub(to, from));
}

export function moveAndSlide(arena: Arena, start: Vec2, delta: Vec2, radius: number): Vec2 {
  let position = { ...start },
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

export function onGround(arena: Arena, position: Vec2, margin = 0): boolean {
  return (
    Math.abs(position.x) <= arena.halfWidth - margin &&
    Math.abs(position.y) <= arena.halfHeight - margin &&
    !arena.pits.some((pit) => pointInBox(position, pit.position, pit.half, margin))
  );
}

export function safePosition(arena: Arena, position: Vec2, radius: number): boolean {
  return (
    onGround(arena, position, radius) &&
    !arena.obstacles.some(
      (o) =>
        !o.broken &&
        distance(
          position,
          v(
            clamp(position.x, o.position.x - o.half.x, o.position.x + o.half.x),
            clamp(position.y, o.position.y - o.half.y, o.position.y + o.half.y),
          ),
        ) < radius,
    )
  );
}
