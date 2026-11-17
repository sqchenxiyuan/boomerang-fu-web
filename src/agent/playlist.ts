import { ORIGINAL_MAPS } from '../core/arena';
import type { MapId } from '../core/types';

/*
 * LevelManager.BuildMatchPlaylist for a two-player DeathMatch without DLC or
 * tutorial (the reference FFA shell), shuffled by Mono System.Random. The same
 * seed yields the same map order as the Godot adapter.
 */
const BIG = 2147483647;
const int32 = (value: number): number => value | 0;

/** Mono/.NET System.Random: Knuth's subtractive generator. */
export class SystemRandom {
  private values = new Array<number>(56).fill(0);
  private next = 0;
  private partner = 21;
  constructor(seed: number) {
    let current = 161803398 - (seed === -2147483648 ? BIG : Math.abs(seed));
    this.values[55] = current;
    let previous = 1;
    for (let i = 1; i < 55; i++) {
      const index = (21 * i) % 55;
      this.values[index] = previous;
      previous = int32(current - previous);
      if (previous < 0) previous += BIG;
      current = this.values[index];
    }
    for (let pass = 0; pass < 4; pass++)
      for (let i = 1; i < 56; i++) {
        this.values[i] = int32(this.values[i] - this.values[1 + ((i + 30) % 55)]);
        if (this.values[i] < 0) this.values[i] += BIG;
      }
  }
  sample(): number {
    if (++this.next >= 56) this.next = 1;
    if (++this.partner >= 56) this.partner = 1;
    let result = int32(this.values[this.next] - this.values[this.partner]);
    if (result === BIG) result--;
    if (result < 0) result += BIG;
    this.values[this.next] = result;
    return result;
  }
  nextDouble(): number {
    return this.sample() * (1 / BIG);
  }
}

/** Two-player DeathMatch base-game entries in reference catalog order. */
export const CATALOG_SCENES = [
  'LevelDrift',
  'LevelEnclosed',
  'LevelMiniIsland',
  'LevelFalling2',
  'LevelIsland',
  'LevelMaze',
  'LevelMoving',
  'LevelPlants',
  'LevelSquare',
  'LevelRooms',
  'LevelSpin',
  'LevelTeleportals',
  'LevelTracks',
  'LevelTutorial',
  'LevelSplit',
  'LevelFalling',
  'LevelWheel',
  'LevelClouds',
  'LevelSlideTraps',
  'LevelPools',
  'LevelMarketplace',
  'LevelTemple',
  'LevelTempleGarden',
  'LevelTurnstile',
  'LevelToaster',
  'LevelWasher',
  'LevelForest',
  'LevelPier',
  'LevelOnsen',
  'LevelCloudSweep',
  'LevelWhisk',
  'LevelBambooGrove',
  'LevelBridges',
  'LevelHenge',
  'LevelMist',
  'LevelRing',
  'LevelPinball',
] as const;

const COMPLEXITY: Record<string, number> = { Tutorial: 0, Simple: 1, Advanced: 2 };
interface Entry {
  id: MapId;
  scene: string;
  complexity: number;
}
let catalog: Entry[] | null = null;
export function playlistCatalog(): readonly Entry[] {
  catalog ??= CATALOG_SCENES.map((scene) => {
    const map = ORIGINAL_MAPS.find((entry) => entry.subtitle === scene);
    if (!map) throw new Error(`Map data is missing ${scene}`);
    const complexity = COMPLEXITY[String(map.complexity)];
    if (complexity === undefined) throw new Error(`Unknown complexity for ${scene}`);
    return { id: map.id, scene, complexity };
  });
  return catalog;
}

/** The match's map order; round n plays entry (n − 1) mod length. */
export function matchPlaylist(seed: number): MapId[] {
  const entries = playlistCatalog();
  const random = new SystemRandom(seed);
  const candidates = entries.map((_, index) => index);
  // Chance.Shuffle: descending Fisher–Yates with System.Random.
  for (let i = candidates.length - 1; i > 0; i--) {
    const chosen = Math.floor(random.nextDouble() * (i + 1));
    [candidates[chosen], candidates[i]] = [candidates[i], candidates[chosen]];
  }
  // Tutorials are dropped (the FFA shell disables them); then three simple openers.
  const pool = candidates.filter((index) => entries[index].complexity !== 0);
  const order: number[] = [];
  let simpleLeft = 3;
  while (pool.length) {
    const simple = pool.filter((index) => entries[index].complexity === 1);
    const choices = simpleLeft > 0 && simple.length ? simple : pool;
    if (choices === simple) simpleLeft--;
    const selected = choices[0];
    order.push(selected);
    pool.splice(pool.indexOf(selected), 1);
  }
  return order.map((index) => entries[index].id);
}
