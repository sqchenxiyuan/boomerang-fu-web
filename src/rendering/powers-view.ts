import * as THREE from 'three';
import { RULES } from '../core/config';
import type { GameState } from '../core/types';
import { InstanceBatch } from './batches';

/** Ground hazards and status markers use the same simulation clock as combat. */
export class PowersView {
  readonly root = new THREE.Group();
  // A single ice explosion covers hundreds of cells. Gameplay surfaces have a
  // separate arena-sized budget; only secondary motes/crystals may truncate.
  private patches = new InstanceBatch(new THREE.CircleGeometry(1, 24), RULES.maxHazardZones);
  private edges = new InstanceBatch(new THREE.RingGeometry(0.94, 1, 36), RULES.maxHazardZones + 16);
  private sparks = new InstanceBatch(new THREE.IcosahedronGeometry(1, 0), 768);
  private crystals = new InstanceBatch(new THREE.ConeGeometry(0.13, 0.55, 4), 256);
  private disposed = false;
  constructor() {
    this.root.add(this.patches.mesh, this.edges.mesh, this.sparks.mesh, this.crystals.mesh);
    this.patches.mesh.name = 'power-zone-surfaces';
    this.edges.mesh.name = 'power-zone-rims';
    this.sparks.mesh.name = 'power-fire-motes';
    this.crystals.mesh.name = 'power-ice-crystals';
  }
  update(state: GameState): void {
    if (this.disposed) return;
    this.patches.begin();
    this.edges.begin();
    this.sparks.begin();
    this.crystals.begin();
    for (const zone of state.zones) {
      const fire = zone.kind === 'fire';
      const fade = Math.min(1, zone.remaining / 0.45);
      const radius = zone.radius;
      this.patches.add(
        zone.position.x,
        0.026,
        zone.position.y,
        radius,
        radius,
        1,
        fire ? '#d65c2c' : '#3aa4cd',
        fade * (fire ? 0.34 : 0.36),
        -Math.PI / 2,
      );
      this.edges.add(
        zone.position.x,
        0.028,
        zone.position.y,
        radius,
        radius,
        1,
        fire ? '#e5682e' : '#57c5e6',
        fade * 0.7,
        -Math.PI / 2,
      );
      for (let i = 0; i < 4; i++) {
        const angle = i * Math.PI * 0.5 + zone.id * 1.37;
        const x = zone.position.x + Math.cos(angle) * radius * 0.58;
        const z = zone.position.y + Math.sin(angle) * radius * 0.58;
        if (fire) {
          const cycle = (state.time * 1.5 + i * 0.23 + zone.id * 0.31) % 1;
          const size = (0.16 + radius * 0.06) * (1 - cycle);
          this.sparks.add(
            x,
            0.08 + cycle * 0.65,
            z,
            size * 0.8,
            size * (1.5 + cycle),
            size * 0.8,
            cycle < 0.35 ? '#ffe4a5' : '#f7aa59',
            fade * (1 - cycle),
          );
        } else {
          const scale = Math.min(1, radius * 0.65) * fade;
          this.crystals.add(x, 0.12, z, scale, scale, scale, '#c7f5ff', fade * 0.65, 0, angle, 0.1);
        }
      }
    }
    for (const actor of state.actors) {
      if (!actor.alive) continue;
      const x = actor.position.x,
        z = actor.position.y;
      if ((actor.burnTime ?? 0) > 0)
        for (let i = 0; i < 5; i++) {
          const cycle = (state.time * 1.9 + i * 0.21) % 1;
          const size = 0.16 * (1 - cycle);
          this.sparks.add(
            x + Math.sin(i * 2.4) * 0.58,
            0.45 + cycle * 1.4,
            z + Math.cos(i * 2.4) * 0.43,
            size,
            size * 1.7,
            size,
            '#ffc86f',
            (1 - cycle) * 0.9,
          );
        }
      if ((actor.reverseTime ?? 0) > 0) {
        const radius = 0.8 + Math.sin(state.time * 6) * 0.04;
        this.edges.add(x, 0.07, z, radius, radius, 1, '#d8a8ef', 0.6, -Math.PI / 2);
        for (let i = 0; i < 2; i++) {
          const angle = state.time * 2.5 + i * Math.PI;
          this.sparks.add(
            x + Math.sin(angle) * 0.65,
            1.8,
            z + Math.cos(angle) * 0.45,
            0.07,
            0.07,
            0.07,
            '#d7adff',
            0.9,
          );
        }
      }
      if (actor.controlling)
        this.edges.add(
          x,
          0.04,
          z,
          0.9,
          0.9,
          1,
          '#97f5e3',
          0.4 + Math.sin(state.time * 7) * 0.15,
          -Math.PI / 2,
        );
      if (actor.dashTime > 0 && actor.powers.includes('wallDash'))
        this.edges.add(x, 0.5, z, 0.72, 0.72, 1, '#abcfef', 0.6, -Math.PI / 2);
    }
    this.patches.end();
    this.edges.end();
    this.sparks.end();
    this.crystals.end();
  }
  clear(): void {
    this.patches.clear();
    this.edges.clear();
    this.sparks.clear();
    this.crystals.clear();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.patches.dispose();
    this.edges.dispose();
    this.sparks.dispose();
    this.crystals.dispose();
  }
}
