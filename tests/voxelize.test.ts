import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ROSTER } from '../src/core/config';
import { actorColor, actorName, actorToken, clearAgents } from '../src/agents/registry';
import {
  buildVoxelGeometry,
  voxelEligible,
  voxelizeMesh,
  voxelizeStatic,
} from '../src/rendering/voxelize';

const cell = (size: number) => new THREE.Vector3(size, size, size);
interface Quad {
  material: number;
  normal: number[];
  min: THREE.Vector3;
  max: THREE.Vector3;
}
/** Every quad (two triangles, six vertices) with its material and extent. */
function quads(geometry: THREE.BufferGeometry): Quad[] {
  const position = geometry.getAttribute('position'),
    normal = geometry.getAttribute('normal');
  const out: Quad[] = [];
  for (const group of geometry.groups)
    for (let q = group.start; q < group.start + group.count; q += 6) {
      const box = new THREE.Box3();
      for (let k = 0; k < 6; k++)
        box.expandByPoint(new THREE.Vector3().fromBufferAttribute(position, q + k));
      out.push({
        material: group.materialIndex!,
        normal: [normal.getX(q), normal.getY(q), normal.getZ(q)],
        min: box.min,
        max: box.max,
      });
    }
  return out;
}
/** Quads lying on the outside of a bounding box (surface voxels are hollow shells). */
const outer = (all: Quad[], box: THREE.Box3) =>
  all.filter((quad) =>
    [0, 1, 2].some(
      (axis) =>
        quad.normal[axis] !== 0 &&
        quad.min.getComponent(axis) ===
          (quad.normal[axis] > 0 ? box.max : box.min).getComponent(axis),
    ),
  );

describe('voxel converter', () => {
  it('turns a box into one greedy quad per side on the cell grid', () => {
    const geometry = buildVoxelGeometry(
      [{ geometry: new THREE.BoxGeometry(1, 1, 1), materialMap: () => 0, vertexColors: false }],
      { cell: cell(0.25) },
    )!;
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.toArray()).toEqual([-0.5, -0.5, -0.5]);
    expect(geometry.boundingBox!.max.toArray()).toEqual([0.5, 0.5, 0.5]);
    const surface = outer(quads(geometry), geometry.boundingBox!);
    expect(surface).toHaveLength(6);
    for (const quad of surface)
      expect(quad.max.clone().sub(quad.min).toArray().sort()).toEqual([0, 1, 1]);
  });

  it('gives each cube face the material of the best-aligned source triangle', () => {
    // BoxGeometry groups: +x, −x, +y, −y, +z, −z use material 0…5.
    const geometry = buildVoxelGeometry(
      [{ geometry: new THREE.BoxGeometry(1, 1, 1), materialMap: (i) => i, vertexColors: false }],
      { cell: cell(0.25) },
    )!;
    const axes = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    geometry.computeBoundingBox();
    const surface = outer(quads(geometry), geometry.boundingBox!);
    expect(surface).toHaveLength(6);
    for (const quad of surface) expect(quad.normal).toEqual(axes[quad.material]);
  });

  it('keeps a floor top at y = 0, culls bottoms and clips to bounds', () => {
    const slab = new THREE.BoxGeometry(4, 0.5, 4).translate(0, -0.25, 0);
    const geometry = buildVoxelGeometry(
      [{ geometry: slab, materialMap: () => 0, vertexColors: false }],
      {
        cell: cell(0.25),
        cullDown: true,
        bounds: new THREE.Box3(new THREE.Vector3(-1, -5, -5), new THREE.Vector3(5, 5, 5)),
      },
    )!;
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.y).toBe(0);
    expect(geometry.boundingBox!.min.x).toBe(-1);
    const normal = geometry.getAttribute('normal');
    for (let i = 0; i < normal.count; i++) expect(normal.getY(i)).not.toBe(-1);
  });

  it('converts meshes in place and shares voxels of identical primitives', () => {
    const material = new THREE.MeshStandardMaterial({ color: '#aa8855' });
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), material);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), material);
    const parent = new THREE.Group();
    parent.add(a, b);
    expect(voxelizeMesh(a, 0.1)).toBe(true);
    expect(voxelizeMesh(b, 0.1)).toBe(true);
    expect(a.geometry).toBe(b.geometry);
    expect(a.geometry.userData.shared).toBe(true);
    expect(a.parent).toBe(parent);
    expect(a.material).toBe(material);
    // Glass, glows and already converted meshes are left alone.
    expect(voxelEligible(a)).toBe(false);
    const glass = new THREE.Mesh(
      new THREE.SphereGeometry(1),
      new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3 }),
    );
    expect(voxelEligible(glass)).toBe(false);
  });

  it('merges static pieces into one grid so touching faces disappear', () => {
    const root = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: '#888888' });
    for (const x of [-0.5, 0.5]) {
      const block = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), stone);
      block.position.set(x, 0.5, 0);
      root.add(block);
    }
    const merged = voxelizeStatic(root, 0.25)!;
    expect(root.children).toEqual([merged]);
    merged.geometry.computeBoundingBox();
    // Outside it reads as one 2×1×1 block with no seam: five quads, none below.
    const surface = outer(quads(merged.geometry), merged.geometry.boundingBox!);
    expect(surface).toHaveLength(5);
    expect(surface.some((quad) => quad.normal[1] === -1)).toBe(false);
    const top = surface.find((quad) => quad.normal[1] === 1)!;
    expect([top.min.x, top.max.x, top.min.z, top.max.z]).toEqual([-1, 1, -0.5, 0.5]);
    expect((merged.material as THREE.MeshStandardMaterial[])[0].map).toBeTruthy();
  });
});

describe('default roster', () => {
  it('uses four atelier presets instead of the fruit characters', () => {
    clearAgents();
    expect(ROSTER.map((entry) => entry.name)).toEqual(['红豆', '紫影', '芝士', '薄荷']);
    expect(actorName(2)).toBe('芝士');
    expect(actorColor(3)).toBe('#38d1dc');
    expect(actorToken(1)).toBe('紫');
    expect(new Set(ROSTER.map((entry) => entry.seed)).size).toBe(4);
  });
});
