import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import originalMapData from '../src/core/original-map-data.json';
import type { Arena, GameState } from '../src/core/types';
import { contourShapes, extrudeContours, rectanglePath } from '../src/rendering/polygon-geometry';
import {
  createOriginalArenaView,
  updateOriginalArena,
  flashOriginalGate,
  mergeOriginalStatics,
} from '../src/rendering/original-arena';
import {
  arenaCameraDistance,
  arenaCameraFrame,
  ORIGINAL_CAMERA_UP,
  ORIGINAL_CAMERA_BACK,
} from '../src/rendering/arena-camera';
import { BoundaryView } from '../src/rendering/boundary-view';

const arena = (): Arena => ({
  id: 'original-render-fixture',
  sourceScene: 'LevelFalling',
  halfWidth: 10,
  halfHeight: 8,
  obstacles: [],
  pits: [],
  spawns: [],
  pickupSpawns: [],
  portals: [],
  floors: [
    {
      id: 'base',
      position: { x: 0, y: 0 },
      paths: rectanglePath(4, 3),
      kind: 'ground',
      active: true,
    },
  ],
});
function dispose(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material])
      if (!m.userData.shared) m.dispose();
  });
}

describe('original map contour rendering', () => {
  it('constructs every extracted map and retains finite geometry after static batching', () => {
    const maps = originalMapData as unknown as {
      info: { id: string };
      arena: Arena;
    }[];
    const report: {
      id: string;
      meshes: number;
      triangles: number;
      floors: number;
      obstacles: number;
    }[] = [];
    for (const entry of maps) {
      const view = createOriginalArenaView(entry.arena);
      mergeOriginalStatics(view, entry.arena);
      let meshes = 0,
        triangles = 0;
      view.root.updateMatrixWorld(true);
      view.root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        meshes++;
        const positions = object.geometry.getAttribute('position');
        if (!positions)
          throw new Error(
            `${entry.info.id}: ${object.parent?.name}/${object.name} has no geometry vertices`,
          );
        expect(positions?.count, entry.info.id).toBeGreaterThan(0);
        expect(positions.array.every(Number.isFinite), entry.info.id).toBe(true);
        triangles += (object.geometry.index?.count ?? positions.count) / 3;
      });
      expect(view.floors.size).toBe(entry.arena.floors?.length);
      for (const floor of entry.arena.floors ?? [])
        if (floor.active)
          expect(view.floors.get(floor.id)!.position.y, `${entry.info.id}/${floor.id}`).toBeCloseTo(
            0,
          );
      const activePlants =
        entry.arena.environment?.mechanisms.filter(
          (m) => m.kind === 'plant' && m.active !== false && m.phase !== 'cut',
        ).length ?? 0;
      expect(view.plants?.mesh.count ?? 0, entry.info.id).toBe(activePlants);
      report.push({
        id: entry.info.id,
        meshes,
        triangles,
        floors: view.floors.size,
        obstacles: view.obstacles.size,
      });
      dispose(view.root);
    }
    expect(report.length).toBeGreaterThan(50);
  }, 30000);
  it('triangulates disjoint islands, a hole and an island inside the hole with even-odd coverage', () => {
    const paths = [
      rectanglePath(4, 4)[0],
      rectanglePath(2, 2)[0].reverse(),
      rectanglePath(1, 1)[0],
      [
        { x: 6, y: 0 },
        { x: 8, y: 0 },
        { x: 8, y: 2 },
        { x: 6, y: 2 },
      ],
    ];
    expect(contourShapes(paths)).toHaveLength(3);
    const geometry = extrudeContours(paths, 1);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    const ray = (x: number, z: number) =>
      new THREE.Raycaster(new THREE.Vector3(x, 3, z), new THREE.Vector3(0, -1, 0)).intersectObject(
        mesh,
      );
    expect(ray(3, 0)[0].point.y).toBeCloseTo(1);
    expect(ray(1.5, 0)).toHaveLength(0);
    expect(ray(0, 0)[0].point.y).toBeCloseTo(1);
    expect(ray(7, 1)[0].point.y).toBeCloseTo(1);
    const positions = geometry.getAttribute('position'),
      normals = geometry.getAttribute('normal');
    let topArea = 0;
    for (let i = 0; i < positions.count; i += 3) {
      if (normals.getY(i) < 0.9) continue;
      const ax = positions.getX(i),
        az = positions.getZ(i),
        bx = positions.getX(i + 1),
        bz = positions.getZ(i + 1),
        cx = positions.getX(i + 2),
        cz = positions.getZ(i + 2);
      topArea += Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
    }
    expect(topArea).toBeCloseTo(56);
    dispose(mesh);
  });
  it('keeps rotated walls and separate floor geometry instead of adding a bounds rectangle', () => {
    const state = arena();
    state.floors![0].paths = [
      [
        { x: -3, y: -2 },
        { x: 3, y: -2 },
        { x: 3, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 2 },
        { x: -3, y: 2 },
      ],
    ];
    state.obstacles.push({
      id: 'wall',
      position: { x: 3, y: 2 },
      half: { x: 2, y: 0.3 },
      kind: 'stone',
      broken: false,
      angle: Math.PI / 4,
      height: 1.7,
    });
    const view = createOriginalArenaView(state);
    const wall = view.obstacles.get('wall')!;
    expect(wall.rotation.y).toBeCloseTo(-Math.PI / 4);
    wall.updateMatrixWorld(true);
    const tip = wall.localToWorld(new THREE.Vector3(2, 0, 0));
    expect(tip.x).toBeCloseTo(3 + Math.SQRT2);
    expect(tip.z).toBeCloseTo(2 + Math.SQRT2);
    expect(view.floors.size).toBe(1);
    expect(view.root.children.some((o) => o.name === 'ground-rectangle')).toBe(false);
    dispose(view.root);
  });
  it('places buried source geometry at its actual base and frames its exposed top', () => {
    const state = arena();
    state.boundary = {
      center: { x: 0, y: 0 },
      half: { x: 8, y: 8 },
      angle: 0,
      allowOutside: false,
    };
    state.obstacles = [
      {
        id: 'buried-cliff',
        position: { x: 1, y: 2 },
        half: { x: 2, y: 1 },
        height: 20,
        baseHeight: -19.1,
        kind: 'stone',
        broken: false,
      },
    ];
    const view = createOriginalArenaView(state);
    view.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(view.obstacles.get('buried-cliff')!);
    expect(bounds.min.y).toBeCloseTo(-19.1);
    expect(bounds.max.y).toBeCloseTo(0.9);
    expect(arenaCameraFrame(state).height).toBe(2.8);
    mergeOriginalStatics(view, state);
    view.root.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(1, 5, 2), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(view.root, true)[0].point.y).toBeCloseTo(0.9);
    dispose(view.root);
  });
});

describe('original dynamic presentation', () => {
  it('renders trigger-only plants in one batch and keeps their pose, cut and burn state authoritative', () => {
    const state = arena();
    state.environment = {
      mechanisms: [
        {
          id: 'raft',
          kind: 'movingFloor',
          position: { x: 0, y: 0 },
          initialHeight: -1.2,
          previousHeight: -1.2,
          height: -2.2,
        },
        ...Array.from({ length: 1000 }, (_, i) => ({
          id: `p-${i}`,
          kind: 'plant' as const,
          parentId: 'raft',
          position: { x: i + 2, y: 3 },
          previous: { x: i, y: 3 },
          height: 0.2,
          previousHeight: 0.2,
          initialHeight: 0.2,
          radius: 0.3,
          active: true,
          phase: 'idle' as const,
        })),
      ],
    };
    const view = createOriginalArenaView(state),
      plants = view.plants!;
    expect(view.obstacles.size).toBe(0);
    expect(plants.mesh.count).toBe(1000);
    expect(view.root.children.filter((o) => o instanceof THREE.InstancedMesh)).toHaveLength(1);
    updateOriginalArena(view, state, 1, 0.5);
    const matrix = new THREE.Matrix4();
    plants.mesh.getMatrixAt(0, matrix);
    expect(matrix.elements[12]).toBeCloseTo(1);
    expect(matrix.elements[13]).toBeCloseTo(-0.3);
    const geometry = plants.mesh.geometry;
    const plant = state.environment.mechanisms[1];
    plant.disturbance = 1;
    plant.disturbedDirection = { x: 1, y: 0 };
    plant.burnTime = 1;
    plant.burnHealth = 0.1;
    state.environment.mechanisms[2].phase = 'cut';
    state.environment.mechanisms[3].active = false;
    const before = structuredClone(state);
    updateOriginalArena(view, state, 1, 0.5);
    plants.mesh.getMatrixAt(0, matrix);
    expect(Math.abs(matrix.elements[1])).toBeGreaterThan(0.1);
    expect(plants.mesh.count).toBe(998);
    const burned = new THREE.Color(),
      fresh = new THREE.Color();
    plants.mesh.getColorAt(0, burned);
    plants.mesh.getColorAt(1, fresh);
    expect(burned.g).toBeLessThan(fresh.g);
    const positions = plants.mesh.instanceMatrix.array.slice();
    updateOriginalArena(view, state, 1, 0.5);
    expect(plants.mesh.instanceMatrix.array).toEqual(positions);
    expect(plants.mesh.geometry).toBe(geometry);
    expect(state).toEqual(before);
    dispose(view.root);
  });
  it('uses a common walkable top despite physics depth, then applies only a mechanism height delta', () => {
    const state = arena();
    state.floors![0].height = 2.7;
    state.floors!.push({
      ...state.floors![0],
      id: 'raft-floor',
      height: -1.2,
      kind: 'moving',
      mechanismId: 'raft',
    });
    state.environment = {
      mechanisms: [{ id: 'raft', kind: 'movingFloor', position: { x: 0, y: 0 }, height: -1.2 }],
    };
    const view = createOriginalArenaView(state);
    expect(view.floors.get('base')!.position.y).toBeCloseTo(0);
    expect(view.floors.get('raft-floor')!.position.y).toBeCloseTo(0);
    Object.assign(state.environment.mechanisms[0], {
      initialHeight: -1.2,
      previousHeight: -1.2,
      height: -2.2,
    });
    updateOriginalArena(view, state, 1, 0.5);
    expect(view.floors.get('raft-floor')!.position.y).toBeCloseTo(-0.5);
    expect(view.floors.get('base')!.position.y).toBeCloseTo(0);
    dispose(view.root);
  });
  it('batches hundreds of static walls while leaving breakable and moving nodes available', () => {
    const state = arena();
    state.obstacles = Array.from({ length: 200 }, (_, i) => ({
      id: `wall-${i}`,
      position: { x: i % 20, y: Math.floor(i / 20) },
      half: { x: 0.3, y: 0.3 },
      kind: 'stone' as const,
      broken: false,
      height: 1,
    }));
    state.obstacles.push({
      id: 'box',
      position: { x: -2, y: 0 },
      half: { x: 0.5, y: 0.5 },
      kind: 'crate',
      broken: false,
      height: 1,
    });
    state.floors!.push({
      id: 'moving',
      position: { x: 0, y: 5 },
      paths: rectanglePath(2, 1),
      kind: 'moving',
      active: true,
      mechanismId: 'raft',
    });
    const view = createOriginalArenaView(state),
      moving = view.floors.get('moving')!,
      box = view.obstacles.get('box')!;
    expect(mergeOriginalStatics(view, state)).toBeGreaterThanOrEqual(400);
    let meshes = 0;
    view.root.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes++;
    });
    expect(meshes).toBeLessThan(12);
    expect(moving.children.length).toBeGreaterThan(0);
    expect(box.children.length).toBeGreaterThan(0);
    state.obstacles.at(-1)!.broken = true;
    state.floors![1].position.x = 3;
    updateOriginalArena(view, state, 2);
    expect(box.visible).toBe(false);
    expect(moving.position.x).toBe(3);
    dispose(view.root);
  });
  it('interpolates authoritative mechanism deltas once and retains the GPU objects across pause and collapse', () => {
    const state = arena();
    state.floors![0] = {
      ...state.floors![0],
      position: { x: 2, y: 0 },
      angle: Math.PI,
      height: 0.25,
      mechanismId: 'moving',
    };
    state.environment = {
      mechanisms: [
        {
          id: 'moving',
          kind: 'movingFloor',
          position: { x: 4, y: 0 },
          previous: { x: 0, y: 0 },
          angle: Math.PI,
          previousAngle: 0,
          height: -2.4,
          previousHeight: 0,
          initialHeight: 0,
        },
      ],
    };
    const before = structuredClone(state),
      view = createOriginalArenaView(state),
      floor = view.floors.get('base')!;
    const geometry = (floor.children[0] as THREE.Mesh).geometry;
    updateOriginalArena(view, state, 3, 0.5);
    expect(floor.position.x).toBeCloseTo(2);
    expect(floor.position.z).toBeCloseTo(2);
    expect(floor.position.y).toBeCloseTo(-1.2);
    expect(floor.rotation.y).toBeCloseTo(-Math.PI / 2);
    const pose = floor.matrix.clone();
    for (let i = 0; i < 30; i++) updateOriginalArena(view, state, 3, 0.5);
    expect(floor.matrix).toEqual(pose);
    expect((floor.children[0] as THREE.Mesh).geometry).toBe(geometry);
    expect(state).toEqual(before);
    state.floors![0].active = false;
    state.floors![0].fallProgress = 1;
    updateOriginalArena(view, state, 4);
    expect(floor.visible).toBe(false);
    dispose(view.root);
  });
  it('constructs a vertical paired gate and samples its flash from simulation time', () => {
    const state = arena();
    state.portals = [
      {
        id: 'a',
        exitId: 'b',
        position: { x: 2, y: 1 },
        direction: { x: 0, y: 1 },
        radius: 0.7,
        half: { x: 0.8, y: 0.12 },
        color: '#66bbaa',
      },
    ];
    const view = createOriginalArenaView(state),
      gate = view.portals.get('a')!;
    const surface = gate.userData.gateSurface as THREE.Mesh<
      THREE.PlaneGeometry,
      THREE.ShaderMaterial
    >;
    expect(surface.rotation.x).toBe(0);
    expect(surface.geometry.parameters.height).toBeGreaterThan(1);
    flashOriginalGate(view, { x: 2, y: 1 }, 5);
    updateOriginalArena(view, state, 5.25);
    expect(surface.material.uniforms.flash.value).toBeCloseTo(0.5);
    updateOriginalArena(view, state, 5.25);
    expect(surface.material.uniforms.flash.value).toBeCloseTo(0.5);
    updateOriginalArena(view, state, 6);
    expect(surface.material.uniforms.flash.value).toBe(0);
    dispose(view.root);
  });
  it('keeps attached props, gates and switches with falling ancestors without duplicating XY motion', () => {
    const state = arena();
    state.floors![0].mechanismId = 'parent';
    state.floors![0].height = 0.3;
    state.obstacles.push({
      id: 'plant',
      position: { x: 6, y: 2 },
      half: { x: 0.2, y: 0.2 },
      kind: 'stone',
      material: 'tree',
      height: 1.5,
      broken: false,
      mechanismId: 'child',
    });
    state.portals = [
      {
        id: 'gate',
        exitId: 'other',
        position: { x: 6, y: 2 },
        direction: { x: 0, y: 1 },
        radius: 0.5,
        color: '#66bbaa',
      },
    ];
    state.environment = {
      mechanisms: [
        {
          id: 'grandparent',
          kind: 'movingFloor',
          position: { x: 5, y: 2 },
          initialHeight: 1,
          previousHeight: 0.8,
          height: 0.6,
        },
        {
          id: 'parent',
          kind: 'fallingFloor',
          parentId: 'grandparent',
          position: { x: 5, y: 2 },
          initialHeight: 0.3,
          previousHeight: 0.3,
          height: -2.1,
        },
        {
          id: 'child',
          kind: 'plant',
          parentId: 'parent',
          position: { x: 6, y: 2 },
          previous: { x: 4, y: 2 },
          initialHeight: 0.4,
          previousHeight: 0.4,
          height: 0.2,
          portalIds: ['gate'],
        },
        {
          id: 'lever',
          kind: 'switch',
          parentId: 'parent',
          position: { x: 5, y: 2 },
          previous: { x: 3, y: 2 },
          initialHeight: 0.7,
          previousHeight: 0.7,
          height: 0.7,
        },
        { id: 'kill-zone', kind: 'destroyer', position: { x: 0, y: 0 } },
      ],
    };
    const before = structuredClone(state);
    const view = createOriginalArenaView(state);
    updateOriginalArena(view, state, 1, 0.5);
    expect(view.floors.get('base')!.position.y).toBeCloseTo(-1.5);
    expect(view.obstacles.get('plant')!.position.y).toBeCloseTo(-1.6);
    expect(view.portals.get('gate')!.position.y).toBeCloseTo(-1.6);
    expect(view.mechanisms.get('lever')!.position.y).toBeCloseTo(-0.8);
    expect(view.obstacles.get('plant')!.position.x).toBe(5);
    expect(view.portals.get('gate')!.position.x).toBe(5);
    expect(view.mechanisms.get('lever')!.position.x).toBe(4);
    expect(view.mechanisms.has('kill-zone')).toBe(false);
    expect(state).toEqual(before);
    dispose(view.root);
  });
});

describe('map framing and rotated arena boundary', () => {
  it('fits wide and portrait frames to the source boundary instead of oversized helper floor colliders', () => {
    const state = arena();
    state.floors![0].paths = rectanglePath(100, 100);
    state.boundary = {
      center: { x: 7, y: -3 },
      half: { x: 12, y: 8 },
      angle: Math.PI / 4,
      allowOutside: false,
    };
    const frame = arenaCameraFrame(state);
    expect(frame.half.x).toBeLessThan(16);
    expect(frame.center).toEqual(state.boundary.center);
    for (const aspect of [16 / 9, 9 / 16]) {
      const distance = arenaCameraDistance(frame, aspect);
      const camera = new THREE.PerspectiveCamera(31, aspect, 0.1, 500);
      camera.position.set(
        frame.center.x,
        (distance * ORIGINAL_CAMERA_UP) / Math.hypot(ORIGINAL_CAMERA_UP, ORIGINAL_CAMERA_BACK),
        frame.center.y +
          (distance * ORIGINAL_CAMERA_BACK) / Math.hypot(ORIGINAL_CAMERA_UP, ORIGINAL_CAMERA_BACK),
      );
      camera.lookAt(frame.center.x, 0, frame.center.y);
      camera.updateMatrixWorld(true);
      for (const x of [-frame.half.x, frame.half.x])
        for (const z of [-frame.half.y, frame.half.y])
          for (const y of [0, frame.height]) {
            const projected = new THREE.Vector3(frame.center.x + x, y, frame.center.y + z).project(
              camera,
            );
            expect(Math.abs(projected.x)).toBeLessThan(1);
            expect(Math.abs(projected.y)).toBeLessThan(1);
          }
    }
  });
  it('rotates only boundary visuals and evaluates the near-edge opacity in local coordinates', () => {
    const view = new BoundaryView();
    const state = {
      phase: 'playing',
      time: 5,
      actors: [{ id: 0, alive: true, position: { x: 0, y: 9.5 } }],
      boundary: {
        center: { x: 0, y: 0 },
        halfSize: { x: 10, y: 3 },
        angle: Math.PI / 2,
        allowOutside: false,
        phase: 'idle',
        targetCenter: { x: 0, y: 0 },
        startedAt: 0,
      },
    } as unknown as GameState;
    view.update(state, false);
    const line = view.root.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
    expect(line.rotation.y).toBeCloseTo(-Math.PI / 2);
    expect(view.root.rotation.y).toBe(0);
    expect(line.material.uniforms.opacity.value).toBeCloseTo(0.298);
    state.boundary.allowOutside = true;
    view.update(state, false);
    expect(view.root.visible).toBe(false);
    view.dispose();
  });
});
