import * as THREE from 'three';
import type { Actor } from '../core/types';
import { box, place, sphere } from './palette';
import { actorIdentity, type ActorIdentity } from '../agents/registry';
import { lookPalette } from '../agents/look';
import { defaultLook } from '../agents/defaults';
import { createAgentHalves } from './agent-model';

export interface DeathModel {
  root: THREE.Group;
  stump: THREE.Group;
  piece: THREE.Group;
  squash: THREE.Group;
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

/** These meshes are our own fixed cut shapes, following the original prefab swap
 * semantics. No original game meshes/textures and no runtime arbitrary mesh cut. */
export function createDeathModel(
  actor: Actor,
  identity: ActorIdentity = actorIdentity(actor.id),
): DeathModel {
  const root = new THREE.Group(),
    stump = new THREE.Group(),
    piece = new THREE.Group(),
    squash = new THREE.Group();
  root.add(stump, piece, squash);
  root.visible = false;
  const look = identity.look ?? defaultLook(actor.id);
  if (look) {
    const halves = createAgentHalves(look);
    stump.add(halves.stump);
    piece.add(halves.piece);
  } else {
    place(box(0.8, 0.55, 0.5, identity.color), 0, -0.28, 0, stump);
    place(box(0.8, 0.55, 0.5, identity.color), 0, 0.28, 0, piece);
    deadFace(stump, 0.26);
  }
  for (const x of [-0.28, 0.28]) {
    const shoe = sphere(0.17, lookPalette(look?.hue ?? identity.color).dark, 0);
    shoe.scale.set(1, 0.6, 1.2);
    place(shoe, x, -0.56, 0, stump);
  }
  const burnt = sphere(0.62, '#61584a', 1);
  burnt.scale.set(1.15, 0.8, 0.95);
  squash.add(burnt);
  for (let i = 0; i < 5; i++) {
    const lump = sphere(0.22, i % 2 ? '#6d6351' : identity.color, 0);
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
