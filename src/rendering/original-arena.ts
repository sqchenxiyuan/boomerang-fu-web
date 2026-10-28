import * as THREE from 'three';
import type { Arena, Floor, Obstacle, Portal, EnvironmentMechanism } from '../core/types';
import type { Vec2 } from '../core/math';
import type { ArenaView } from './arena-view';
import { box, cylinder, material, place, sphere } from './palette';
import { contourShapes, extrudeContours, rectanglePath } from './polygon-geometry';
import { mergeStaticMeshes } from './batches';
import { OriginalPlantsView } from './original-plants';

const warningColor = new THREE.Color('#f0a267');

function syncPose(
  group: THREE.Group,
  position: Vec2,
  angle: number,
  mechanism: EnvironmentMechanism | undefined,
  alpha: number,
): void {
  let x = position.x,
    z = position.y,
    turn = angle;
  if (mechanism?.previous) {
    const currentAngle = mechanism.angle ?? 0;
    const previousAngle = mechanism.previousAngle ?? currentAngle;
    const delta = (previousAngle - currentAngle) * (1 - alpha);
    const dx = x - mechanism.position.x,
      dz = z - mechanism.position.y;
    x =
      mechanism.previous.x +
      (mechanism.position.x - mechanism.previous.x) * alpha +
      dx * Math.cos(delta) -
      dz * Math.sin(delta);
    z =
      mechanism.previous.y +
      (mechanism.position.y - mechanism.previous.y) * alpha +
      dx * Math.sin(delta) +
      dz * Math.cos(delta);
    turn += delta;
  }
  group.position.x = x;
  group.position.z = z;
  group.rotation.y = -turn;
}

function heightDelta(
  mechanism: EnvironmentMechanism | undefined,
  alpha: number,
  mechanisms: Map<string, EnvironmentMechanism>,
): number | undefined {
  let delta: number | undefined;
  const visited = new Set<string>();
  while (mechanism && !visited.has(mechanism.id)) {
    visited.add(mechanism.id);
    if (mechanism.height !== undefined) {
      const previous = mechanism.previousHeight ?? mechanism.height;
      const initial = mechanism.initialHeight ?? mechanism.height;
      delta = (delta ?? 0) + previous + (mechanism.height - previous) * alpha - initial;
    }
    mechanism = mechanism.parentId ? mechanisms.get(mechanism.parentId) : undefined;
  }
  return delta;
}

const STYLES = {
  garden: { ground: '#b5d679', edge: '#788f9e', wall: '#7d91bc', cap: '#b3c5d9', water: '#65aab8' },
  temple: { ground: '#d7c98f', edge: '#a99c77', wall: '#a6aa91', cap: '#d7d2b1', water: '#6fa9a0' },
  water: { ground: '#8b9aaf', edge: '#687d94', wall: '#879bad', cap: '#b9c8c9', water: '#579dab' },
} as const;

function styleFor(arena: Arena) {
  const scene = arena.sourceScene ?? '';
  if (/falling|cloud|island|pier|bridge|river/i.test(scene)) return STYLES.water;
  if (/crate|raft|cog|temple|trap|shrine|market|henge|jungle/i.test(scene)) return STYLES.temple;
  return STYLES.garden;
}

function floorColors(
  floor: Floor,
  style: ReturnType<typeof styleFor>,
  scene: string,
): [string, string] {
  if (floor.kind === 'ice') return ['#a3d8e2', '#759da8'];
  if (floor.kind === 'wood' || (floor.kind === 'moving' && floor.radius === undefined))
    return ['#b99569', '#826947'];
  if (floor.kind === 'moving') return ['#c5c69b', '#8c9675'];
  if (floor.kind === 'falling')
    return style === STYLES.temple ? ['#aaa886', '#777861'] : ['#8d9fb8', '#607a95'];
  if (/(?:^|\/)Level(?:Island|MiniIsland|Clouds|CloudSweep|Bridges|Mist)(?:\.unity)?$/i.test(scene))
    return ['#b5d679', '#788f9e'];
  return [style.ground, style.edge];
}

function makeFloor(floor: Floor, style: ReturnType<typeof styleFor>, scene: string): THREE.Group {
  const root = new THREE.Group();
  root.name = `floor:${floor.id}`;
  const [topColor, sideColor] = floorColors(floor, style, scene);
  const thickness = floor.kind === 'wood' || floor.kind === 'moving' ? 0.34 : 0.68;
  const geometry = extrudeContours(floor.paths, thickness);
  geometry.translate(0, -thickness, 0);
  const animated =
    floor.mechanismId ||
    floor.kind === 'falling' ||
    floor.kind === 'moving' ||
    !floor.active ||
    floor.warning;
  const top = animated ? material(topColor).clone() : material(topColor);
  if (animated) top.userData.shared = false;
  const baseColor = new THREE.Color(topColor);
  if (floor.kind === 'falling') {
    const seed = [...floor.id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 0);
    baseColor.offsetHSL(0, 0, ((Math.abs(seed) % 7) - 3) * 0.013);
    top.color.copy(baseColor);
  }
  const mesh = new THREE.Mesh(geometry, [top, material(sideColor)]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (geometry.getAttribute('position')?.count) root.add(mesh);
  else {
    geometry.dispose();
    if (animated) top.dispose();
  }
  root.userData.topMaterial = top;
  root.userData.baseColor = baseColor;
  root.userData.floorId = floor.id;
  if (floor.kind === 'moving' && floor.radius !== undefined && floor.radius > 0.3) {
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(floor.radius - 0.12, floor.radius - 0.025, 48),
      material('#91997a'),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.012;
    rim.receiveShadow = true;
    root.add(rim);
  }
  return root;
}

function obstacleColors(obstacle: Obstacle, style: ReturnType<typeof styleFor>): [string, string] {
  const description = obstacle.material ?? '';
  if (/wood|crate|bamboo/i.test(description) || obstacle.kind === 'crate')
    return ['#b79262', '#d9ba87'];
  if (/ice/i.test(description)) return ['#90c9dc', '#c0e8e9'];
  return [style.wall, style.cap];
}

function makeOriginalObstacle(obstacle: Obstacle, style: ReturnType<typeof styleFor>): THREE.Group {
  const root = new THREE.Group();
  root.name = `obstacle:${obstacle.id}`;
  const [side, top] = obstacleColors(obstacle, style);
  const height = Math.max(0.04, obstacle.height ?? (obstacle.kind === 'crate' ? 0.95 : 1.05));
  if (/^(tree|bamboo|shrub)$/i.test(obstacle.material ?? '')) {
    const plant = obstacle.material!.toLowerCase();
    const stemHeight =
      plant === 'tree' ? height * 0.58 : plant === 'bamboo' ? height : height * 0.3;
    const trunk = new THREE.Mesh(
      extrudeContours(
        obstacle.paths ?? rectanglePath(obstacle.half.x, obstacle.half.y),
        stemHeight,
      ),
      material(plant === 'bamboo' ? '#668d56' : '#917853'),
    );
    trunk.castShadow = trunk.receiveShadow = true;
    if (trunk.geometry.getAttribute('position')?.count) root.add(trunk);
    else trunk.geometry.dispose();
    if (plant === 'shrub') {
      const tint = /orange/i.test(obstacle.sourceName ?? '')
        ? '#c9a351'
        : /red|pink/i.test(obstacle.sourceName ?? '')
          ? '#bd6e77'
          : '#76a956';
      const length = Math.max(0.45, height * 0.85, Math.max(obstacle.half.x, obstacle.half.y) * 2);
      for (let i = 0; i < 6; i++) {
        const fan = new THREE.Group();
        fan.rotation.y = (i * Math.PI) / 3;
        const leaf = sphere(1, tint, 0);
        leaf.scale.set(length * 0.62, height * 0.12, length * 0.22);
        leaf.rotation.z = Math.min(0.4, Math.atan2(height * 0.22, length * 0.62));
        place(leaf, length * 0.32, height * 0.65, 0, fan);
        root.add(fan);
      }
      mergeStaticMeshes(root);
    } else if (plant === 'bamboo') {
      const radius = Math.max(0.08, Math.min(obstacle.half.x, obstacle.half.y));
      for (let i = 1; i < 5; i++)
        place(
          cylinder(radius * 1.1, radius * 1.1, 0.045, '#a2b878', 8),
          0,
          (height * i) / 5,
          0,
          root,
        );
      for (const side of [-1, 1]) {
        const leaf = sphere(0.28, '#7aa361', 0);
        leaf.scale.set(1.2, 0.2, 0.45);
        leaf.rotation.z = side * 0.45;
        place(leaf, side * 0.24, height * 0.7, 0, root);
      }
    } else {
      const tint = /pink|cherry|sakura|red|autumn/i.test(obstacle.sourceName ?? '')
        ? '#ce9b9a'
        : '#8cbd72';
      const radius = Math.max(
        0.25,
        plant === 'tree' ? height * 0.29 : Math.max(obstacle.half.x, obstacle.half.y),
      );
      const crown = sphere(radius, tint, 1);
      const crownHeight = plant === 'tree' ? height * 0.32 : height * 0.6;
      crown.scale.y = crownHeight / radius;
      place(crown, 0, height - crownHeight, 0, root);
    }
    return root;
  }
  let geometry: THREE.BufferGeometry;
  if (obstacle.radius !== undefined) {
    geometry = new THREE.CylinderGeometry(obstacle.radius, obstacle.radius, height, 20);
    geometry.translate(0, height / 2, 0);
    const mesh = new THREE.Mesh(geometry, [material(side), material(top), material(side)]);
    mesh.castShadow = mesh.receiveShadow = true;
    if (geometry.getAttribute('position')?.count) root.add(mesh);
    else geometry.dispose();
  } else {
    geometry = extrudeContours(
      obstacle.paths ?? rectanglePath(obstacle.half.x, obstacle.half.y),
      height,
    );
    const mesh = new THREE.Mesh(geometry, [material(top), material(side)]);
    mesh.castShadow = mesh.receiveShadow = true;
    if (geometry.getAttribute('position')?.count) root.add(mesh);
    else geometry.dispose();
  }
  if (/plateau/i.test(obstacle.sourceName ?? '')) {
    const cap = new THREE.Mesh(
      new THREE.ShapeGeometry(
        contourShapes(obstacle.paths ?? rectanglePath(obstacle.half.x, obstacle.half.y)),
      ),
      material(style.ground),
    );
    cap.rotation.x = -Math.PI / 2;
    cap.scale.setScalar(0.78);
    cap.position.y = height + 0.008;
    cap.receiveShadow = true;
    if (cap.geometry.getAttribute('position')?.count) root.add(cap);
    else cap.geometry.dispose();
  }
  // Crate trim is local to its actual box; all collision silhouettes remain exact.
  if (obstacle.kind === 'crate' && obstacle.radius === undefined) {
    const width = obstacle.half.x * 2,
      depth = obstacle.half.y * 2;
    for (const x of [-width * 0.36, width * 0.36]) {
      place(
        box(Math.min(0.07, width * 0.1), height * 0.85, 0.025, '#e1c28b'),
        x,
        height * 0.5,
        depth / 2 + 0.014,
        root,
      );
    }
  }
  return root;
}

function makeGate(portal: Portal): THREE.Group {
  const root = new THREE.Group();
  root.name = `gate:${portal.id}`;
  const width = Math.max(0.4, (portal.half?.x ?? portal.radius) * 2);
  const depth = Math.max(0.12, Math.min(0.45, (portal.half?.y ?? 0.12) * 2));
  const height = Math.max(0.5, portal.height ?? Math.max(1.4, Math.min(2.6, width * 1.12)));
  const post = Math.min(0.22, width * 0.14);
  for (const x of [-width / 2 - post / 2, width / 2 + post / 2]) {
    place(box(post, height + post, depth + 0.12, '#8299a6'), x, (height + post) / 2, 0, root);
    place(box(post + 0.14, 0.16, depth + 0.24, '#c3cfca'), x, height + post * 0.5, 0, root);
  }
  place(box(width + post * 2, post, depth + 0.12, '#a5b9be'), 0, height, 0, root);
  place(box(width + post * 2 + 0.1, 0.12, depth + 0.3, '#a8bfc1'), 0, 0.02, 0, root);
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height - 0.08),
    new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(portal.color) },
        time: { value: 0 },
        flash: { value: 0 },
      },
      vertexShader:
        'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `varying vec2 vUv;uniform vec3 color;uniform float time,flash;
      void main(){float bands=.5+.5*sin(vUv.y*24.0-vUv.x*8.0+time*3.0);
        float rim=pow(abs(vUv.x-.5)*2.0,6.0);vec3 c=mix(color,vec3(1.0),flash*.65+rim*.25);
        gl_FragColor=vec4(c,.43+bands*.1+rim*.27);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  surface.position.y = height / 2;
  surface.material.forceSinglePass = true;
  root.add(surface);
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.4, depth + 0.9),
    new THREE.MeshBasicMaterial({
      color: portal.color,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.03 - (portal.baseHeight ?? 0);
  root.add(glow);
  root.userData.gateSurface = surface;
  root.userData.gateGlow = glow;
  root.userData.flashUntil = -1;
  root.userData.gate = true;
  return root;
}

export function createOriginalArenaView(arena: Arena): ArenaView {
  const root = new THREE.Group(),
    style = styleFor(arena);
  root.name = `original:${arena.sourceScene ?? arena.id ?? 'arena'}`;
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240),
    new THREE.MeshStandardMaterial({
      color: arena.hazard === 'cliff' ? '#758c9c' : style.water,
      roughness: arena.hazard === 'cliff' ? 1 : 0.32,
      metalness: arena.hazard === 'cliff' ? 0 : 0.1,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = arena.hazard === 'cliff' ? -5 : -0.52;
  water.receiveShadow = true;
  root.add(water);
  const floors = new Map<string, THREE.Group>();
  for (const floor of arena.floors ?? []) {
    const view = makeFloor(floor, style, arena.sourceScene ?? '');
    floors.set(floor.id, view);
    root.add(view);
  }
  const obstacles = new Map<string, THREE.Group>();
  for (const obstacle of arena.obstacles) {
    const view = makeOriginalObstacle(obstacle, style);
    obstacles.set(obstacle.id, view);
    root.add(view);
  }
  const portals = new Map<string, THREE.Group>();
  for (const portal of arena.portals ?? []) {
    const view = makeGate(portal);
    portals.set(portal.id, view);
    root.add(view);
  }
  for (const surface of arena.surfaces ?? []) {
    const geometry = new THREE.ShapeGeometry(contourShapes(surface.paths));
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: surface.kind === 'ice' ? '#91d9e7' : '#5eaac1',
        roughness: 0.15,
        metalness: 0.06,
        transparent: true,
        opacity: surface.kind === 'ice' ? 0.55 : 0.9,
        depthWrite: false,
      }),
    );
    mesh.name = `surface:${surface.id}`;
    mesh.rotation.y = -(surface.angle ?? 0);
    mesh.position.set(
      surface.position.x,
      surface.kind === 'ice' ? 0.018 : -0.4,
      surface.position.y,
    );
    mesh.receiveShadow = true;
    root.add(mesh);
  }
  const mechanisms = new Map<string, THREE.Group>();
  for (const mechanism of arena.environment?.mechanisms ?? []) {
    if (mechanism.kind !== 'switch') continue;
    const group = new THREE.Group();
    group.name = `switch:${mechanism.id}`;
    group.add(cylinder(0.32, 0.4, 0.14, '#9ba69b', 8));
    const lever = new THREE.Group();
    lever.position.y = 0.12;
    place(cylinder(0.055, 0.075, 0.48, '#8b7556', 6), 0, 0.23, 0, lever);
    const knob = box(0.26, 0.15, 0.2, '#e1b36d');
    place(knob, 0, 0.48, 0, lever);
    group.add(lever);
    group.userData.lever = lever;
    group.userData.knob = knob;
    mechanisms.set(mechanism.id, group);
    root.add(group);
  }
  const plants = arena.environment?.mechanisms.some((m) => m.kind === 'plant')
    ? new OriginalPlantsView(arena)
    : undefined;
  if (plants) root.add(plants.mesh);
  const view: ArenaView = {
    root,
    obstacles,
    water,
    flags: [],
    portals,
    floors,
    mechanisms,
    plants,
  };
  updateOriginalArena(view, arena, 0);
  return view;
}

/** Runtime owns all pose/state. No browser clock advances a mechanism here. */
export function updateOriginalArena(view: ArenaView, arena: Arena, time: number, alpha = 1): void {
  const mechanisms = new Map((arena.environment?.mechanisms ?? []).map((m) => [m.id, m]));
  view.plants?.update(mechanisms, time, alpha, (m) => heightDelta(m, alpha, mechanisms) ?? 0);
  for (const floor of arena.floors ?? []) {
    const group = view.floors.get(floor.id);
    if (!group || group.userData.static) continue;
    const fall = Math.max(0, Math.min(1, floor.fallProgress ?? 0));
    const warning = Math.max(0, Math.min(1, floor.warning ?? 0));
    const mechanism = floor.mechanismId ? mechanisms.get(floor.mechanismId) : undefined;
    group.visible =
      floor.active ||
      (fall < 1 && (fall > 0 || mechanism?.phase === 'falling' || mechanism?.phase === 'rising'));
    const jitter = warning > 0 ? Math.sin(time * 71 + floor.id.length) * 0.025 * warning : 0;
    syncPose(group, floor.position, floor.angle ?? 0, mechanism, alpha);
    // Collider Transform.z stores a physics depth, not the visible walkable top.
    group.position.y = heightDelta(mechanism, alpha, mechanisms) ?? -fall * 2.4;
    group.position.x += jitter;
    group.position.z -= jitter;
    const top = group.userData.topMaterial as THREE.MeshStandardMaterial;
    const base = group.userData.baseColor as THREE.Color;
    top.color.copy(base).lerp(warningColor, warning * (0.25 + Math.sin(time * 15) * 0.12));
  }
  for (const obstacle of arena.obstacles) {
    const group = view.obstacles.get(obstacle.id);
    if (!group || group.userData.static) continue;
    const mechanism = obstacle.mechanismId ? mechanisms.get(obstacle.mechanismId) : undefined;
    syncPose(group, obstacle.position, obstacle.angle ?? 0, mechanism, alpha);
    group.position.y =
      (obstacle.baseHeight ?? 0) + (heightDelta(mechanism, alpha, mechanisms) ?? 0);
    group.visible = !obstacle.broken && (!obstacle.disabled || mechanism?.kind === 'door');
  }
  for (const portal of arena.portals ?? []) {
    const group = view.portals.get(portal.id);
    if (!group) continue;
    const mechanism = [...mechanisms.values()].find((m) => m.portalIds?.includes(portal.id));
    syncPose(
      group,
      portal.position,
      portal.angle ?? Math.atan2(-portal.direction.x, portal.direction.y),
      mechanism,
      alpha,
    );
    group.position.y = (portal.baseHeight ?? 0) + (heightDelta(mechanism, alpha, mechanisms) ?? 0);
    const surface = group.userData.gateSurface as THREE.Mesh<
      THREE.PlaneGeometry,
      THREE.ShaderMaterial
    >;
    surface.material.uniforms.time.value = time;
    surface.material.uniforms.flash.value = Math.max(
      0,
      (Number(group.userData.flashUntil) - time) / 0.5,
    );
  }
  for (const mechanism of mechanisms.values()) {
    const group = view.mechanisms.get(mechanism.id);
    if (!group) continue;
    syncPose(group, mechanism.position, mechanism.angle ?? 0, mechanism, alpha);
    group.position.y =
      (mechanism.initialHeight ?? mechanism.height ?? 0) +
      (heightDelta(mechanism, alpha, mechanisms) ?? 0);
    const lever = group.userData.lever as THREE.Group;
    lever.rotation.x = mechanism.active ? -0.6 : 0.6;
    const knob = group.userData.knob as THREE.Mesh;
    knob.material = material(mechanism.active ? '#8fd3af' : '#e1b36d');
  }
}

/** Only immutable geometry enters this root. Keep movable/destructible floor and
 * wall nodes reachable; no topology rebuild is needed on navigation revisions. */
export function mergeOriginalStatics(view: ArenaView, arena: Arena): number {
  const fixed = new THREE.Group();
  fixed.name = 'original-static-batches';
  view.root.add(fixed);
  for (const floor of arena.floors ?? []) {
    if (
      floor.mechanismId ||
      floor.kind === 'falling' ||
      floor.kind === 'moving' ||
      !floor.active ||
      floor.warning
    )
      continue;
    const group = view.floors.get(floor.id);
    if (group) {
      group.userData.static = true;
      fixed.add(group);
    }
  }
  for (const obstacle of arena.obstacles) {
    if (obstacle.mechanismId || obstacle.kind === 'crate' || obstacle.broken || obstacle.disabled)
      continue;
    const group = view.obstacles.get(obstacle.id);
    if (group) {
      group.userData.static = true;
      fixed.add(group);
    }
  }
  const multi: THREE.Mesh[] = [];
  fixed.traverse((object) => {
    if (object instanceof THREE.Mesh && Array.isArray(object.material)) multi.push(object);
  });
  for (const mesh of multi) {
    const source = mesh.geometry;
    const flat = source.index ? source.toNonIndexed() : source;
    const materials = mesh.material as THREE.Material[];
    for (const group of flat.groups) {
      const geometry = new THREE.BufferGeometry();
      for (const [name, raw] of Object.entries(flat.attributes)) {
        const attribute = raw as THREE.BufferAttribute;
        geometry.setAttribute(
          name,
          new THREE.BufferAttribute(
            attribute.array.slice(
              group.start * attribute.itemSize,
              (group.start + group.count) * attribute.itemSize,
            ),
            attribute.itemSize,
            attribute.normalized,
          ),
        );
      }
      const part = new THREE.Mesh(geometry, materials[group.materialIndex ?? 0]);
      part.castShadow = mesh.castShadow;
      part.receiveShadow = mesh.receiveShadow;
      part.position.copy(mesh.position);
      part.quaternion.copy(mesh.quaternion);
      part.scale.copy(mesh.scale);
      mesh.parent!.add(part);
    }
    mesh.removeFromParent();
    if (flat !== source) flat.dispose();
    source.dispose();
  }
  return mergeStaticMeshes(fixed);
}

export function flashOriginalGate(view: ArenaView, point: Vec2, time: number): void {
  for (const group of view.portals.values()) {
    if (!group.userData.gate) continue;
    if (Math.hypot(point.x - group.position.x, point.y - group.position.z) < 2)
      group.userData.flashUntil = time + 0.5;
  }
}
