import * as THREE from 'three';
import { Random } from '../core/math';
import { mapInfo } from '../core/arena';
import { onGround } from '../core/collision';
import type { Arena, Obstacle } from '../core/types';
import { box, cylinder, material, mesh, place, sphere } from './palette';

export interface ArenaView {
  root: THREE.Group;
  obstacles: Map<string, THREE.Group>;
  water: THREE.Mesh;
  flags: THREE.Object3D[];
  portals: Map<string, THREE.Group>;
}

const THEMES = {
  garden: {
    ground: '#a9c977',
    edge: '#8a9b76',
    water: '#76aca7',
    stone: '#a5b29d',
    cap: '#d3d5ba',
    grass: ['#b5d184', '#a0c371', '#bed58d'],
  },
  canal: {
    ground: '#b4c98e',
    edge: '#899c87',
    water: '#60b6ca',
    stone: '#8ca8ad',
    cap: '#c3d6cf',
    grass: ['#b4cf94', '#a6c58c', '#cedba8'],
  },
  sandstone: {
    ground: '#d5be88',
    edge: '#b5986c',
    water: '#80b9b5',
    stone: '#b5a685',
    cap: '#e0d1ab',
    grass: ['#ddc695', '#cdb781', '#e5cda0'],
  },
  ruins: {
    ground: '#a9b4a0',
    edge: '#7d8b85',
    water: '#749faa',
    stone: '#929eaa',
    cap: '#c6c9c2',
    grass: ['#b7bca8', '#9fab9b', '#c5c6af'],
  },
} as const;

function plant(
  parent: THREE.Object3D,
  x: number,
  z: number,
  size: number,
  color: string,
  random: Random,
): void {
  for (let i = 0; i < 3; i++) {
    const leaf = sphere(size * random.range(0.7, 1.1), color, 0);
    leaf.scale.set(1, random.range(0.8, 1.4), 0.8);
    place(
      leaf,
      x + random.range(-size * 0.5, size * 0.5),
      size * 0.6,
      z + random.range(-size * 0.5, size * 0.5),
      parent,
    );
  }
}

function tree(
  parent: THREE.Object3D,
  x: number,
  z: number,
  scale: number,
  blossom: string,
  random: Random,
): void {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.scale.setScalar(scale);
  parent.add(group);
  place(cylinder(0.18, 0.3, 2.4, '#827655', 7), 0, 1.1, 0, group);
  for (let i = 0; i < 6; i++) {
    const angle = i * 2.4;
    const ball = sphere(random.range(0.8, 1.1), blossom, 1);
    ball.scale.y = 0.8;
    place(
      ball,
      Math.sin(angle) * 0.65,
      2.4 + random.range(-0.2, 0.6),
      Math.cos(angle) * 0.65,
      group,
    );
  }
  place(cylinder(0.6, 0.7, 0.14, '#7f965e', 9), 0, 0.04, 0, group);
}

function makeObstacle(obstacle: Obstacle, colors: { stone: string; cap: string }): THREE.Group {
  const root = new THREE.Group();
  root.position.set(obstacle.position.x, 0, obstacle.position.y);
  const w = obstacle.half.x * 2,
    d = obstacle.half.y * 2;
  if (obstacle.kind === 'crate') {
    place(box(w, 0.95, d, '#b58a52'), 0, 0.475, 0, root);
    for (const z of [-d / 2 - 0.015, d / 2 + 0.015]) {
      for (const x of [-w * 0.37, w * 0.37])
        place(box(0.09, 0.9, 0.035, '#d1ae70'), x, 0.47, z, root);
      const diagonal = box(w * 1.15, 0.1, 0.04, '#dfba7a');
      diagonal.rotation.z = 0.76;
      place(diagonal, 0, 0.5, z, root);
    }
    for (const x of [-0.28, 0, 0.28]) place(box(0.25, 0.04, d * 0.9, '#cda269'), x, 0.96, 0, root);
  } else if (obstacle.kind === 'fountain') {
    place(box(w + 0.1, 0.2, d + 0.1, '#9aab92'), 0, 0.1, 0, root);
    place(box(w * 0.9, 0.54, d * 0.9, '#bdc6ab'), 0, 0.42, 0, root);
    place(box(w * 0.92, 0.12, d * 0.92, '#e0ddbc'), 0, 0.75, 0, root);
    const water = box(w * 0.72, 0.04, d * 0.72, '#76c4b7');
    place(water, 0, 0.83, 0, root);
    place(cylinder(0.17, 0.25, 1.05, '#9eaf93', 8), 0, 1.28, 0, root);
    const bud = sphere(0.42, '#e3bd6e', 0);
    bud.scale.y = 1.25;
    place(bud, 0, 1.95, 0, root);
    for (let i = 0; i < 4; i++) {
      const leaf = sphere(0.26, '#8fa36a', 0);
      leaf.scale.set(1.5, 0.3, 0.75);
      leaf.rotation.y = (i * Math.PI) / 2;
      place(
        leaf,
        Math.sin((i * Math.PI) / 2) * 0.25,
        1.61,
        Math.cos((i * Math.PI) / 2) * 0.25,
        root,
      );
    }
  } else {
    place(box(w + 0.08, 0.15, d + 0.08, '#99a78d'), 0, 0.075, 0, root);
    const count = Math.max(1, Math.round(w));
    for (let i = 0; i < count; i++) {
      const block = box(w / count - 0.05, 0.9 + (i % 2) * 0.1, d, colors.stone);
      place(block, -w / 2 + (w / count) * (i + 0.5), 0.55, 0, root);
      place(
        box(w / count - 0.08, 0.08, d * 0.94, colors.cap),
        block.position.x,
        1.03 + (i % 2) * 0.05,
        0,
        root,
      );
    }
  }
  return root;
}

export function createArenaView(arena: Arena): ArenaView {
  const colors = THEMES[mapInfo(arena.id).theme];
  const root = new THREE.Group(),
    random = new Random(97531),
    flags: THREE.Object3D[] = [];
  const shape = new THREE.Shape();
  const x = arena.halfWidth,
    y = arena.halfHeight;
  shape.moveTo(-x, -y);
  shape.lineTo(x, -y);
  shape.lineTo(x, y);
  shape.lineTo(-x, y);
  shape.closePath();
  for (const pit of arena.pits) {
    const p = new THREE.Path();
    p.moveTo(pit.position.x - pit.half.x, -pit.position.y - pit.half.y);
    p.lineTo(pit.position.x - pit.half.x, -pit.position.y + pit.half.y);
    p.lineTo(pit.position.x + pit.half.x, -pit.position.y + pit.half.y);
    p.lineTo(pit.position.x + pit.half.x, -pit.position.y - pit.half.y);
    p.closePath();
    shape.holes.push(p);
  }
  const groundGeo = new THREE.ExtrudeGeometry(shape, {
    depth: 1.05,
    bevelEnabled: false,
    steps: 1,
  });
  groundGeo.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(groundGeo, [material(colors.ground), material(colors.edge)]);
  ground.position.y = -1.05;
  ground.receiveShadow = true;
  ground.castShadow = true;
  root.add(ground);
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: colors.water, roughness: 0.28, metalness: 0.12 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = -0.48;
  water.receiveShadow = true;
  root.add(water);

  // Broken stone edging communicates the walkable footprint, without enclosing it.
  for (let i = -x + 1; i <= x - 1; i += 1.3)
    for (const side of [-1, 1]) {
      const block = box(1.15, 0.42, 0.42, random.pick(['#c2c6aa', '#b6bfa3', '#cdd1b7']));
      place(block, i, -0.1, side * (y - 0.15), root);
    }
  for (let i = -y + 1; i <= y - 1; i += 1.3)
    for (const side of [-1, 1])
      place(box(0.42, 0.42, 1.15, '#c1c9ae'), side * (x - 0.15), -0.1, i, root);
  for (let i = 0; i < 85; i++) {
    const px = random.range(-x + 0.4, x - 0.4),
      pz = random.range(-y + 0.4, y - 0.4);
    if (!onGround(arena, { x: px, y: pz }, 0.2)) continue;
    const patch = mesh(
      new THREE.CircleGeometry(random.range(0.12, 0.5), 5),
      random.pick(colors.grass),
    );
    patch.rotation.x = -Math.PI / 2;
    patch.rotation.z = random.range(0, 6);
    patch.position.set(px, 0.012, pz);
    patch.receiveShadow = true;
    patch.castShadow = false;
    root.add(patch);
  }
  // Worn stepping stones across two routes through the arena.
  for (let i = -5; i <= 5; i++) {
    if (Math.abs(i) < 2) continue;
    if (!onGround(arena, { x: i * 1.35, y: 0.7 * Math.sin(i) }, 0.5)) continue;
    const slab = cylinder(0.4, 0.43, 0.035, '#cbd5a6', 6);
    slab.scale.z = 0.6;
    slab.rotation.y = random.range(0, 3);
    place(slab, i * 1.35, 0.02, 0.7 * Math.sin(i), root);
  }
  const obstacles = new Map<string, THREE.Group>();
  for (const obstacle of arena.obstacles) {
    const view = makeObstacle(obstacle, colors);
    root.add(view);
    obstacles.set(obstacle.id, view);
  }
  for (const [px, pz, scale, color] of [
    [-x + 1.3, -y + 1.4, 0.94, '#d7a190'],
    [x - 1.3, y - 1.3, 0.75, '#d8ab92'],
    [x - 1.7, -y + 1.2, 0.8, '#6c9f68'],
    [-x + 1.6, y - 1.2, 0.7, '#7aa66b'],
  ] as const)
    tree(root, px, pz, scale, color, random);
  for (const side of [-1, 1])
    for (let i = 0; i < 9; i++) {
      plant(
        root,
        random.range(-x + 1, x - 1),
        side * random.range(y - 0.9, y - 0.4),
        random.range(0.15, 0.35),
        random.pick(['#6f9e59', '#85ad60', '#c5c976']),
        random,
      );
    }
  for (const pit of arena.pits) {
    for (let i = 0; i < 3; i++) {
      const lily = cylinder(0.21, 0.21, 0.035, '#80b57e', 7);
      place(
        lily,
        pit.position.x + random.range(-pit.half.x * 0.6, pit.half.x * 0.6),
        -0.44,
        pit.position.y + random.range(-pit.half.y * 0.6, pit.half.y * 0.6),
        root,
      );
    }
    for (const side of [-1, 1])
      place(
        box(pit.half.x * 2 + 0.2, 0.14, 0.2, '#b7c3a0'),
        pit.position.x,
        -0.02,
        pit.position.y + side * pit.half.y,
        root,
      );
  }
  for (const side of [-1, 1]) {
    place(cylinder(0.06, 0.08, 2.9, '#7d8061', 6), side * 10, 1.35, side * 7, root);
    const flag = mesh(new THREE.PlaneGeometry(0.7, 0.9), side === -1 ? '#e1aa78' : '#a19dc0');
    flag.material = material(side === -1 ? '#e1aa78' : '#a19dc0').clone();
    flag.material.userData.shared = false;
    (flag.material as THREE.Material).side = THREE.DoubleSide;
    place(flag, side * 10 + 0.4, 2.3, side * 7, root);
    flags.push(flag);
  }
  // Quiet surrounding islands frame the playable diorama.
  for (const [px, pz] of [
    [-18, -4],
    [18, 2],
    [-9, -15],
    [8, 14],
  ]) {
    const island = cylinder(2.2, 2, 0.7, '#92af85', 7);
    place(island, px, -0.5, pz, root);
    plant(root, px, pz, 1.2, '#78a481', random);
  }
  const portals = new Map<string, THREE.Group>();
  for (const portal of arena.portals ?? []) {
    const group = new THREE.Group();
    group.position.set(portal.position.x, 0, portal.position.y);
    group.name = portal.id;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(portal.radius * 0.63, portal.radius, 36),
      new THREE.MeshBasicMaterial({
        color: portal.color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    group.add(ring);
    const core = new THREE.Mesh(
      new THREE.CircleGeometry(portal.radius * 0.62, 32),
      new THREE.MeshBasicMaterial({
        color: portal.color,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      }),
    );
    core.rotation.x = -Math.PI / 2;
    core.position.y = 0.045;
    group.add(core);
    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 2;
      const marker = cylinder(0.09, 0.14, 0.34, portal.color, 4);
      place(
        marker,
        Math.cos(angle) * (portal.radius + 0.12),
        0.17,
        Math.sin(angle) * (portal.radius + 0.12),
        group,
      );
    }
    const arrow = mesh(new THREE.ConeGeometry(0.16, 0.3, 3), portal.color);
    arrow.rotation.z = (-Math.PI / 2) * portal.direction.x;
    place(
      arrow,
      portal.direction.x * (portal.radius + 0.4),
      0.17,
      portal.direction.y * (portal.radius + 0.4),
      group,
    );
    root.add(group);
    portals.set(portal.id, group);
  }
  return { root, obstacles, water, flags, portals };
}
