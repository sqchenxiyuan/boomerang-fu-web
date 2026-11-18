import type { Vec2 } from './math';
import type { Arena, MapId } from './types';

/*
 * Small, reviewed layout fixes applied on top of the extracted map data
 * (original-map-data.json stays byte-identical to the extraction). Each entry
 * records where the point was, where it is now and why; `npm run audit:maps`
 * found the problems and tests/map-adjustments.test.ts keeps them fixed.
 *
 * Changing this list changes the simulation: bump SIMULATION_VERSION.
 */
export interface MapAdjustment {
  map: MapId;
  /** Original maps reuse spawn coordinates as pickup points; both are listed. */
  target: 'spawn' | 'pickup';
  index: number;
  from: Vec2;
  to: Vec2;
  reason: string;
}

const both = (map: MapId, index: number, from: Vec2, to: Vec2, reason: string): MapAdjustment[] => [
  { map, target: 'spawn', index, from, to, reason },
  { map, target: 'pickup', index, from, to, reason },
];

export const MAP_ADJUSTMENTS: readonly MapAdjustment[] = [
  ...both(
    'original-island',
    0,
    { x: -2.7555702, y: -11.1167216 },
    { x: -2.71, y: -11.1 },
    '紧贴南侧石柱，开局即贴墙',
  ),
  ...both(
    'original-island',
    1,
    { x: 9.8398061, y: -5.9861367 },
    { x: 9.82, y: -5.84 },
    '与东侧石柱碰撞体重叠，开局会被挤开',
  ),
  ...both(
    'original-island',
    3,
    { x: -9.2810884, y: 4.6372728 },
    { x: -9.03, y: 4.64 },
    '与西侧桦树重叠，开局会被挤开',
  ),
  ...both(
    'original-wheel',
    5,
    { x: -3.3909107, y: 8.8111381 },
    { x: -3.67, y: 8.6 },
    '与竹子重叠，开局会被挤开',
  ),
  ...both(
    'original-slide-traps',
    4,
    { x: 1.064, y: 2.424 },
    { x: 1.05, y: 2.38 },
    '紧贴滑墙，开局即贴墙',
  ),
];

export function adjustmentsFor(map: MapId): MapAdjustment[] {
  return MAP_ADJUSTMENTS.filter((adjustment) => adjustment.map === map);
}

/** Applies the reviewed fixes to a freshly created arena (mutates and returns it). */
export function applyMapAdjustments(arena: Arena, map: MapId): Arena {
  for (const adjustment of MAP_ADJUSTMENTS) {
    if (adjustment.map !== map) continue;
    const list = adjustment.target === 'spawn' ? arena.spawns : arena.pickupSpawns;
    const point = list[adjustment.index];
    if (!point)
      throw new RangeError(`${adjustment.map}: no ${adjustment.target} ${adjustment.index}`);
    point.x = adjustment.to.x;
    point.y = adjustment.to.y;
  }
  return arena;
}
