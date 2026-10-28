import * as THREE from 'three';
import { RULES } from '../core/config';
import { sampleMeleePose } from './melee-pose';

const SEGMENTS = 24;
const CAPACITY = 4 * 2 * SEGMENTS * 6;
const CORNER_T = [0, 0, 1, 0, 1, 1];
const CORNER_OUTER = [0, 1, 1, 0, 1, 0];

/** Two feathered ribbons per actor, in one draw call. Buffers never resize. */
export class MeleeTrail {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private positions = new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3);
  private colors = new THREE.BufferAttribute(new Float32Array(CAPACITY * 4), 4);
  private color = new THREE.Color();
  private used = 0;
  count = 0;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.colors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('color', this.colors);
    geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.name = 'weapon-slash-ribbons';
    this.mesh.material.forceSinglePass = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }
  begin(): void {
    this.used = 0;
    this.count = 0;
  }

  add(x: number, z: number, facing: number, age: number): void {
    const pose = sampleMeleePose(age, true);
    if (pose.trail <= 0.001) return;
    const head = facing + pose.angle;
    const tail = facing + sampleMeleePose(Math.max(0.028, age - 0.07), true).angle;
    if (tail - head < 0.015 || this.used + 2 * SEGMENTS * 6 > CAPACITY) return;
    for (let layer = 0; layer < 2; layer++) {
      this.color.set(layer === 0 ? '#ffd78a' : '#fffce7');
      const radius = RULES.attackRange * (layer === 0 ? 0.94 : 1);
      const width = layer === 0 ? 0.24 : 0.075;
      for (let i = 0; i < SEGMENTS; i++) {
        for (let corner = 0; corner < 6; corner++) {
          const t = (i + CORNER_T[corner]) / SEGMENTS,
            outer = CORNER_OUTER[corner];
          const angle = tail + (head - tail) * t;
          const taper = Math.pow(Math.sin(Math.PI * t), 0.65);
          const r = radius - (1 - outer) * width * taper;
          this.positions.setXYZ(
            this.used,
            x + Math.sin(angle) * r,
            0.8 + layer * 0.015,
            z + Math.cos(angle) * r,
          );
          const opacity = pose.trail * taper * (0.25 + 0.75 * t) * (outer ? 0.9 : 0.06);
          this.colors.setXYZW(this.used++, this.color.r, this.color.g, this.color.b, opacity);
        }
      }
      this.count++;
    }
  }
  end(): void {
    this.mesh.geometry.setDrawRange(0, this.used);
    this.mesh.visible = this.used > 0;
    this.positions.needsUpdate = true;
    this.colors.needsUpdate = true;
  }
  clear(): void {
    this.begin();
    this.end();
  }
  dispose(): void {
    this.clear();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
