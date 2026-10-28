import { describe, expect, it } from 'vitest';
import { createArena } from '../src/core/arena';
import { lineOfSight, moveAndSlide, segmentCircle, sweepBox } from '../src/core/collision';
import { v } from '../src/core/math';

describe('continuous collision', () => {
  it('finds a small target even when a projectile crosses it in one tick', () => {
    const hit = segmentCircle(v(-10, 0), v(20, 0), v(), 0.7);
    expect(hit?.t).toBeCloseTo(0.465);
    expect(segmentCircle(v(-10, 2), v(20, 0), v(), 0.7)).toBeNull();
  });
  it('stops on a face and resolves rounded corners rather than inflated square corners', () => {
    expect(sweepBox(v(-5, 0), v(10, 0), 0.5, v(), v(1, 1))?.t).toBeCloseTo(0.35);
    const hit = sweepBox(v(-3, 1.4), v(6, 0), 0.5, v(), v(1, 1));
    expect(hit?.t).toBeCloseTo(1.7 / 6);
    expect(hit!.normal.y).toBeGreaterThan(0.7);
  });
  it('slides along a wall and never tunnels through it at high displacement', () => {
    const arena = createArena();
    arena.obstacles = [
      { id: 'test', kind: 'stone', position: v(), half: v(0.5, 8), broken: false },
    ];
    const result = moveAndSlide(arena, v(-3, 0), v(8, 3), 0.5);
    expect(result.x).toBeLessThanOrEqual(-1);
    expect(result.y).toBeGreaterThan(2.8);
    expect(lineOfSight(arena, v(-3, 0), v(3, 0))).toBe(false);
    arena.obstacles[0].broken = true;
    expect(lineOfSight(arena, v(-3, 0), v(3, 0))).toBe(true);
  });
});
