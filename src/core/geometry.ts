import { add, clamp, dot, length, mul, rotate, sub, v } from './math';
import type { Vec2 } from './math';
import type { Arena, Floor, Obstacle } from './types';

const boundsCache = new WeakMap<Vec2[][], { min: Vec2; max: Vec2 }>();
export function pathBounds(paths: Vec2[][]): { min: Vec2; max: Vec2 } {
  const cached = boundsCache.get(paths);
  if (cached) return cached;
  const min = v(Infinity, Infinity),
    max = v(-Infinity, -Infinity);
  for (const path of paths)
    for (const p of path) {
      min.x = Math.min(min.x, p.x);
      min.y = Math.min(min.y, p.y);
      max.x = Math.max(max.x, p.x);
      max.y = Math.max(max.y, p.y);
    }
  const result = { min, max };
  boundsCache.set(paths, result);
  return result;
}

export function localPoint(point: Vec2, shape: { position: Vec2; angle?: number }): Vec2 {
  return rotate(sub(point, shape.position), -(shape.angle ?? 0));
}

export function closestOnSegment(point: Vec2, a: Vec2, b: Vec2): Vec2 {
  const edge = sub(b, a);
  return add(a, mul(edge, clamp(dot(sub(point, a), edge) / (dot(edge, edge) || 1), 0, 1)));
}

/** Even-odd contours preserve holes and disjoint islands without assuming convexity. */
export function inPaths(point: Vec2, paths: Vec2[][]): boolean {
  const { min, max } = pathBounds(paths);
  if (
    point.x < min.x - 1e-7 ||
    point.x > max.x + 1e-7 ||
    point.y < min.y - 1e-7 ||
    point.y > max.y + 1e-7
  )
    return false;
  let inside = false;
  for (const path of paths) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      const a = path[j],
        b = path[i];
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const px = point.x - a.x,
        py = point.y - a.y;
      const edgeLength2 = dx * dx + dy * dy;
      const along = px * dx + py * dy;
      const cross = px * dy - py * dx;
      if (
        edgeLength2 > 1e-16 &&
        along >= 0 &&
        along <= edgeLength2 &&
        cross * cross < 1e-14 * edgeLength2
      )
        return true;
      if (
        a.y > point.y !== b.y > point.y &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      )
        inside = !inside;
    }
  }
  return inside;
}

export function floorContains(floor: Floor, point: Vec2): boolean {
  if (!floor.active) return false;
  return shapeContains(floor, point);
}

export function shapeContains(
  shape: { position: Vec2; angle?: number; radius?: number; paths: Vec2[][] },
  point: Vec2,
): boolean {
  const floor = shape;
  if (floor.radius !== undefined) {
    const dx = point.x - floor.position.x,
      dy = point.y - floor.position.y;
    return dx * dx + dy * dy <= floor.radius * floor.radius + 1e-7;
  }
  const { min, max } = pathBounds(floor.paths);
  const x = point.x - floor.position.x,
    y = point.y - floor.position.y;
  if (!floor.angle) {
    if (x < min.x - 1e-7 || x > max.x + 1e-7 || y < min.y - 1e-7 || y > max.y + 1e-7) return false;
    return inPaths({ x, y }, floor.paths);
  }
  // Cheap conservative rejection before rotation, particularly for tiled arenas.
  const extent =
    Math.max(Math.abs(min.x), Math.abs(max.x)) + Math.max(Math.abs(min.y), Math.abs(max.y));
  if (Math.abs(x) > extent || Math.abs(y) > extent) return false;
  return inPaths(localPoint(point, floor), floor.paths);
}

const floorIndices = new WeakMap<
  Arena,
  { source: Floor[]; cells: Map<string, Floor[]>; moving: Floor[] }
>();
const FLOOR_CELL = 4;

/** Fixed XY tiles share a spatial index; moving parents are always queried live.
 * Active/warning flags remain on the original objects, so collapsing tiles do
 * not require a rebuild or a second copy of the physical state. */
export function supportedAt(arena: Arena, point: Vec2): boolean {
  const source = arena.floors ?? [];
  let index = floorIndices.get(arena);
  if (!index || index.source !== source) {
    const cells = new Map<string, Floor[]>(),
      moving: Floor[] = [];
    const mechanisms = new Map(arena.environment?.mechanisms.map((m) => [m.id, m]));
    for (const floor of source) {
      let mechanism = floor.mechanismId ? mechanisms.get(floor.mechanismId) : undefined;
      let moves = false;
      while (mechanism) {
        if (['movingFloor', 'reactiveFloor', 'movingObstacle'].includes(mechanism.kind))
          moves = true;
        mechanism = mechanism.parentId ? mechanisms.get(mechanism.parentId) : undefined;
      }
      if (moves) {
        moving.push(floor);
        continue;
      }
      const { min, max } =
        floor.radius === undefined
          ? pathBounds(floor.paths)
          : { min: v(-floor.radius, -floor.radius), max: v(floor.radius, floor.radius) };
      const corners = [v(min.x, min.y), v(max.x, min.y), v(min.x, max.y), v(max.x, max.y)].map(
        (p) => add(floor.position, rotate(p, floor.angle ?? 0)),
      );
      const left = Math.floor((Math.min(...corners.map((p) => p.x)) - 1e-6) / FLOOR_CELL);
      const right = Math.floor((Math.max(...corners.map((p) => p.x)) + 1e-6) / FLOOR_CELL);
      const top = Math.floor((Math.min(...corners.map((p) => p.y)) - 1e-6) / FLOOR_CELL);
      const bottom = Math.floor((Math.max(...corners.map((p) => p.y)) + 1e-6) / FLOOR_CELL);
      for (let x = left; x <= right; x++)
        for (let y = top; y <= bottom; y++) {
          const key = `${x},${y}`,
            bucket = cells.get(key) ?? [];
          bucket.push(floor);
          cells.set(key, bucket);
        }
    }
    index = { source, cells, moving };
    floorIndices.set(arena, index);
  }
  return (
    index.moving.some((floor) => floorContains(floor, point)) ||
    (index.cells
      .get(`${Math.floor(point.x / FLOOR_CELL)},${Math.floor(point.y / FLOOR_CELL)}`)
      ?.some((floor) => floorContains(floor, point)) ??
      false)
  );
}

export function obstaclePaths(obstacle: Obstacle): Vec2[][] {
  if (obstacle.paths) return obstacle.paths;
  const { x, y } = obstacle.half;
  return [[v(-x, -y), v(x, -y), v(x, y), v(-x, y)]];
}

export function obstacleDistance(obstacle: Obstacle, point: Vec2): number {
  const p = localPoint(point, obstacle);
  if (obstacle.radius !== undefined) return Math.max(0, length(p) - obstacle.radius);
  if (!obstacle.paths)
    return length(
      v(Math.max(0, Math.abs(p.x) - obstacle.half.x), Math.max(0, Math.abs(p.y) - obstacle.half.y)),
    );
  if (inPaths(p, obstacle.paths)) return 0;
  let result = Infinity;
  for (const path of obstacle.paths)
    for (let i = 0; i < path.length; i++)
      result = Math.min(
        result,
        length(sub(p, closestOnSegment(p, path[i], path[(i + 1) % path.length]))),
      );
  return result;
}

/** Broad phase avoids scanning far polygon contours for every navigation sample. */
export function obstacleOverlaps(obstacle: Obstacle, point: Vec2, radius: number): boolean {
  const p = localPoint(point, obstacle);
  if (obstacle.radius !== undefined) return p.x * p.x + p.y * p.y < (obstacle.radius + radius) ** 2;
  const bounds = obstacle.paths
    ? pathBounds(obstacle.paths)
    : { min: mul(obstacle.half, -1), max: obstacle.half };
  const dx = Math.max(bounds.min.x - p.x, 0, p.x - bounds.max.x);
  const dy = Math.max(bounds.min.y - p.y, 0, p.y - bounds.max.y);
  if (radius === 0) return dx === 0 && dy === 0 && (!obstacle.paths || inPaths(p, obstacle.paths));
  if (dx * dx + dy * dy >= radius * radius) return false;
  return !obstacle.paths || obstacleDistance(obstacle, point) < radius;
}
