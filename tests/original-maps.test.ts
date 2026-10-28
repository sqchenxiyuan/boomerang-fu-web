import { describe, expect, it } from 'vitest';
import { createArena, MAPS, ORIGINAL_MAPS, selectRoundMap } from '../src/core/arena';
import { ORIGINAL_MAP_RECORDS } from '../src/core/original-maps';
import { onGround, safePosition } from '../src/core/collision';
import { RULES } from '../src/core/config';
import { obstacleDistance } from '../src/core/geometry';
import { v } from '../src/core/math';
import { createBoundary, isInBoundary, startShrinkingBoundary } from '../src/simulation/boundary';
import { createState, defaultOptions } from '../src/simulation/state';
import { Game } from '../src/simulation/game';
import { driveBotGame } from './bot-fixture';

describe('complete packaged map directory', () => {
  it('contains 57 distinct match maps and the separate tutorial; duplicate Toaster is not double counted', () => {
    expect(ORIGINAL_MAPS).toHaveLength(58);
    expect(ORIGINAL_MAPS.filter((m) => !m.tutorial)).toHaveLength(57);
    expect(ORIGINAL_MAPS.filter((m) => m.tutorial).map((m) => m.id)).toEqual(['original-tutorial']);
    expect(new Set(ORIGINAL_MAPS.map((m) => m.id)).size).toBe(58);
    expect(ORIGINAL_MAPS.filter((m) => m.id === 'original-toaster')).toHaveLength(1);
    expect(MAPS.filter((m) => m.source === 'custom')).toHaveLength(5);
    expect(new Set(ORIGINAL_MAP_RECORDS.map((m) => m.arena.sourceScene)).size).toBe(58);
    const visited = Array.from({ length: 57 }, (_, i) =>
      selectRoundMap('original-enclosed', 'cycle', i + 1),
    );
    expect(new Set(visited).size).toBe(57);
    expect(visited).not.toContain('original-tutorial');
    expect(selectRoundMap('original-enclosed', 'cycle', 58)).toBe('original-enclosed');
    expect(selectRoundMap('original-tutorial', 'cycle', 4)).toBe('original-tutorial');
  });

  it('retains independently extracted source measurements and rotated boundary behavior', () => {
    const enclosed = createArena('original-enclosed');
    expect(enclosed.boundary!.half).toEqual(v(8.6, 8.6));
    expect(enclosed.spawns).toHaveLength(6);
    expect(enclosed.spawns[0]).toEqual(v(-5.2, -5.2));
    const portal = createArena('original-teleportals');
    expect(portal.boundary!.half.x).toBeCloseTo((57 * 0.4) / 2);
    expect(portal.boundary!.half.y).toBeCloseTo((45 * 0.4) / 2);
    expect(portal.boundary!.angle).toBeCloseTo(-Math.PI / 4);
    const bounds = createBoundary(portal);
    expect(isInBoundary(bounds, v(10, 8))).toBe(false);
    expect(isInBoundary(bounds, v(8, -8))).toBe(true);
    const falling = createState({ ...defaultOptions(), mapId: 'original-falling' });
    expect(isInBoundary(falling.boundary, v(100, 100))).toBe(true);
    startShrinkingBoundary(falling, v(100, 100));
    expect(isInBoundary(falling.boundary, v(100, 100))).toBe(false);
  });

  it.each(ORIGINAL_MAPS)(
    '$id has grounded spawns, finite shapes and complete mechanism links',
    ({ id }) => {
      const arena = createArena(id);
      expect(arena.id).toBe(id);
      expect(arena.floors!.length).toBeGreaterThan(0);
      expect(arena.spawns.length).toBeGreaterThanOrEqual(2);
      for (const p of arena.spawns) {
        expect(Number.isFinite(p.x + p.y), `${id} non-finite spawn`).toBe(true);
        expect(onGround(arena, p), `${id} spawn ${JSON.stringify(p)} has no supporting floor`).toBe(
          true,
        );
        expect(
          arena.obstacles.some((o) => !o.disabled && !o.broken && obstacleDistance(o, p) < 0.001),
          `${id} spawn center inside a wall`,
        ).toBe(false);
      }
      const mechanisms = arena.environment?.mechanisms ?? [];
      const ids = new Set(mechanisms.map((m) => m.id));
      for (const m of mechanisms) {
        for (const target of m.targetIds ?? [])
          expect(ids.has(target), `${id}/${m.id}->${target}`).toBe(true);
        for (const floor of m.floorIds ?? [])
          expect(arena.floors!.some((f) => f.id === floor)).toBe(true);
        for (const obstacle of m.obstacleIds ?? [])
          expect(arena.obstacles.some((o) => o.id === obstacle)).toBe(true);
      }
      for (const p of arena.portals ?? [])
        expect(arena.portals!.some((other) => other.id === p.exitId)).toBe(true);
      const state = createState({ ...defaultOptions(), mapId: id, bots: 3 });
      for (const actor of state.actors)
        expect(
          safePosition(arena, actor.position, RULES.playerRadius * 0.95),
          `${id}: initial body remains embedded`,
        ).toBe(true);
      const other = createArena(id);
      arena.floors![0].active = false;
      arena.spawns[0].x = 10000;
      expect(other.floors![0].active).toBe(true);
      expect(other.spawns[0].x).not.toBe(10000);
    },
  );
});

describe('original map simulation smoke', () => {
  it.each(ORIGINAL_MAPS.filter((m) => !m.tutorial))(
    '$id completes a four-player match with actual simulation',
    async ({ id }) => {
      const game = new Game({
        ...defaultOptions(),
        mapId: id,
        bots: 3,
        seed: 8751,
        scoreGoal: 1,
        suddenDeathTime: 15,
      });
      game.state.actors.forEach((actor) => {
        actor.controller = 'bot';
      });
      let ticks = 0;
      while (game.state.phase !== 'matchEnd' && ticks < 60 * 150) {
        driveBotGame(game);
        game.drainEvents();
        ticks++;
        if (ticks % 60 === 0) {
          for (const actor of game.state.actors)
            if (!Number.isFinite(actor.position.x + actor.position.y))
              throw new Error(`${id}: non-finite actor`);
        }
        // Let the worker deliver results and timeout messages during long matches.
        if (ticks % 120 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(game.state.phase, `${id}: ${ticks} ticks / round ${game.state.round}`).toBe(
        'matchEnd',
      );
      expect(game.state.actors.some((actor) => actor.score === 1)).toBe(true);
    },
    180000,
  );
});
