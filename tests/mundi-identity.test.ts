import { describe, expect, it } from 'vitest';
import { mundiFace, mundiFaceLook } from '../src/mundi/identity';

describe("MUNDI's default agent identity", () => {
  it('draws a deterministic mirrored 5×5 face from the seed', () => {
    for (const seed of [0, 1, 7, 2 ** 31, 4294967295, 123456789]) {
      const face = mundiFace(seed);
      expect(face).toEqual(mundiFace(seed));
      expect(face).toHaveLength(5);
      for (const row of face) {
        expect(row).toHaveLength(5);
        expect(row.every((v) => v === 0 || v === 1 || v === 2)).toBe(true);
        expect(row).toEqual([...row].reverse());
      }
    }
    expect(mundiFace(1)).not.toEqual(mundiFace(2));
    // Pinned against MUNDI agent-world.js face(hashOf('house')) = face(299873145).
    expect(mundiFace(299873145)).toEqual([
      [2, 1, 2, 1, 2],
      [0, 1, 0, 1, 0],
      [1, 0, 1, 0, 1],
      [2, 2, 0, 2, 2],
      [1, 0, 0, 0, 1],
    ]);
  });

  it('turns the face into a bear-eared voxel head in the player colour', () => {
    const look = mundiFaceLook(42, '#4ee2f2', '小绿', 1);
    expect(look).toMatchObject({ v: 1, name: '小绿', hue: '#4ee2f2', grid: 5 });
    const ears = look.runs.filter(([, y]) => y === 0);
    expect(ears).toEqual([
      [0, 0, 1, '#4ee2f2'],
      [4, 0, 1, '#4ee2f2'],
    ]);
    const face = mundiFace(42);
    for (let y = 1; y <= 5; y++) {
      const row = look.runs.filter(([, ry]) => ry === y);
      expect(row.reduce((sum, [, , w]) => sum + w, 0)).toBe(5);
      for (const [x, , w, colour] of row)
        for (let i = x; i < x + w; i++) {
          const value = face[y - 1][i];
          expect(colour).toBe(value === 1 ? '#4ee2f2' : value === 2 ? '#cdd2d6' : '#181b1f');
        }
    }
  });
});
