import * as THREE from 'three';
import { POWERUPS, ROSTER } from '../core/config';
import type { Arena, GameEvent, GameState } from '../core/types';
import { Random } from '../core/math';
import { sampleDeathParticles, sampleDeathRings, sampleDeathSplats } from './death-visuals';
import { InstanceBatch } from './batches';
import { onGround } from '../core/collision';
import { obstacleDistance } from '../core/geometry';

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  born: number;
  duration: number;
  size: number;
  color: string;
  pickup: boolean;
}
interface Wave {
  x: number;
  z: number;
  born: number;
  duration: number;
  radius: number;
  color: string;
}
const PARTICLE_LIMIT = 384;
function onFloor(arena: Arena, x: number, y: number): boolean {
  return (
    onGround(arena, { x, y }) &&
    !arena.obstacles.some((o) => !o.broken && !o.disabled && obstacleDistance(o, { x, y }) <= 1e-7)
  );
}

/** Three fixed GPU batches cover transient and snapshot-driven death effects. */
export class Effects {
  readonly root = new THREE.Group();
  private particles: Particle[] = [];
  private waves: Wave[] = [];
  private random = new Random(123);
  private clock = 0;
  private state?: GameState;
  private transientShake = 0;
  private particlesBatch = new InstanceBatch(new THREE.IcosahedronGeometry(1, 0), 576);
  private ringsBatch = new InstanceBatch(new THREE.RingGeometry(0.89, 1, 32), 64);
  private splatsBatch = new InstanceBatch(new THREE.CircleGeometry(1, 12), 32);
  private disposed = false;
  shake = 0;

  constructor() {
    this.particlesBatch.mesh.name = 'effect-particles';
    this.ringsBatch.mesh.name = 'effect-rings';
    this.splatsBatch.mesh.name = 'effect-splats';
    this.root.add(this.particlesBatch.mesh, this.ringsBatch.mesh, this.splatsBatch.mesh);
  }

  emit(event: GameEvent): void {
    if (this.disposed || ['death', 'round', 'countdown', 'boundary', 'win'].includes(event.type))
      return;
    if (event.type === 'teleport' && event.destination)
      this.emit({ ...event, position: event.destination, destination: undefined });
    const color =
      event.type === 'freeze'
        ? '#a7ecff'
        : event.type === 'burn'
          ? '#ffb36b'
          : event.type === 'decoy' || event.type === 'disguise'
            ? '#b4dfb4'
            : event.type === 'equip'
              ? '#fff1ae'
              : event.type === 'split'
                ? '#f4e6a1'
                : event.type === 'teleport'
                  ? '#b4e3ff'
                  : event.type === 'explosion'
                    ? '#fbc579'
                    : event.type === 'shield'
                      ? '#9ceee4'
                      : event.type === 'crate'
                        ? '#d2ac75'
                        : event.power
                          ? POWERUPS[event.power].color
                          : event.type === 'deflect'
                            ? '#fff8d8'
                            : '#fff4cf';
    const count =
      event.type === 'explosion'
        ? 30
        : event.type === 'crate'
          ? 14
          : event.type === 'deflect' || event.type === 'shield' || event.type === 'split'
            ? 16
            : event.type === 'pickup'
              ? 18
              : event.type === 'dash'
                ? 9
                : 5;
    const intensity = event.type === 'explosion' ? 6 : event.type === 'deflect' ? 4 : 2;
    for (let i = 0; i < count && this.particles.length < PARTICLE_LIMIT; i++) {
      const angle = this.random.range(0, Math.PI * 2),
        speed = this.random.range(0.4, 1) * intensity;
      this.particles.push({
        x: event.position.x,
        y: event.type === 'dash' ? 0.12 : 0.65,
        z: event.position.y,
        vx: Math.cos(angle) * speed + (event.direction?.x ?? 0) * 0.7,
        vy: this.random.range(1, 4),
        vz: Math.sin(angle) * speed + (event.direction?.y ?? 0) * 0.7,
        born: this.clock,
        duration: this.random.range(0.3, event.type === 'pickup' ? 0.8 : 0.65),
        size: this.random.range(0.035, event.type === 'explosion' ? 0.17 : 0.085),
        color,
        pickup: event.type === 'pickup',
      });
    }
    if (
      [
        'explosion',
        'deflect',
        'shield',
        'pickup',
        'catch',
        'teleport',
        'equip',
        'freeze',
        'split',
        'decoy',
      ].includes(event.type) &&
      this.waves.length < 32
    )
      this.waves.push({
        x: event.position.x,
        z: event.position.y,
        born: this.clock,
        duration: event.type === 'pickup' ? 0.65 : 0.36,
        radius: event.type === 'explosion' ? (event.value ?? 2.5) : 1.3,
        color,
      });
    if (event.type === 'explosion') this.transientShake = 0.15;
    else if (event.type === 'deflect') this.transientShake = 0.06;
  }

  syncDeaths(state: GameState): void {
    this.state = state;
    this.rebuild();
  }

  update(dt: number, state?: GameState): void {
    if (this.disposed) return;
    this.clock += Math.max(0, dt);
    this.transientShake = Math.max(0, this.transientShake - Math.max(0, dt));
    if (state) this.state = state;
    // Compact in place; particle records are allocated only when an event arrives.
    let used = 0;
    for (const p of this.particles)
      if (this.clock - p.born < p.duration) this.particles[used++] = p;
    this.particles.length = used;
    used = 0;
    for (const w of this.waves) if (this.clock - w.born < w.duration) this.waves[used++] = w;
    this.waves.length = used;
    this.rebuild();
  }

  private rebuild(): void {
    if (this.disposed) return;
    this.particlesBatch.begin();
    this.ringsBatch.begin();
    this.splatsBatch.begin();
    this.shake = this.transientShake;
    for (const p of this.particles) {
      const t = Math.max(0, this.clock - p.born),
        progress = t / p.duration,
        fade = Math.max(0, 1 - progress);
      const size = p.size * Math.sqrt(fade);
      const travel = p.pickup ? Math.sin(progress * Math.PI) * 0.35 : t;
      this.particlesBatch.add(
        p.x + p.vx * travel,
        p.pickup ? p.y + progress * 1.3 : Math.max(0.04, p.y + p.vy * t - 5 * t * t),
        p.z + p.vz * travel,
        size,
        size,
        size,
        p.color,
        fade,
        0,
        t * 4,
        t * 3,
      );
    }
    for (const wave of this.waves) {
      const progress = Math.min(1, (this.clock - wave.born) / wave.duration),
        radius = (0.12 + progress * 0.88) * wave.radius;
      this.ringsBatch.add(
        wave.x,
        0.06,
        wave.z,
        radius,
        radius,
        1,
        wave.color,
        (1 - progress) * 0.75,
        -Math.PI / 2,
      );
    }
    const state = this.state;
    if (state)
      for (const actor of state.actors) {
        const death = actor.death;
        if (actor.alive || !death) continue;
        const age = Math.max(0, state.time - death.time),
          profile = ROSTER[actor.id] ?? ROSTER[0];
        this.shake = Math.max(this.shake, 0.12 * Math.exp(-age * 7) * (age < 1.2 ? 1 : 0));
        const juice =
          profile.kind === 'milk'
            ? '#fffbea'
            : profile.kind === 'melon'
              ? '#ed8179'
              : profile.color;
        for (const p of sampleDeathParticles(death, state.time)) {
          const color =
            p.kind === 'water'
              ? '#b8e3ee'
              : p.kind === 'bubble'
                ? '#e7fcff'
                : p.kind === 'cloud' || p.kind === 'dust'
                  ? '#eef0dc'
                  : juice;
          this.particlesBatch.add(
            death.position.x + p.x,
            p.y,
            death.position.y + p.z,
            p.radius,
            p.radius,
            p.radius,
            color,
            p.opacity,
          );
        }
        for (const ring of sampleDeathRings(death, state.time))
          this.ringsBatch.add(
            death.position.x,
            0.055,
            death.position.y,
            ring.radius,
            ring.radius,
            1,
            death.variant === 'water' ? '#d8f5f5' : juice,
            ring.opacity,
            -Math.PI / 2,
          );
        for (const splat of sampleDeathSplats(death, state.time))
          if (onFloor(state.arena, death.position.x + splat.x, death.position.y + splat.z))
            this.splatsBatch.add(
              death.position.x + splat.x,
              0.032,
              death.position.y + splat.z,
              splat.radius * 1.3,
              splat.radius,
              1,
              juice,
              splat.opacity,
              -Math.PI / 2,
              0,
              splat.angle,
            );
      }
    this.particlesBatch.end();
    this.ringsBatch.end();
    this.splatsBatch.end();
  }

  stats(): { particles: number; rings: number; splats: number; dropped: number; batches: number } {
    return {
      particles: this.particlesBatch.count,
      rings: this.ringsBatch.count,
      splats: this.splatsBatch.count,
      dropped: this.particlesBatch.dropped + this.ringsBatch.dropped + this.splatsBatch.dropped,
      batches: 3,
    };
  }
  clear(): void {
    this.particles.length = 0;
    this.waves.length = 0;
    this.clock = 0;
    this.state = undefined;
    this.shake = 0;
    this.transientShake = 0;
    this.particlesBatch.clear();
    this.ringsBatch.clear();
    this.splatsBatch.clear();
  }
  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.particlesBatch.dispose();
    this.ringsBatch.dispose();
    this.splatsBatch.dispose();
  }
}
