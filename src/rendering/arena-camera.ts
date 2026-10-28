import type { Arena } from '../core/types';
import type { Vec2 } from '../core/math';

export interface ArenaCameraFrame {
  center: Vec2;
  half: Vec2;
  height: number;
}

/** Camera3D.cameraAngle = (0, -0.4, -0.7), mapped from Unity XY/-Z to Web XZ/Y. */
export const ORIGINAL_CAMERA_UP = 0.7;
export const ORIGINAL_CAMERA_BACK = 0.4;

/** Fit the supplied topology once, not decorative oceans or legacy fixed props. */
export function arenaCameraFrame(arena: Arena): ArenaCameraFrame {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let height = 2.8;
  const point = (p: Vec2): void => {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  };
  for (const floor of arena.boundary ? [] : (arena.floors ?? [])) {
    const cos = Math.cos(floor.angle ?? 0),
      sin = Math.sin(floor.angle ?? 0);
    for (const path of floor.paths)
      for (const p of path)
        point({
          x: floor.position.x + p.x * cos - p.y * sin,
          y: floor.position.y + p.x * sin + p.y * cos,
        });
  }
  // The source boundary encloses moving-platform travel even when its initial
  // floor footprint is smaller. Rotated rectangles contribute all four corners.
  if (arena.boundary) {
    const { center, half, angle = 0 } = arena.boundary;
    for (const x of [-half.x, half.x])
      for (const y of [-half.y, half.y])
        point({
          x: center.x + x * Math.cos(angle) - y * Math.sin(angle),
          y: center.y + x * Math.sin(angle) + y * Math.cos(angle),
        });
  }
  if (!Number.isFinite(minX)) {
    minX = -arena.halfWidth;
    maxX = arena.halfWidth;
    minY = -arena.halfHeight;
    maxY = arena.halfHeight;
  }
  for (const obstacle of arena.obstacles) {
    const boundary = arena.boundary;
    const dx = obstacle.position.x - (boundary?.center.x ?? 0),
      dy = obstacle.position.y - (boundary?.center.y ?? 0),
      turn = -(boundary?.angle ?? 0);
    const insideBoundary =
      !boundary ||
      (Math.abs(dx * Math.cos(turn) - dy * Math.sin(turn)) <= boundary.half.x &&
        Math.abs(dx * Math.sin(turn) + dy * Math.cos(turn)) <= boundary.half.y);
    if (
      insideBoundary &&
      obstacle.position.x >= minX &&
      obstacle.position.x <= maxX &&
      obstacle.position.y >= minY &&
      obstacle.position.y <= maxY
    )
      height = Math.max(height, (obstacle.baseHeight ?? 0) + (obstacle.height ?? 0));
  }
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    half: { x: (maxX - minX) / 2 + 0.8, y: (maxY - minY) / 2 + 0.8 },
    height,
  };
}

/** Fixed camera pitch; exact perspective corner constraints at ground and head
 * height avoid clipping wide or portrait layouts. Return distance to target. */
export function arenaCameraDistance(frame: ArenaCameraFrame, aspect: number, fov = 31): number {
  const norm = Math.hypot(ORIGINAL_CAMERA_UP, ORIGINAL_CAMERA_BACK),
    up = ORIGINAL_CAMERA_UP / norm,
    back = ORIGINAL_CAMERA_BACK / norm;
  const tangent = Math.tan((fov * Math.PI) / 360);
  let distance = 1;
  for (const x of [-frame.half.x, frame.half.x])
    for (const z of [-frame.half.y, frame.half.y]) {
      for (const y of [0, frame.height]) {
        const depth = z * back + y * up;
        const screenY = y * back - z * up;
        distance = Math.max(
          distance,
          Math.abs(x) / (tangent * Math.max(0.1, aspect)) + depth,
          Math.abs(screenY) / tangent + depth,
        );
      }
    }
  return distance * 1.06;
}
