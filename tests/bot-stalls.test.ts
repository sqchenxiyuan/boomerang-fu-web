import { describe, expect, it } from 'vitest';
import { createArena } from '../src/core/arena';
import { onGround, safePosition } from '../src/core/collision';
import { RULES } from '../src/core/config';
import { botAudit } from '../src/devtools/map-audit';
import { clearPathSegment, findPath } from '../src/simulation/navigation';

/*
 * Layouts that used to freeze two hard bots for minutes (found by npm run audit:maps):
 * a recall pinned behind a wall, a switch wall the cached graph did not see move,
 * and a bot on a shore whose half-over-water body connected to no route.
 */
describe('bot stalls', () => {
  it('a bot whose recalled boomerang is pinned behind a wall walks to it (Jungle Ruins)', () => {
    const result = botAudit('original-jungle-ruins', 4, 7);
    expect(result.rounds).toBe(4);
    expect(result.stuckSeconds).toBeLessThan(3);
  });

  it('bots route around a switch wall that has slid into place (Maze 2)', () => {
    const result = botAudit('original-maze2', 4, 7);
    expect(result.rounds).toBe(4);
    expect(result.meanSeconds).toBeLessThan(30);
  });

  it('the navigation graph follows moving walls', () => {
    const arena = createArena('original-maze2');
    const wall = arena.obstacles.find((o) => o.sourceName === 'MovingObstacle' && o.id === 'c-925');
    expect(wall).toBeDefined();
    const start = { x: -8, y: 1 },
      goal = { x: -6.5, y: 1 };
    findPath(arena, start, goal); // warm the cache with the wall where it starts
    wall!.position = { x: -7.2, y: 1.4 };
    const path = findPath(arena, start, goal);
    expect(path.length).toBeGreaterThan(0);
    [start, ...path].forEach((point, i, all) => {
      if (i) expect(clearPathSegment(arena, all[i - 1], point, 0.05)).toBe(true);
    });
  });

  it('a bot standing on a shore still finds a route', () => {
    const arena = createArena('original-courtyard');
    const shore = { x: -7.466645051635371, y: 2.717585825256639 };
    expect(onGround(arena, shore)).toBe(true);
    expect(safePosition(arena, shore, RULES.playerRadius)).toBe(false);
    expect(findPath(arena, shore, arena.spawns[0]).length).toBeGreaterThan(0);
  });
});
