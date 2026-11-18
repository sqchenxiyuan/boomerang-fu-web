import type { AgentLook, VoxelRun } from '../agents/look';

/*
 * MUNDI's default agent identity, for players who have not drawn their own:
 * the same seeded 5×5 mirrored face MUNDI shows as the agent's avatar and on
 * its voxel body in agent-world.js (rng, face() and build() with bear ears),
 * so a player's bot looks the same in the game as on the platform.
 */
const LIGHT = '#cdd2d6'; // [205, 210, 214]
const DARK = '#181b1f'; // [24, 27, 31]

/** agent-world.js rng(seed): a mulberry32 stream. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** agent-world.js face(seed): 0 empty (dark), 1 body colour, 2 light. */
export function mundiFace(seed: number): number[][] {
  const next = rng(seed),
    grid: number[][] = [];
  for (let y = 0; y < 5; y++) {
    grid[y] = [0, 0, 0, 0, 0];
    for (let x = 0; x < 3; x++)
      if (next() > 0.52) {
        const value = next() > 0.72 ? 2 : 1;
        grid[y][x] = value;
        grid[y][4 - x] = value;
      }
  }
  return grid;
}

/** The face as voxel runs: a bear-eared row above five face rows. */
export function mundiFaceLook(seed: number, hue: string, name: string, index: number): AgentLook {
  const face = mundiFace(seed),
    colour = (value: number) => (value === 1 ? hue : value === 2 ? LIGHT : DARK);
  const runs: VoxelRun[] = [
    [0, 0, 1, hue],
    [4, 0, 1, hue],
  ];
  face.forEach((row, y) => {
    for (let x = 0; x < 5; ) {
      let end = x;
      while (end + 1 < 5 && row[end + 1] === row[x]) end++;
      runs.push([x, y + 1, end - x + 1, colour(row[x])]);
      x = end + 1;
    }
  });
  return {
    v: 1,
    id: `mundi-seed-${index}-${seed >>> 0}`,
    name,
    img: '',
    bg: '#0b0d0f',
    hue,
    grid: 5,
    runs,
    updated: 0,
  };
}
