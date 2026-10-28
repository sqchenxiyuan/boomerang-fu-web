import * as THREE from 'three';
import { ROSTER } from '../core/config';
import type { Actor } from '../core/types';
import { box, cylinder, mesh, place, sphere } from './palette';

export interface DeathModel {
  root: THREE.Group;
  stump: THREE.Group;
  piece: THREE.Group;
  squash: THREE.Group;
}

function cutSurface(radius: number, color: string, parent: THREE.Group, upward: boolean): void {
  const surface = mesh(new THREE.CircleGeometry(radius, 20), color);
  surface.rotation.x = upward ? -Math.PI / 2 : Math.PI / 2;
  surface.position.y = upward ? 0.002 : -0.002;
  parent.add(surface);
}

function roundHalf(radius: number, color: string, upper: boolean): THREE.Mesh {
  return mesh(
    new THREE.SphereGeometry(radius, 20, 10, 0, Math.PI * 2, upper ? 0 : Math.PI / 2, Math.PI / 2),
    color,
  );
}

function deadFace(parent: THREE.Group, z: number, y = -0.22): void {
  for (const x of [-0.18, 0.18])
    for (const sign of [-1, 1]) {
      const stroke = box(0.13, 0.025, 0.018, '#33443a');
      stroke.rotation.z = (sign * Math.PI) / 4;
      place(stroke, x, y, z, parent);
    }
  place(box(0.09, 0.025, 0.02, '#33443a'), 0, y - 0.11, z, parent);
}

function melonHalf(parent: THREE.Group, upper: boolean): void {
  const shape = new THREE.Shape();
  if (upper) {
    shape.moveTo(-0.51, 0);
    shape.lineTo(0, 0.87);
    shape.lineTo(0.51, 0);
    shape.closePath();
  } else {
    shape.moveTo(-0.51, 0);
    shape.lineTo(0.51, 0);
    shape.lineTo(0.7, -0.3);
    shape.quadraticCurveTo(0, -0.8, -0.7, -0.3);
    shape.closePath();
  }
  const rind = mesh(
    new THREE.ExtrudeGeometry(shape, { depth: 0.44, bevelEnabled: false }),
    '#418f65',
  );
  rind.position.z = -0.22;
  parent.add(rind);
  for (const side of [-1, 1]) {
    const flesh = mesh(new THREE.ShapeGeometry(shape), '#ed8179');
    flesh.scale.set(0.87, 0.9, 1);
    flesh.position.z = side * 0.225;
    if (side < 0) flesh.rotation.y = Math.PI;
    parent.add(flesh);
  }
  place(box(1, 0.025, 0.42, '#f7b19a'), 0, 0, 0, parent);
  for (const x of [-0.22, 0.22]) {
    const seed = sphere(0.035, '#513e35', 0);
    seed.scale.y = 1.6;
    place(seed, x, upper ? 0.24 : -0.26, 0.235, parent);
  }
}

/** These meshes are our own fixed cut shapes, following the original prefab swap
 * semantics. No original game meshes/textures and no runtime arbitrary mesh cut. */
export function createDeathModel(actor: Actor): DeathModel {
  const profile = ROSTER[actor.id] ?? ROSTER[0];
  const root = new THREE.Group(),
    stump = new THREE.Group(),
    piece = new THREE.Group(),
    squash = new THREE.Group();
  root.add(stump, piece, squash);
  root.visible = false;
  if (profile.kind === 'melon') {
    melonHalf(stump, false);
    melonHalf(piece, true);
    deadFace(stump, 0.247);
  } else if (profile.kind === 'milk') {
    place(box(0.88, 0.58, 0.64, '#e9f0df'), 0, -0.29, 0, stump);
    place(box(0.9, 0.28, 0.66, '#83bbd4'), 0, -0.43, 0, stump);
    place(box(0.76, 0.025, 0.54, '#fffbea'), 0, 0.015, 0, stump);
    place(box(0.88, 0.58, 0.64, '#e9f0df'), 0, 0.29, 0, piece);
    const roof = cylinder(0, 0.64, 0.38, '#a7cfe0', 4);
    roof.rotation.y = Math.PI / 4;
    roof.scale.z = 0.72;
    place(roof, 0, 0.75, 0, piece);
    deadFace(stump, 0.33);
  } else {
    const eggplant = profile.kind === 'eggplant';
    const color = eggplant ? '#8b66b2' : '#f3af4b';
    const cutColor = eggplant ? '#e3e4ba' : '#ffe3a1';
    stump.add(roundHalf(0.62, color, false));
    piece.add(roundHalf(0.62, color, true));
    cutSurface(0.6, cutColor, stump, true);
    cutSurface(0.6, cutColor, piece, false);
    if (eggplant) {
      for (const part of [stump, piece])
        for (const child of part.children) child.scale.set(0.8, 1.25, 0.77);
      const cap = sphere(0.31, '#5b9a65', 0);
      cap.scale.set(1.2, 0.4, 1.2);
      place(cap, 0, 0.69, 0, piece);
      const stem = cylinder(0.07, 0.12, 0.38, '#497955', 6);
      stem.rotation.z = -0.3;
      place(stem, 0.05, 0.87, 0, piece);
    } else {
      place(cylinder(0.055, 0.08, 0.22, '#7c7643', 5), 0, 0.64, 0, piece);
      const leaf = sphere(0.22, '#5c9861', 0);
      leaf.scale.set(1.7, 0.25, 0.7);
      place(leaf, 0.2, 0.65, 0, piece);
      for (let i = 0; i < 8; i++) {
        const vein = box(0.45, 0.008, 0.012, '#fff1c9');
        vein.rotation.y = (i * Math.PI) / 4;
        place(vein, 0, 0.007, 0, stump);
      }
    }
    deadFace(stump, eggplant ? 0.465 : 0.58);
  }
  for (const x of [-0.28, 0.28]) {
    const shoe = sphere(0.17, '#344e3c', 0);
    shoe.scale.set(1, 0.6, 1.2);
    place(shoe, x, -0.56, 0, stump);
  }
  const burnt = sphere(0.62, '#61584a', 1);
  burnt.scale.set(1.15, 0.8, 0.95);
  squash.add(burnt);
  for (let i = 0; i < 5; i++) {
    const lump = sphere(0.22, i % 2 ? '#6d6351' : profile.color, 0);
    place(lump, Math.sin(i * 1.3) * 0.52, -0.1, Math.cos(i * 1.3) * 0.4, squash);
  }
  // Face is placed on top so it remains readable after the vertical squash.
  const face = new THREE.Group();
  deadFace(face, 0.025, 0);
  face.rotation.x = -Math.PI / 2;
  face.position.y = 0.55;
  squash.add(face);
  return { root, stump, piece, squash };
}
