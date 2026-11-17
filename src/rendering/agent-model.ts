import * as THREE from 'three';
import { lookPalette, runBounds, type AgentLook } from '../agents/look';

/*
 * Voxel agent body, after MUNDI agent-world.js build()/voxelizeTex(): the drawn
 * silhouette becomes a run-length merged block head, set on a small block torso.
 * Everything is one vertex-coloured mesh per part, in the character's body-local
 * frame (+z faces forward, +y up, origin at the body centre).
 */
export const AGENT_LAYOUT = {
  /** Largest head dimension. The default fruit bodies are about 1.2 units across. */
  headSize: 1.18,
  headDepth: 0.34,
  /** Body-local y of the head's lowest voxel row. */
  headBase: -0.2,
  torso: { w: 0.62, h: 0.44, d: 0.4, y: -0.42 },
  /** Shoulder anchors for the existing arm rig. */
  shoulder: { x: 0.36, y: -0.3 },
  /** Fraction of the head height below the slice plane. */
  cut: 0.3,
} as const;

export interface Block {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  front: string;
  side: string;
  back: string;
}

/** Head blocks from the stored voxel runs, plus the torso. */
export function agentBlocks(look: AgentLook): { blocks: Block[]; headTop: number; cutY: number } {
  const L = AGENT_LAYOUT,
    pal = lookPalette(look.hue),
    blocks: Block[] = [];
  const bounds = runBounds(look.runs);
  let headTop = L.headBase;
  if (bounds) {
    const bw = bounds.x1 - bounds.x0 + 1,
      bh = bounds.y1 - bounds.y0 + 1,
      cell = L.headSize / Math.max(bw, bh),
      cx = (bounds.x0 + bounds.x1 + 1) / 2;
    for (const [x, y, w, color] of look.runs)
      blocks.push({
        x: (x + w / 2 - cx) * cell,
        y: L.headBase + (bounds.y1 - y + 0.5) * cell,
        z: 0,
        w: w * cell + 0.004,
        h: cell + 0.004,
        d: L.headDepth,
        front: color,
        side: color,
        back: pal.back,
      });
    headTop = L.headBase + bh * cell;
  }
  const T = L.torso;
  blocks.push({ ...T, x: 0, z: 0, front: pal.body, side: pal.body, back: pal.body });
  blocks.push({
    x: 0,
    y: T.y + 0.02,
    z: T.d / 2 + 0.006,
    w: T.w * 0.46,
    h: T.h * 0.5,
    d: 0.012,
    front: pal.belly,
    side: pal.belly,
    back: pal.belly,
  });
  const cutY = L.headBase + (headTop - L.headBase) * L.cut;
  return { blocks, headTop, cutY };
}

// Corner order per face: two triangles, counter-clockwise seen from outside.
const FACES: { n: [number, number, number]; c: [number, number, number][]; key: keyof Block }[] = [
  {
    n: [0, 0, 1],
    c: [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
    key: 'front',
  },
  {
    n: [0, 0, -1],
    c: [
      [1, -1, -1],
      [-1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
    ],
    key: 'back',
  },
  {
    n: [1, 0, 0],
    c: [
      [1, -1, 1],
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
    ],
    key: 'side',
  },
  {
    n: [-1, 0, 0],
    c: [
      [-1, -1, -1],
      [-1, -1, 1],
      [-1, 1, 1],
      [-1, 1, -1],
    ],
    key: 'side',
  },
  {
    n: [0, 1, 0],
    c: [
      [-1, 1, 1],
      [1, 1, 1],
      [1, 1, -1],
      [-1, 1, -1],
    ],
    key: 'side',
  },
  {
    n: [0, -1, 0],
    c: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
    ],
    key: 'side',
  },
];

/** One non-indexed, flat-shaded geometry for many coloured boxes. */
export function blocksGeometry(blocks: readonly Block[]): THREE.BufferGeometry {
  const positions = new Float32Array(blocks.length * 36 * 3),
    normals = new Float32Array(blocks.length * 36 * 3),
    colors = new Float32Array(blocks.length * 36 * 3);
  const color = new THREE.Color();
  let v = 0;
  for (const b of blocks)
    for (const face of FACES) {
      // Color.set converts sRGB hex into the linear working space vertex colours expect.
      color.set(b[face.key] as string);
      for (const corner of [0, 1, 2, 0, 2, 3]) {
        const [sx, sy, sz] = face.c[corner];
        positions.set([b.x + (sx * b.w) / 2, b.y + (sy * b.h) / 2, b.z + (sz * b.d) / 2], v * 3);
        normals.set(face.n, v * 3);
        colors.set([color.r, color.g, color.b], v * 3);
        v++;
      }
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

let voxelMaterial: THREE.MeshStandardMaterial | null = null;
function sharedMaterial(): THREE.MeshStandardMaterial {
  if (!voxelMaterial) {
    voxelMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      flatShading: true,
    });
    voxelMaterial.userData.shared = true;
  }
  return voxelMaterial;
}

function voxelMesh(blocks: readonly Block[]): THREE.Mesh {
  const mesh = new THREE.Mesh(blocksGeometry(blocks), sharedMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** The living body visual: head and torso in one mesh. */
export function createAgentBody(look: AgentLook): THREE.Mesh {
  const mesh = voxelMesh(agentBlocks(look).blocks);
  mesh.name = 'agent-body';
  return mesh;
}

/** Slice halves for the weapon death: the cut runs through the lower head. */
export function createAgentHalves(look: AgentLook): { stump: THREE.Mesh; piece: THREE.Mesh } {
  const { blocks, cutY } = agentBlocks(look),
    pal = lookPalette(look.hue);
  const below = blocks.filter((b) => b.y < cutY),
    above = blocks.filter((b) => b.y >= cutY);
  const width = Math.max(0.2, ...above.map((b) => Math.abs(b.x) * 2 + b.w)) * 0.92;
  const plate = (y: number): Block => ({
    x: 0,
    y,
    z: 0,
    w: Math.min(width, AGENT_LAYOUT.headSize),
    h: 0.02,
    d: AGENT_LAYOUT.headDepth * 0.9,
    front: pal.light,
    side: pal.light,
    back: pal.light,
  });
  return {
    stump: voxelMesh([...below, plate(cutY - 0.01)]),
    piece: voxelMesh([...above, plate(cutY + 0.01)]),
  };
}
