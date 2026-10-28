import * as THREE from 'three';
import { POWERUPS, ROSTER } from '../core/config';
import type { Arena, GameEvent, GameState } from '../core/types';
import { Random } from '../core/math';
import { sphere } from './palette';
import { sampleDeathParticles, sampleDeathRings, sampleDeathSplats } from './death-visuals';

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
interface DeathEffectView {
  root: THREE.Group;
  particleRoot: THREE.Group;
  ringRoot: THREE.Group;
  splatRoot: THREE.Group;
  particles: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshStandardMaterial>[];
  rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[];
  splats: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>[];
}

function onFloor(arena: Arena, x: number, y: number): boolean {
  return (
    Math.abs(x) < arena.halfWidth &&
    Math.abs(y) < arena.halfHeight &&
    !arena.pits.some(
      (p) => Math.abs(x - p.position.x) <= p.half.x && Math.abs(y - p.position.y) <= p.half.y,
    ) &&
    !arena.obstacles.some(
      (o) =>
        !o.broken &&
        Math.abs(x - o.position.x) <= o.half.x &&
        Math.abs(y - o.position.y) <= o.half.y,
    )
  );
}

function disposeDeathView(view: DeathEffectView): void {
  for (const mesh of [...view.particles, ...view.rings, ...view.splats]) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  view.root.clear();
  view.root.removeFromParent();
}

export class Effects {
  readonly root = new THREE.Group();
  private particles: Particle[] = [];
  private waves: Wave[] = [];
  private random = new Random(123);
  private deaths = new Map<string, DeathEffectView>();
  private transientShake = 0;
  private deathShake = 0;
  shake = 0;

  emit(event: GameEvent): void {
    // Death effects are reconstructed from state; event replay must not duplicate them.
    if (event.type === 'death') return;
    if (event.type === 'teleport' && event.destination)
      this.emit({ ...event, position: event.destination, destination: undefined });
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
                : '#fff4cf';
    const count =
      event.type === 'explosion'
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
      const size = this.random.range(0.05, event.type === 'explosion' ? 0.18 : 0.1);
      const object = sphere(size, color, 0);
      object.position.set(event.position.x, event.type === 'dash' ? 0.1 : 0.6, event.position.y);
      object.castShadow = false;
      this.root.add(object);
      const intensity = event.type === 'explosion' ? 6 : 2;
      const velocity = new THREE.Vector3(
        this.random.range(-1, 1) * intensity,
        this.random.range(1, 4),
        this.random.range(-1, 1) * intensity,
      );
      const duration = this.random.range(0.25, 0.75);
      this.particles.push({ mesh: object, velocity, life: duration, duration, baseScale: 1 });
    }
    if (['explosion', 'deflect', 'shield', 'pickup', 'teleport'].includes(event.type)) {
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
    if (event.type === 'explosion') this.transientShake = 0.15;
    else if (event.type === 'deflect') this.transientShake = 0.06;
    this.shake = Math.max(this.transientShake, this.deathShake);
  }

  /** Rebuildable, pause-safe death presentation. Call once for each rendered snapshot. */
  syncDeaths(state: GameState): void {
    const active = new Set<string>();
    this.deathShake = 0;
    for (const actor of state.actors) {
      const death = actor.death;
      if (actor.alive || !death) continue;
      const key = `${state.round}:${actor.id}:${death.time}:${death.seed}`;
      active.add(key);
      let view = this.deaths.get(key);
      if (!view) {
        view = {
          root: new THREE.Group(),
          particleRoot: new THREE.Group(),
          ringRoot: new THREE.Group(),
          splatRoot: new THREE.Group(),
          particles: [],
          rings: [],
          splats: [],
        };
        view.root.add(view.particleRoot, view.ringRoot, view.splatRoot);
        this.deaths.set(key, view);
        this.root.add(view.root);
      }
      view.root.position.set(death.position.x, 0, death.position.y);
      const age = Math.max(0, state.time - death.time);
      this.deathShake = Math.max(this.deathShake, 0.12 * Math.exp(-age * 7) * (age < 1.2 ? 1 : 0));
      const profile = ROSTER[actor.id] ?? ROSTER[0];
      const juiceColor =
        profile.kind === 'milk' ? '#fffbea' : profile.kind === 'melon' ? '#ed8179' : profile.color;
      const particles = sampleDeathParticles(death, state.time);
      while (view.particles.length < particles.length) {
        const mesh = new THREE.Mesh(
          new THREE.IcosahedronGeometry(1, 1),
          new THREE.MeshStandardMaterial({
            color: juiceColor,
            roughness: 0.6,
            transparent: true,
            depthWrite: false,
            flatShading: true,
          }),
        );
        mesh.castShadow = false;
        view.particles.push(mesh);
        view.particleRoot.add(mesh);
      }
      view.particles.forEach((mesh, index) => {
        const particle = particles[index];
        mesh.visible = !!particle;
        if (!particle) return;
        const color =
          particle.kind === 'water'
            ? '#b8e3ee'
            : particle.kind === 'bubble'
              ? '#e7fcff'
              : particle.kind === 'cloud' || particle.kind === 'dust'
                ? '#eef0dc'
                : juiceColor;
        mesh.material.color.set(color);
        mesh.material.opacity = particle.opacity;
        mesh.position.set(particle.x, particle.y, particle.z);
        mesh.scale.setScalar(particle.radius);
      });
      const rings = sampleDeathRings(death, state.time);
      while (view.rings.length < rings.length) {
        const mesh = new THREE.Mesh(
          new THREE.RingGeometry(0.87, 1, 36),
          new THREE.MeshBasicMaterial({
            color: death.variant === 'water' ? '#d8f5f5' : juiceColor,
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = 0.055;
        view.rings.push(mesh);
        view.ringRoot.add(mesh);
      }
      view.rings.forEach((mesh, index) => {
        const ring = rings[index];
        mesh.visible = !!ring;
        if (!ring) return;
        mesh.scale.setScalar(ring.radius);
        mesh.material.opacity = ring.opacity;
      });
      const splats = sampleDeathSplats(death, state.time);
      while (view.splats.length < splats.length) {
        const mesh = new THREE.Mesh(
          new THREE.CircleGeometry(1, 12),
          new THREE.MeshBasicMaterial({
            color: juiceColor,
            transparent: true,
            opacity: 0.7,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          }),
        );
        mesh.rotation.x = -Math.PI / 2;
        view.splats.push(mesh);
        view.splatRoot.add(mesh);
      }
      view.splats.forEach((mesh, index) => {
        const splat = splats[index];
        mesh.visible =
          !!splat && onFloor(state.arena, death.position.x + splat.x, death.position.y + splat.z);
        if (!splat) return;
        mesh.position.set(splat.x, 0.032, splat.z);
        mesh.rotation.z = splat.angle;
        mesh.scale.set(splat.radius * 1.3, splat.radius, 1);
        mesh.material.opacity = splat.opacity;
      });
    }
    for (const [key, view] of this.deaths)
      if (!active.has(key)) {
        disposeDeathView(view);
        this.deaths.delete(key);
      }
    this.shake = Math.max(this.transientShake, this.deathShake);
  }

  update(dt: number): void {
    this.transientShake = Math.max(0, this.transientShake - dt);
    this.shake = Math.max(this.transientShake, this.deathShake);
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
    for (const view of this.deaths.values()) disposeDeathView(view);
    this.deaths.clear();
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
    this.transientShake = 0;
    this.deathShake = 0;
  }
}
