import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Arena } from '../src/core/types';
import { createArena } from '../src/core/arena';
import { rectanglePath } from '../src/rendering/polygon-geometry';
import { createOriginalArenaView, updateOriginalArena } from '../src/rendering/original-arena';
import { createArenaView } from '../src/rendering/arena-view';
import {
  GroundMaterial,
  groundMaterial,
  shoreDistanceAt,
  shoreDistances,
  shoreSignature,
  WaterMaterial,
} from '../src/rendering/surfaces';

const arena = (): Arena => ({
  id: 'original-surface-fixture',
  sourceScene: 'LevelIsland',
  halfWidth: 10,
  halfHeight: 8,
  obstacles: [],
  pits: [],
  spawns: [],
  pickupSpawns: [],
  portals: [],
  floors: [
    {
      id: 'island',
      position: { x: 1, y: -2 },
      angle: Math.PI / 2,
      // 8 × 4 locally; the quarter turn makes it 4 wide and 8 deep in the world.
      paths: rectanglePath(4, 2),
      kind: 'ground',
      active: true,
    },
  ],
});

describe('shore distance field', () => {
  it('measures signed distance to the land, following floor position and angle', () => {
    const grid = shoreDistances(arena())!;
    expect(grid).not.toBeNull();
    const tolerance = grid.cell;
    // World footprint: x in [-1, 3], y in [-6, 2].
    expect(shoreDistanceAt(grid, { x: 1, y: -2 })).toBeCloseTo(-2, 0);
    expect(Math.abs(shoreDistanceAt(grid, { x: 4, y: -2 }) - 1)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(shoreDistanceAt(grid, { x: 1, y: 3.5 }) - 1.5)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(shoreDistanceAt(grid, { x: 3, y: -2 }))).toBeLessThanOrEqual(tolerance);
    // Unrotated it would reach x = 5; rotated, x = 4.5 is open water.
    expect(shoreDistanceAt(grid, { x: 4.5, y: -2 })).toBeGreaterThan(1.3);
  });

  it('ignores moving and fallen floors, and follows falling tiles as they drop', () => {
    const level = arena();
    level.floors!.push(
      {
        id: 'raft',
        position: { x: -6, y: 0 },
        paths: rectanglePath(1, 1),
        kind: 'moving',
        active: true,
      },
      {
        id: 'tile',
        position: { x: 6, y: 0 },
        paths: rectanglePath(1, 1),
        kind: 'falling',
        active: true,
      },
    );
    const standing = shoreDistances(level)!;
    expect(shoreDistanceAt(standing, { x: -6, y: 0 })).toBeGreaterThan(3);
    expect(shoreDistanceAt(standing, { x: 6, y: 0 })).toBeLessThan(0);
    const before = shoreSignature(level);
    level.floors![2].fallProgress = 0.4;
    expect(shoreSignature(level)).not.toBe(before);
    const fallen = shoreDistances(level)!;
    expect(shoreDistanceAt(fallen, { x: 6, y: 0 })).toBeGreaterThan(2);
    // The grid itself is stable, so a refresh can reuse the texture.
    expect([fallen.width, fallen.height, fallen.minX, fallen.minY]).toEqual([
      standing.width,
      standing.height,
      standing.minX,
      standing.minY,
    ]);
  });

  it('has no field over a cliff, and treats built-in pits as water', () => {
    expect(shoreDistances({ ...arena(), hazard: 'cliff' })).toBeNull();
    const builtIn = createArena('courtyard');
    const grid = shoreDistances(builtIn)!;
    const corner = { x: builtIn.halfWidth - 0.5, y: builtIn.halfHeight - 0.5 };
    const inPit = builtIn.pits.some(
      (pit) =>
        Math.abs(corner.x - pit.position.x) <= pit.half.x &&
        Math.abs(corner.y - pit.position.y) <= pit.half.y,
    );
    if (!inPit) expect(shoreDistanceAt(grid, corner)).toBeLessThan(0);
    for (const pit of builtIn.pits)
      expect(shoreDistanceAt(grid, pit.position)).toBeGreaterThanOrEqual(-grid.cell);
    expect(shoreDistanceAt(grid, { x: builtIn.halfWidth + 2, y: 0 })).toBeGreaterThan(1.5);
  });

  it('keeps every real map field small and finite', async () => {
    const data = (await import('../src/core/original-map-data.json')).default as {
      arena: Arena;
    }[];
    for (const { arena: level } of data) {
      const grid = shoreDistances(level);
      if (level.hazard === 'cliff') {
        expect(grid).toBeNull();
        continue;
      }
      expect(grid!.width).toBeLessThanOrEqual(400);
      expect(grid!.height).toBeLessThanOrEqual(400);
      expect(grid!.data.every(Number.isFinite)).toBe(true);
    }
  });
});

describe('surface materials', () => {
  it('give floors ground materials that survive cloning (tints and voxel twins)', () => {
    const view = createOriginalArenaView(arena());
    const floor = view.floors.get('island')!;
    const mesh = floor.children[0] as THREE.Mesh;
    const [top, side] = mesh.material as THREE.Material[];
    expect(top).toBeInstanceOf(GroundMaterial);
    expect(top.userData.surface).toMatchObject({ kind: 'grass', part: 'top' });
    expect(side.userData.surface).toMatchObject({ kind: 'grass', part: 'side' });
    expect(side.userData.surface.lip).toMatch(/^#[0-9a-f]{6}$/);
    const twin = top.clone();
    expect(twin).toBeInstanceOf(GroundMaterial);
    expect(twin.userData.surface).toEqual(top.userData.surface);
    expect(twin.customProgramCacheKey()).toBe(top.customProgramCacheKey());
  });

  it('picks wood, ice and sand from the floor kind and scene style', () => {
    expect(groundMaterial('#000000', { kind: 'ice', part: 'top' }).roughness).toBeLessThan(0.5);
    const level = arena();
    level.sourceScene = 'LevelTemple';
    level.floors!.push(
      {
        id: 'deck',
        position: { x: 6, y: 0 },
        paths: rectanglePath(1, 1),
        kind: 'wood',
        active: true,
      },
      {
        id: 'rink',
        position: { x: -6, y: 0 },
        paths: rectanglePath(1, 1),
        kind: 'ice',
        active: true,
      },
    );
    const view = createOriginalArenaView(level);
    const kind = (id: string) =>
      ((view.floors.get(id)!.children[0] as THREE.Mesh).material as THREE.Material[])[0].userData
        .surface.kind as string;
    expect([kind('island'), kind('deck'), kind('rink')]).toEqual(['sand', 'wood', 'ice']);
  });

  it('patches the standard shader without losing lighting, and shares one program', () => {
    const material = groundMaterial('#88aa66', { kind: 'grass', part: 'top' });
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader);
    expect(shader.vertexShader).toContain('vSurfWorld = (modelMatrix * surfWorld).xyz');
    expect(shader.fragmentShader).toContain('uSurfKind');
    expect(shader.fragmentShader).toContain('#include <lights_fragment_begin>');
    expect(groundMaterial('#123456', { kind: 'wood', part: 'side' }).customProgramCacheKey()).toBe(
      material.customProgramCacheKey(),
    );
    const water = new WaterMaterial({ color: '#65aab8' });
    const waterShader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    water.onBeforeCompile(waterShader);
    for (const marker of ['waterFoam', 'waterTilt', 'uShoreBox'])
      expect(waterShader.fragmentShader).toContain(marker);
    // Each patch anchors on a chunk name; a renamed chunk would silently drop it.
    expect(waterShader.fragmentShader).toContain('mix(roughnessFactor, 0.85, waterFoam)');
    // Pixel style has its own branches: per-voxel decisions and dithered water.
    expect(waterShader.fragmentShader).toContain('sBayer4(cell)');
    expect(shader.fragmentShader).toContain('sVoxel(vSurfWorld, px)');
    expect(waterShader.fragmentShader).toContain('normal = normalize(normal + (viewMatrix');
    expect(waterShader.vertexShader).toContain('vSurfWorld = (modelMatrix * surfWorld).xyz');
  });

  it('builds water with a shore field and refreshes it when tiles fall', () => {
    const level = arena();
    level.floors!.push({
      id: 'tile',
      position: { x: 6, y: 0 },
      paths: rectanglePath(1, 1),
      kind: 'falling',
      active: true,
    });
    const view = createOriginalArenaView(level);
    const water = view.water.material as WaterMaterial;
    expect(water).toBeInstanceOf(WaterMaterial);
    const texture = water.shore.texture!;
    expect(texture).toBeInstanceOf(THREE.DataTexture);
    const before = (texture.image.data as Uint8Array).slice();
    level.floors![1].fallProgress = 1;
    level.floors![1].active = false;
    updateOriginalArena(view, level, 1);
    expect(water.shore.texture).toBe(texture);
    expect(texture.image.data).not.toEqual(before);
    let disposed = 0;
    texture.addEventListener('dispose', () => disposed++);
    water.dispose();
    expect(disposed).toBe(1);
  });

  it('gives built-in arenas the same ground and water', () => {
    const view = createArenaView(createArena('courtyard'));
    expect(view.water.material).toBeInstanceOf(WaterMaterial);
    expect((view.water.material as WaterMaterial).shore.texture).not.toBeNull();
  });
});
