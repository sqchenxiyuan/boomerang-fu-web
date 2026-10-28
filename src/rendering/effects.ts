import * as THREE from 'three';
import { POWERUPS, ROSTER } from '../core/config';
import type { GameEvent } from '../core/types';
import { Random } from '../core/math';
import { sphere } from './palette';

interface Particle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  duration: number;
  baseScale: number;
}
interface Wave {
  mesh: THREE.Mesh;
  life: number;
  duration: number;
  radius: number;
}

export class Effects {
  readonly root = new THREE.Group();
  private particles: Particle[] = [];
  private waves: Wave[] = [];
  private random = new Random(123);
  shake = 0;

  emit(event: GameEvent): void {
    if (event.type === 'teleport' && event.destination)
      this.emit({ ...event, position: event.destination, destination: undefined });
    const profile = ROSTER[event.actorId] ?? ROSTER[0];
    const color =
      event.type === 'teleport'
        ? '#b4e3ff'
        : event.type === 'explosion'
          ? '#fbc579'
          : event.type === 'shield'
            ? '#9ceee4'
            : event.type === 'crate'
              ? '#d2ac75'
              : event.power
                ? POWERUPS[event.power].color
                : event.type === 'death'
                  ? profile.color
                  : '#fff4cf';
    const count =
      event.type === 'death'
        ? 22
        : event.type === 'explosion'
          ? 30
          : event.type === 'crate'
            ? 14
            : event.type === 'dash'
              ? 9
              : event.type === 'deflect'
                ? 14
                : 6;
    if (['round', 'countdown'].includes(event.type)) return;
    if (this.particles.length > 260) return;
    for (let i = 0; i < count; i++) {
      const size = this.random.range(
        0.05,
        event.type === 'death' || event.type === 'explosion' ? 0.18 : 0.1,
      );
      const object = sphere(size, color, 0);
      object.position.set(event.position.x, event.type === 'dash' ? 0.1 : 0.6, event.position.y);
      object.castShadow = false;
      this.root.add(object);
      const intensity = event.type === 'explosion' ? 6 : event.type === 'death' ? 4 : 2;
      const velocity = new THREE.Vector3(
        this.random.range(-1, 1) * intensity,
        this.random.range(1, 4),
        this.random.range(-1, 1) * intensity,
      );
      const duration = this.random.range(0.25, 0.75);
      this.particles.push({ mesh: object, velocity, life: duration, duration, baseScale: 1 });
    }
    if (['explosion', 'deflect', 'shield', 'pickup', 'death', 'teleport'].includes(event.type)) {
      const object = new THREE.Mesh(
        new THREE.RingGeometry(0.86, 1, 40),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.75,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      object.rotation.x = -Math.PI / 2;
      object.position.set(event.position.x, 0.08, event.position.y);
      this.root.add(object);
      this.waves.push({
        mesh: object,
        life: 0.4,
        duration: 0.4,
        radius: event.type === 'explosion' ? (event.value ?? 2.5) : 1.6,
      });
    }
    if (event.type === 'death' || event.type === 'explosion') this.shake = 0.15;
    else if (event.type === 'deflect') this.shake = 0.06;
  }

  update(dt: number): void {
    this.shake = Math.max(0, this.shake - dt);
    for (const p of this.particles) {
      p.life -= dt;
      p.velocity.y -= dt * 10;
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.mesh.rotation.x += dt * 4;
      p.mesh.rotation.z += dt * 3;
      p.mesh.scale.setScalar(Math.max(0, p.life / p.duration) * p.baseScale);
      if (p.life <= 0) {
        this.root.remove(p.mesh);
        p.mesh.geometry.dispose();
      }
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const wave of this.waves) {
      wave.life -= dt;
      wave.mesh.scale.setScalar((1 - wave.life / wave.duration) * wave.radius);
      (wave.mesh.material as THREE.MeshBasicMaterial).opacity =
        Math.max(0, wave.life / wave.duration) * 0.7;
      if (wave.life <= 0) {
        this.root.remove(wave.mesh);
        wave.mesh.geometry.dispose();
        (wave.mesh.material as THREE.Material).dispose();
      }
    }
    this.waves = this.waves.filter((w) => w.life > 0);
  }

  clear(): void {
    for (const p of this.particles) {
      this.root.remove(p.mesh);
      p.mesh.geometry.dispose();
    }
    for (const w of this.waves) {
      this.root.remove(w.mesh);
      w.mesh.geometry.dispose();
      (w.mesh.material as THREE.Material).dispose();
    }
    this.particles = [];
    this.waves = [];
    this.shake = 0;
  }
}
