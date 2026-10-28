import * as THREE from 'three';
import type { Arena, EnvironmentMechanism } from '../core/types';

/** HexBush00 measured local visual bounds, expressed in Web units. */
const BUSH = { halfX: 0.3023555, halfZ: 0.266069, bottom: -0.085851, height: 1.501378 };

function bushGeometry(): THREE.BufferGeometry {
  const positions: number[] = [],
    colors: number[] = [];
  const rings = [
    { y: 0, radius: 0.24 },
    { y: 0.18, radius: 0.52 },
    { y: 0.6, radius: 1 },
    { y: 0.92, radius: 0.82 },
    { y: 1, radius: 0.28 },
  ];
  const point = (ring: number, edge: number): [number, number, number] => {
    const { y, radius } = rings[ring],
      angle = (edge * Math.PI) / 3;
    return [
      Math.cos(angle) * radius * BUSH.halfX,
      BUSH.bottom + y * BUSH.height,
      Math.sin(angle) * radius * BUSH.halfZ,
    ];
  };
  const triangle = (a: number[], b: number[], c: number[], light: number) => {
    positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) colors.push(light, light, light);
  };
  for (let ring = 0; ring < rings.length - 1; ring++)
    for (let edge = 0; edge < 6; edge++) {
      const light = 0.8 + ring * 0.045 + (edge % 2) * 0.02;
      const a = point(ring, edge),
        b = point(ring, edge + 1),
        c = point(ring + 1, edge),
        d = point(ring + 1, edge + 1);
      triangle(a, c, b, light);
      triangle(b, c, d, light);
    }
  for (let edge = 0; edge < 6; edge++)
    triangle(point(4, edge), [0, BUSH.bottom + BUSH.height, 0], point(4, edge + 1), 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** One opaque batch for all Plant triggers, including plants with no Obstacle. */
export class OriginalPlantsView {
  readonly mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly ids = new Map<string, number>();
  private pose = new THREE.Object3D();
  private color = new THREE.Color();
  private green = new THREE.Color('#62b989');
  private autumn = new THREE.Color('#d28b4f');
  private burnt = new THREE.Color('#604d2e');
  private readonly autumnScene: boolean;

  constructor(arena: Arena) {
    const count = arena.environment?.mechanisms.filter((m) => m.kind === 'plant').length ?? 0;
    this.autumnScene = /(?:^|\/)LevelTemple(?:Garden)?(?:\.unity)?$/i.test(arena.sourceScene ?? '');
    this.mesh = new THREE.InstancedMesh(
      bushGeometry(),
      new THREE.MeshStandardMaterial({
        color: '#ffffff',
        roughness: 1,
        vertexColors: true,
        flatShading: true,
      }),
      count,
    );
    this.mesh.name = 'original-plant-instances';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Plants move with floors and sway. Avoid a stale bounding sphere dropping a whole field.
    this.mesh.frustumCulled = false;
  }

  update(
    mechanisms: Map<string, EnvironmentMechanism>,
    time: number,
    alpha: number,
    elevationDelta: (mechanism: EnvironmentMechanism) => number,
  ): void {
    this.ids.clear();
    let count = 0;
    for (const m of mechanisms.values()) {
      if (m.kind !== 'plant' || m.active === false || m.phase === 'cut') continue;
      const previous = m.previous ?? m.position;
      const angle =
        (m.previousAngle ?? m.angle ?? 0) +
        ((m.angle ?? 0) - (m.previousAngle ?? m.angle ?? 0)) * alpha;
      const disturbance = Math.max(0, Math.min(1.75, m.disturbance ?? 0));
      const tilt = disturbance * (0.32 + Math.sin(time * 17 + m.id.length) * 0.06);
      const direction = m.disturbedDirection ?? { x: 0, y: 0 };
      this.pose.position.set(
        previous.x + (m.position.x - previous.x) * alpha,
        (m.initialHeight ?? m.height ?? 0) + elevationDelta(m),
        previous.y + (m.position.y - previous.y) * alpha,
      );
      this.pose.rotation.set(direction.y * tilt, -angle, -direction.x * tilt);
      const radiusScale = (m.radius ?? 0.3) / 0.3;
      this.pose.scale.set(radiusScale, 1, radiusScale);
      this.pose.updateMatrix();
      this.mesh.setMatrixAt(count, this.pose.matrix);
      const burning = (m.burnTime ?? 0) > 0 || (m.burnHealth ?? 0.4) < 0.4;
      const burn = burning ? Math.max(0.15, Math.min(1, 1 - (m.burnHealth ?? 0.4) / 0.4)) : 0;
      this.color.copy(this.autumnScene ? this.autumn : this.green).lerp(this.burnt, burn);
      this.mesh.setColorAt(count, this.color);
      this.ids.set(m.id, count++);
    }
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}
