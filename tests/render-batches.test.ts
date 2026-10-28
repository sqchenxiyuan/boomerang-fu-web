import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { InstanceBatch, mergeStaticMeshes } from '../src/rendering/batches';
import { Effects } from '../src/rendering/effects';
import { WeaponsView, discEffectColor } from '../src/rendering/weapons-view';
import { PowersView } from '../src/rendering/powers-view';
import { createState } from '../src/simulation/state';
import type { Disc } from '../src/core/types';

function instanceData(root: THREE.Object3D): unknown[] {
  const result: unknown[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh)) return;
    result.push({
      count: o.count,
      matrices: Array.from(o.instanceMatrix.array.slice(0, o.count * 16)),
      colors: Array.from(o.instanceColor!.array.slice(0, o.count * 3)),
      alpha: Array.from(
        (o.geometry.getAttribute('instanceAlpha') as THREE.InstancedBufferAttribute).array.slice(
          0,
          o.count,
        ),
      ),
    });
  });
  return result;
}
function disc(): Disc {
  return {
    id: 1,
    ownerId: 0,
    damageOwnerId: 0,
    position: { x: 0, y: 0 },
    previous: { x: -0.2, y: 0 },
    velocity: { x: 12, y: 0 },
    state: 'outbound',
    age: 0,
    stateTime: 0,
    charge: 1,
    curve: 0,
    bounces: 0,
    explosive: false,
    fuse: 1,
    grace: 0,
    lastDeflector: -1,
    dead: false,
    powers: [],
    mini: false,
  };
}

describe('bounded renderer-owned resources', () => {
  it('bounds instance counts and reuses GPU resources across clear and refill', () => {
    const batch = new InstanceBatch(new THREE.IcosahedronGeometry(1, 0), 8);
    const geometry = batch.mesh.geometry,
      material = batch.mesh.material,
      matrices = batch.mesh.instanceMatrix;
    let released = 0;
    geometry.addEventListener('dispose', () => released++);
    for (let cycle = 0; cycle < 30; cycle++) {
      batch.begin();
      for (let i = 0; i < 12; i++) batch.add(i, 0, 0, 1, 1, 1, '#f00', 0.5);
      batch.end();
      expect(batch.count).toBe(8);
      expect(batch.dropped).toBe(4);
      expect(batch.mesh.geometry).toBe(geometry);
      expect(batch.mesh.material).toBe(material);
      expect(batch.mesh.instanceMatrix).toBe(matrices);
      batch.clear();
      expect(batch.mesh.count).toBe(0);
    }
    expect(released).toBe(0);
    batch.dispose();
    batch.dispose();
    expect(released).toBe(1);
  });
  it('keeps two effects instances isolated and stable through long repeated bursts', () => {
    const a = new Effects(),
      b = new Effects(),
      state = createState();
    const initial = a.root.children.map((o) => (o as THREE.Mesh).geometry.uuid);
    b.emit({ type: 'explosion', actorId: 0, position: { x: 0, y: 0 } });
    b.update(0.1, state);
    const other = instanceData(b.root);
    for (let i = 0; i < 600; i++) {
      a.emit({ type: i % 2 ? 'explosion' : 'pickup', actorId: 0, position: { x: 0, y: 0 } });
      a.update(1 / 60, state);
      expect(a.stats().particles).toBeLessThanOrEqual(576);
      expect(a.root.children).toHaveLength(3);
    }
    expect(a.root.children.map((o) => (o as THREE.Mesh).geometry.uuid)).toEqual(initial);
    const frozen = instanceData(a.root);
    for (let i = 0; i < 20; i++) a.update(0, state);
    expect(instanceData(a.root)).toEqual(frozen);
    a.dispose();
    expect(instanceData(b.root)).toEqual(other);
    b.dispose();
  });
  it('merges static transforms while preserving animated and breakable references', () => {
    const root = new THREE.Group(),
      fixed = new THREE.Group(),
      animated = new THREE.Group();
    root.add(fixed, animated);
    fixed.position.set(3, 0, 2);
    const material = new THREE.MeshBasicMaterial({ color: '#f00' });
    const first = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material),
      second = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    second.position.x = 2;
    fixed.add(first, second);
    const moving = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    animated.add(moving);
    let released = 0;
    first.geometry.addEventListener('dispose', () => released++);
    expect(mergeStaticMeshes(root, new Set([animated]))).toBe(2);
    expect(animated.children[0]).toBe(moving);
    expect(moving.parent).toBe(animated);
    const merged = root.children.find((o) => o.name === 'static-batch-2') as THREE.Mesh;
    merged.geometry.computeBoundingBox();
    expect(merged.geometry.boundingBox!.min.x).toBeCloseTo(2.5);
    expect(merged.geometry.boundingBox!.max.x).toBeCloseTo(5.5);
    expect(released).toBe(1);
    animated.visible = false;
    expect(moving.parent!.visible).toBe(false);
    expect(merged.visible).toBe(true);
    merged.geometry.dispose();
    moving.geometry.dispose();
    material.dispose();
  });
  it('does not dispose a shared geometry still used by an excluded animated mesh', () => {
    const root = new THREE.Group(),
      geometry = new THREE.BoxGeometry(),
      material = new THREE.MeshBasicMaterial();
    const a = new THREE.Mesh(geometry, material),
      b = new THREE.Mesh(geometry, material),
      c = new THREE.Mesh(geometry, material);
    root.add(a, b, c);
    let released = 0;
    geometry.addEventListener('dispose', () => released++);
    mergeStaticMeshes(root, new Set([c]));
    expect(released).toBe(0);
    expect(c.geometry).toBe(geometry);
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    material.dispose();
  });
  it('preserves an animated child even when its parent is a static mesh', () => {
    const root = new THREE.Group(),
      material = new THREE.MeshBasicMaterial(),
      parent = new THREE.Mesh(new THREE.BoxGeometry(), material),
      sibling = new THREE.Mesh(new THREE.BoxGeometry(), material),
      animated = new THREE.Mesh(new THREE.BoxGeometry(), material);
    parent.add(animated);
    root.add(parent, sibling);
    mergeStaticMeshes(root, new Set([animated]));
    expect(parent.parent).toBe(root);
    expect(animated.parent).toBe(parent);
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    material.dispose();
  });
});

describe('weapon trails and power effects', () => {
  it('keeps pause samples identical, bounds long trails, and clears teleports/rounds/destruction', () => {
    const state = createState(),
      view = new WeaponsView();
    state.phase = 'playing';
    state.discs = [disc()];
    for (let i = 0; i < 120; i++) {
      state.time = i / 60;
      state.discs[0].previous = { ...state.discs[0].position };
      state.discs[0].position.x += 0.2;
      view.update(state, 1);
    }
    expect(view.stats().segments).toBeGreaterThan(2);
    expect(view.stats().segments).toBeLessThanOrEqual(32);
    const before = instanceData(view.root);
    for (let i = 0; i < 100; i++) view.update(state, 1);
    expect(instanceData(view.root)).toEqual(before);
    state.time += 1 / 60;
    state.discs[0].previous = { x: 0, y: 0 };
    state.discs[0].position = { x: -10, y: 8 };
    view.observe({
      type: 'teleport',
      actorId: 0,
      position: { x: 0, y: 0 },
      entityType: 'disc',
      entityId: 1,
    });
    view.update(state, 1);
    expect(view.stats().segments).toBe(0);
    state.discs = [];
    view.update(state, 1);
    expect(view.stats().trailCount).toBe(0);
    state.round++;
    view.update(state, 1);
    expect(view.stats().segments).toBe(0);
    view.dispose();
    view.dispose();
  });
  it('uses authoritative charge, melee and elemental flags without changing the state', () => {
    const state = createState(),
      view = new WeaponsView();
    state.phase = 'playing';
    state.time = 5;
    state.actors[0].charge = 1;
    state.actors[0].armed = true;
    state.actors[1].attackTime = 0.1;
    state.actors[1].attackArmed = true;
    const before = structuredClone(state);
    view.update(state, 1);
    expect(view.stats().rings).toBe(2);
    expect(view.stats().arcs).toBe(2);
    expect(state).toEqual(before);
    expect(discEffectColor({ ...disc(), powers: ['fire'] })).not.toBe(
      discEffectColor({ ...disc(), powers: ['ice'] }),
    );
    state.actors[0].alive = false;
    state.actors[1].attackTime = 0;
    view.update(state, 1);
    expect(view.stats().rings + view.stats().arcs).toBe(0);
    view.dispose();
  });
  it('renders zones and status markers from one fixed snapshot and clears expired zones', () => {
    const state = createState(),
      view = new PowersView();
    state.time = 5;
    state.zones = [
      {
        id: 1,
        kind: 'fire',
        position: { x: 2, y: 2 },
        ownerId: 0,
        radius: 1,
        remaining: 3,
        duration: 4,
      },
      {
        id: 2,
        kind: 'ice',
        position: { x: -2, y: 2 },
        ownerId: 1,
        radius: 1,
        remaining: 3,
        duration: 4,
      },
    ];
    state.actors[0].burnTime = 2;
    state.actors[1].frozenTime = 2;
    view.update(state);
    const frozen = instanceData(view.root);
    view.update(structuredClone(state));
    expect(instanceData(view.root)).toEqual(frozen);
    expect((frozen[0] as { count: number }).count).toBe(2);
    state.zones = [];
    state.actors[0].burnTime = 0;
    view.update(state);
    expect(instanceData(view.root).every((x) => (x as { count: number }).count === 0)).toBe(true);
    view.dispose();
  });
  it('keeps all large ice-explosion cells visible when decorative crystal capacity is exhausted', () => {
    const state = createState(),
      view = new PowersView();
    state.zones = Array.from({ length: 450 }, (_, i) => ({
      id: i,
      kind: 'ice' as const,
      position: { x: (i % 25) * 0.65 - 8, y: Math.floor(i / 25) * 0.65 - 6 },
      ownerId: 0,
      radius: 0.45,
      remaining: 3,
      duration: 4,
    }));
    view.update(state);
    const batches = instanceData(view.root) as { count: number }[];
    expect(batches[0].count).toBe(450);
    expect(batches[1].count).toBe(450);
    expect(batches[3].count).toBe(256);
    view.dispose();
  });
});
