import { describe, expect, it } from 'vitest';
import { onGround, safePosition, sweepPaths, traceObstacles } from '../src/core/collision';
import { v } from '../src/core/math';
import type { Arena } from '../src/core/types';
import { floorContains, obstacleOverlaps, shapeContains } from '../src/core/geometry';
import { portalDestination, tracePortal } from '../src/simulation/portals';
import { clearPathSegment, findFloorEscape, findPath } from '../src/simulation/navigation';
import { createArena } from '../src/core/arena';

const square = (half: number) => [v(-half, -half), v(half, -half), v(half, half), v(-half, half)];
const arena = (): Arena => ({
  halfWidth: 20,
  halfHeight: 20,
  obstacles: [],
  pits: [],
  spawns: [],
  pickupSpawns: [],
});

describe('recovered scene geometry', () => {
  it('keeps navigation support correct after circle rotation, translation and collapse', () => {
    const map = arena();
    map.halfWidth = map.halfHeight = 7;
    map.floors = [
      {
        id: 'raft',
        position: v(),
        paths: [square(4)],
        radius: 4,
        active: true,
        kind: 'moving',
        mechanismId: 'moving',
      },
    ];
    map.environment = {
      mechanisms: [
        {
          id: 'moving',
          kind: 'movingFloor',
          position: v(),
          active: true,
        },
      ],
    };
    map.obstacles = [
      {
        id: 'wall',
        position: v(),
        half: v(0.3, 1),
        height: 1,
        kind: 'stone',
        broken: false,
      },
    ];
    const start = v(-2, 0),
      goal = v(2, 0);
    const initial = findPath(map, start, goal);
    expect(initial.length).toBeGreaterThan(0);
    map.floors[0].angle = 1.2;
    map.revision = 1;
    expect(findPath(map, start, goal)).toEqual(initial);
    map.floors[0].position = v(9, 0);
    map.revision = 2;
    expect(findPath(map, start, goal)).toEqual([]);
    map.floors[0].position = v();
    map.revision = 3;
    expect(findPath(map, start, goal)).toEqual(initial);
    map.floors[0].active = false;
    map.revision = 4;
    expect(findPath(map, start, goal)).toEqual([]);
  });

  it('does not cross a warning floor between two safe navigation nodes', () => {
    const map = createArena('original-falling');
    map.floors!.find((floor) => floor.id === 'f-1089')!.warning = 0.9;
    const start = v(6, 4),
      goal = v(7, 4);
    expect(clearPathSegment(map, start, goal)).toBe(false);
    const path = findPath(map, start, goal);
    let previous = start;
    for (const waypoint of path) {
      expect(clearPathSegment(map, previous, waypoint)).toBe(true);
      previous = waypoint;
    }
  });
  it('allows escape from a warning tile while preventing a new route onto it', () => {
    const map = arena();
    map.floors = [
      {
        id: 'trap',
        position: v(),
        paths: [square(2)],
        active: true,
        kind: 'falling',
        warning: 0.1,
      },
      { id: 'safe', position: v(4, 0), paths: [square(2)], active: true, kind: 'ground' },
    ];
    expect(clearPathSegment(map, v(), v(3, 0), 0.47)).toBe(true);
    expect(clearPathSegment(map, v(3, 0), v(), 0.47)).toBe(false);
    expect(findFloorEscape(map, v(), v(1, 0))!.x).toBeGreaterThan(2.7);
  });

  it('keeps moving platforms and trap reactivation live in the floor index', () => {
    const map = arena();
    map.floors = [
      { id: 'tile', position: v(), paths: [square(1)], active: true, kind: 'falling' },
      {
        id: 'raft',
        position: v(4, 0),
        paths: [square(1)],
        active: true,
        kind: 'moving',
        mechanismId: 'raft-motion',
      },
    ];
    map.environment = {
      mechanisms: [
        { id: 'raft-motion', kind: 'movingFloor', position: v(4, 0), floorIds: ['raft'] },
      ],
    };
    expect(onGround(map, v())).toBe(true);
    expect(onGround(map, v(4, 0))).toBe(true);
    map.floors[0].active = false;
    map.floors[1].position.x = 12;
    expect(onGround(map, v())).toBe(false);
    expect(onGround(map, v(4, 0))).toBe(false);
    expect(onGround(map, v(12, 0))).toBe(true);
    map.floors[0].active = true;
    expect(onGround(map, v())).toBe(true);
  });
  it('uses exact circles beyond the visual polygon and recognizes zero-radius points inside walls', () => {
    const circle = {
      id: 'round',
      position: v(3, 2),
      radius: 2,
      paths: [square(1)],
      active: true,
      kind: 'ground' as const,
    };
    expect(floorContains(circle, v(4.9, 2))).toBe(true);
    expect(shapeContains(circle, v(5.01, 2))).toBe(false);
    expect(floorContains({ ...circle, active: false }, v(3, 2))).toBe(false);
    const wall = {
      id: 'wall',
      position: v(),
      half: v(1, 1),
      paths: [square(1)],
      broken: false,
      kind: 'stone' as const,
    };
    expect(obstacleOverlaps(wall, v(), 0)).toBe(true);
    expect(obstacleOverlaps(wall, v(2, 0), 0)).toBe(false);
  });
  it('preserves islands, holes and shared seams instead of filling the level bounds', () => {
    const map = arena();
    map.floors = [
      { id: 'ring', position: v(), paths: [square(4), square(1)], kind: 'ground', active: true },
      { id: 'raft', position: v(5, 0), paths: [square(1)], kind: 'moving', active: true },
    ];
    expect(onGround(map, v())).toBe(false);
    expect(onGround(map, v(2, 0), 0.4)).toBe(true);
    expect(onGround(map, v(4, 0), 0.4)).toBe(true);
    expect(onGround(map, v(6, 0), 0.4)).toBe(false);
    expect(onGround(map, v(8, 0))).toBe(false);
    map.floors[1].active = false;
    expect(onGround(map, v(5, 0))).toBe(false);
  });

  it('sweeps the real concave outline and bounces against rotated edges', () => {
    const shape = [v(-2, -2), v(2, -2), v(2, 0), v(0, 0), v(0, 2), v(-2, 2)];
    expect(sweepPaths(v(1, 1), v(2, 0), 0.1, [shape])).toBeNull();
    const hit = sweepPaths(v(1, 1), v(-2, 0), 0.1, [shape])!;
    expect(hit.t).toBeCloseTo(0.45);
    expect(hit.normal.x).toBeCloseTo(1);
    const map = arena();
    map.obstacles = [
      {
        id: 'diagonal',
        kind: 'stone',
        broken: false,
        position: v(),
        half: v(2, 0.2),
        angle: Math.PI / 4,
      },
    ];
    const diagonal = traceObstacles(map, v(-2, 1), v(4, 0), 0.1)!;
    expect(diagonal.normal.x).toBeCloseTo(-Math.SQRT1_2);
    expect(diagonal.normal.y).toBeCloseTo(Math.SQRT1_2);
    expect(safePosition(map, v(1.8, -1.8), 0.2)).toBe(true);
  });

  it('hits thin polygon walls at speed and preserves circular collision', () => {
    const map = arena();
    map.obstacles = [
      {
        id: 'wall',
        kind: 'stone',
        broken: false,
        position: v(),
        half: v(0.02, 2),
        paths: [[v(-0.02, -2), v(0.02, -2), v(0.02, 2), v(-0.02, 2)]],
      },
    ];
    expect(traceObstacles(map, v(-10, 0), v(20, 0), 0.2)!.t).toBeCloseTo(0.489);
    map.obstacles[0] = {
      id: 'column',
      kind: 'stone',
      broken: false,
      position: v(),
      half: v(1, 1),
      radius: 1,
    };
    expect(traceObstacles(map, v(-3, 0), v(6, 0), 0.5)!.t).toBeCloseTo(0.25);
    expect(traceObstacles(map, v(-3, 1.6), v(6, 0), 0.5)).toBeNull();
  });

  it('uses a rectangular gate trigger and the packaged exit thickness', () => {
    const map = arena();
    map.portals = [
      {
        id: 'a',
        exitId: 'b',
        position: v(-3, 0),
        direction: v(0, -1),
        radius: 1,
        half: v(1, 0.1),
        thickness: 0.1,
        color: '#fff',
      },
      {
        id: 'b',
        exitId: 'a',
        position: v(3, 0),
        direction: v(1, 0),
        angle: -Math.PI / 2,
        radius: 1,
        half: v(1, 0.1),
        thickness: 0.1,
        color: '#fff',
      },
    ];
    expect(tracePortal(map, v(-3, -2), v(0, 3), 0.2)!.t).toBeCloseTo(1.7 / 3);
    expect(tracePortal(map, v(-1.5, -2), v(0, 3), 0.2)).toBeNull();
    expect(portalDestination(map, map.portals[0], 0.47)).toEqual(v(3.57, 0));
  });
});
