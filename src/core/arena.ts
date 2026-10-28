import { v } from './math';
import type { Arena, MapId, MapRotation, Obstacle, Portal } from './types';
import { createOriginalArena, ORIGINAL_MAPS } from './original-maps';
import type { MapInfo } from './original-maps';
export { ORIGINAL_MAPS } from './original-maps';

export const CUSTOM_MAPS = [
  {
    id: 'courtyard',
    name: '山间庭院',
    subtitle: 'THE LITTLE COURTYARD',
    description: '绕过喷泉，沿墙反弹。',
    theme: 'garden',
  },
  {
    id: 'canal',
    name: '双桥水道',
    subtitle: 'CANAL CROSSING',
    description: '守住桥头，向水面另一侧投镖。',
    theme: 'canal',
  },
  {
    id: 'market',
    name: '货箱集市',
    subtitle: 'CRATE MARKET',
    description: '打碎货箱，打开新的射线与近路。',
    theme: 'sandstone',
  },
  {
    id: 'switchback',
    name: '折返回廊',
    subtitle: 'SWITCHBACK HALL',
    description: '转角伏击，沿长墙反弹。',
    theme: 'ruins',
  },
  {
    id: 'portals',
    name: '跃迁花园',
    subtitle: 'PORTAL GARDEN',
    description: '人和飞镖都能穿过同色传送门。',
    theme: 'garden',
  },
] as const;

export const MAPS: readonly MapInfo[] = [
  ...ORIGINAL_MAPS,
  ...CUSTOM_MAPS.map((map) => ({ ...map, source: 'custom' as const })),
];

export function mapInfo(id: MapId = 'courtyard') {
  const map = MAPS.find((entry) => entry.id === id);
  if (!map) throw new RangeError(`Unknown map: ${String(id)}`);
  return map;
}

/** Selection is independent of combat RNG, making SDK replay and rotation stable. */
export function selectRoundMap(
  first: MapId = 'courtyard',
  rotation: MapRotation = 'fixed',
  round = 1,
): MapId {
  mapInfo(first);
  if (rotation === 'fixed' || first === 'original-tutorial') return first;
  const collection = first.startsWith('original-')
    ? ORIGINAL_MAPS.filter((map) => !map.tutorial)
    : CUSTOM_MAPS;
  const index = collection.findIndex((map) => map.id === first);
  return collection[(index + Math.max(0, Math.floor(round) - 1)) % collection.length].id;
}

const stone = (id: string, x: number, y: number, hx: number, hy: number): Obstacle => ({
  id,
  kind: 'stone',
  position: v(x, y),
  half: v(hx, hy),
  broken: false,
});
const crate = (id: string, x: number, y: number): Obstacle => ({
  id,
  kind: 'crate',
  position: v(x, y),
  half: v(0.48, 0.48),
  broken: false,
});

export function createArena(id: MapId = 'courtyard'): Arena {
  mapInfo(id);
  if (id.startsWith('original-')) return createOriginalArena(id);
  if (id !== 'courtyard') return createAdditionalArena(id);
  const obstacles: Obstacle[] = [
    { id: 'fountain', kind: 'fountain', position: v(0, 0), half: v(1.25, 1.25), broken: false },
    { id: 'wall-nw', kind: 'stone', position: v(-4.7, -3.2), half: v(1.6, 0.45), broken: false },
    { id: 'wall-se', kind: 'stone', position: v(4.7, 3.2), half: v(1.6, 0.45), broken: false },
    { id: 'rock-ne', kind: 'stone', position: v(8.7, -5.8), half: v(0.65, 0.8), broken: false },
    { id: 'rock-sw', kind: 'stone', position: v(-8.7, 5.8), half: v(0.65, 0.8), broken: false },
    ...[v(-4, 2.4), v(-5.2, 2.4), v(4, -2.4), v(5.2, -2.4)].map((position, i) => ({
      id: `crate-${i}`,
      kind: 'crate' as const,
      position,
      half: v(0.48, 0.48),
      broken: false,
    })),
  ];
  return {
    id,
    revision: 0,
    halfWidth: 13,
    halfHeight: 8.2,
    obstacles,
    pits: [
      { position: v(-9.8, -0.2), half: v(1.15, 1.4) },
      { position: v(9.8, 0.2), half: v(1.15, 1.4) },
    ],
    spawns: [v(-7.5, 3.8), v(7.5, -3.8), v(-7.5, -5), v(7.5, 5)],
    pickupSpawns: [v(0, -4.9), v(0, 4.9), v(-6.8, 0), v(6.8, 0), v(-2.8, 0), v(2.8, 0)],
    portals: [],
  };
}

function createAdditionalArena(id: Exclude<MapId, 'courtyard'>): Arena {
  const arena: Arena = {
    id,
    revision: 0,
    halfWidth: 13,
    halfHeight: 8.2,
    obstacles: [],
    pits: [],
    portals: [],
    spawns: [v(-9, 5.5), v(9, -5.5), v(-9, -5.5), v(9, 5.5)],
    pickupSpawns: [v(-8, 0), v(8, 0), v(0, -5.5), v(0, 5.5), v(0, 0)],
  };
  if (id === 'canal') {
    arena.pits = [
      { position: v(0, -5.5), half: v(1.45, 1.45) },
      { position: v(0, -1.45), half: v(1.45, 0.55) },
      { position: v(0, 1.45), half: v(1.45, 0.55) },
      { position: v(0, 5.5), half: v(1.45, 1.45) },
    ];
    arena.obstacles = [
      stone('canal-nw', -5.2, -2.8, 1.5, 0.4),
      stone('canal-se', 5.2, 2.8, 1.5, 0.4),
      stone('canal-ne', 6, -5.4, 0.5, 1),
      stone('canal-sw', -6, 5.4, 0.5, 1),
      crate('canal-crate-0', -4, 1.6),
      crate('canal-crate-1', 4, -1.6),
    ];
    arena.pickupSpawns = [v(-8, 0), v(8, 0), v(0, -3), v(0, 3), v(0, 0)];
  } else if (id === 'market') {
    arena.obstacles = [
      stone('stall-nw', -5, -3.7, 1.7, 0.6),
      stone('stall-ne', 5, -3.7, 1.7, 0.6),
      stone('stall-sw', -5, 3.7, 1.7, 0.6),
      stone('stall-se', 5, 3.7, 1.7, 0.6),
      ...[-3, 3].flatMap((x, row) =>
        [-1.15, 0, 1.15].map((y, i) => crate(`market-${row}-${i}`, x, y)),
      ),
      crate('market-north', 0, -4),
      crate('market-south', 0, 4),
    ];
    arena.pickupSpawns = [v(-8, 0), v(8, 0), v(0, -6.4), v(0, 6.4), v(0, 0)];
  } else if (id === 'switchback') {
    arena.obstacles = [
      stone('hall-west', -3.8, -1.7, 0.45, 3.6),
      stone('hall-east', 3.8, 1.7, 0.45, 3.6),
      stone('hall-nw', -7.1, -2.7, 1.3, 0.4),
      stone('hall-se', 7.1, 2.7, 1.3, 0.4),
      crate('hall-crate-n', 0, -3),
      crate('hall-crate-s', 0, 3),
    ];
    arena.pits = [
      { position: v(-10.3, -0.1), half: v(1, 1.1) },
      { position: v(10.3, 0.1), half: v(1, 1.1) },
    ];
    arena.pickupSpawns = [v(-7, 0), v(7, 0), v(0, -5.8), v(0, 5.8), v(0, 0)];
  } else {
    arena.obstacles = [
      stone('portal-west', -3.8, -1.6, 0.45, 3.4),
      stone('portal-east', 3.8, 1.6, 0.45, 3.4),
      stone('portal-north', 0, -5.8, 1.3, 0.4),
      stone('portal-south', 0, 5.8, 1.3, 0.4),
      crate('portal-crate-a', -7, -2.4),
      crate('portal-crate-b', 7, 2.4),
    ];
    const portal = (
      portalId: string,
      exitId: string,
      x: number,
      y: number,
      dx: number,
      color: string,
    ): Portal => ({
      id: portalId,
      exitId,
      position: v(x, y),
      direction: v(dx, 0),
      radius: 0.7,
      color,
    });
    arena.portals = [
      portal('mint-west', 'mint-east', -7, 2.6, 1, '#5ac9b4'),
      portal('mint-east', 'mint-west', 7, -2.6, -1, '#5ac9b4'),
      portal('rose-west', 'rose-east', -7, -4.5, 1, '#c98ee1'),
      portal('rose-east', 'rose-west', 7, 4.5, -1, '#c98ee1'),
    ];
    arena.pickupSpawns = [v(-10.5, 0), v(10.5, 0), v(0, -3), v(0, 3), v(0, 0)];
  }
  return arena;
}
