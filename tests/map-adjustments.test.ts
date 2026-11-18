import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAPS, createArena } from '../src/core/arena';
import { onGround, safePosition } from '../src/core/collision';
import { RULES } from '../src/core/config';
import { MAP_ADJUSTMENTS } from '../src/core/map-adjustments';
import type { OriginalMapRecord } from '../src/core/original-maps';
import auditData from '../src/devtools/map-audit-data.json';
import { auditMap } from '../src/devtools/map-audit';
import { MAP_DATA_VERSION } from '../src/sdk/recording';
import { hazardKind } from '../src/simulation/hazards';

const raw = readFileSync(new URL('../src/core/original-map-data.json', import.meta.url));
const records = JSON.parse(raw.toString()) as OriginalMapRecord[];

describe('map adjustments', () => {
  it('leave the extracted map data byte-identical', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(MAP_DATA_VERSION);
  });

  it('each name the point it moves, and only move it a little', () => {
    for (const adjustment of MAP_ADJUSTMENTS) {
      const record = records.find((entry) => entry.info.id === adjustment.map);
      expect(record, adjustment.map).toBeDefined();
      const list =
        adjustment.target === 'spawn' ? record!.arena.spawns : record!.arena.pickupSpawns;
      expect(list[adjustment.index], `${adjustment.map} ${adjustment.target}`).toEqual(
        adjustment.from,
      );
      const moved = Math.hypot(
        adjustment.to.x - adjustment.from.x,
        adjustment.to.y - adjustment.from.y,
      );
      expect(moved).toBeGreaterThan(0);
      expect(moved).toBeLessThan(0.5);
      expect(adjustment.reason.length).toBeGreaterThan(0);
    }
  });

  it('are applied to every created arena, without sharing state between matches', () => {
    for (const adjustment of MAP_ADJUSTMENTS) {
      const arena = createArena(adjustment.map);
      const list = adjustment.target === 'spawn' ? arena.spawns : arena.pickupSpawns;
      expect(list[adjustment.index]).toEqual(adjustment.to);
      list[adjustment.index].x += 5;
      expect(
        (adjustment.target === 'spawn'
          ? createArena(adjustment.map).spawns
          : createArena(adjustment.map).pickupSpawns)[adjustment.index],
      ).toEqual(adjustment.to);
    }
  });

  it('leave every spawn and pickup point of every map clear of walls and hazards', () => {
    const clearance = RULES.playerRadius + 0.05;
    for (const map of MAPS) {
      const arena = createArena(map.id);
      for (const [kind, list] of [
        ['spawn', arena.spawns],
        ['pickup', arena.pickupSpawns],
      ] as const)
        list.forEach((point, i) => {
          const where = `${map.id} ${kind} ${i + 1}`;
          expect(onGround(arena, point), where).toBe(true);
          expect(hazardKind(arena, point), where).toBeFalsy();
          expect(safePosition(arena, point, clearance), where).toBe(true);
        });
    }
  });
});

describe('map audit', () => {
  it('finds no spawn problems on the adjusted maps', () => {
    for (const id of ['original-island', 'original-wheel'] as const) {
      const audit = auditMap(id);
      expect(audit.findings.filter((f) => f.level === 'error')).toEqual([]);
      expect(audit.frame.width).toBeGreaterThan(10);
    }
  });

  it('gallery data covers every map', () => {
    const maps = (auditData as { maps: Record<string, unknown> }).maps;
    expect(Object.keys(maps).sort()).toEqual(MAPS.map((map) => map.id).sort());
  });
});
