import * as THREE from 'three';
import { ROSTER, RULES } from '../core/config';
import type { Disc, GameEvent, GameState } from '../core/types';
import { InstanceBatch } from './batches';

interface TrailPoint {
  x: number;
  z: number;
  time: number;
}
interface Trail {
  points: TrailPoint[];
  updated: number;
}
const TRAIL_SECONDS = 0.2;
const MAX_POINTS = 32;

export function discEffectColor(disc: Disc): string {
  const powers = disc.powers ?? [];
  if (powers.includes('ice')) return '#a5ebff';
  if (powers.includes('fire')) return '#ffbd69';
  if (powers.includes('teleport')) return '#c3a4ff';
  if (powers.includes('controlled')) return '#9dfff0';
  if (disc.explosive) return '#ffc189';
  return ROSTER[disc.damageOwnerId]?.color ?? '#fff2c5';
}

/** Persistent trail history belongs to this renderer, never to authoritative
 * simulation. Simulation timestamps make repeated pause frames identical. */
export class WeaponsView {
  readonly root = new THREE.Group();
  private trails = new Map<number, Trail>();
  private ribbon = new InstanceBatch(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), 768);
  private rings = new InstanceBatch(new THREE.RingGeometry(0.86, 1, 32), 96);
  private arcs = new InstanceBatch(new THREE.RingGeometry(0.72, 1, 32, 1, 0, RULES.attackArc), 24);
  private lastTime = -1;
  private round = -1;
  private disposed = false;

  constructor() {
    this.root.add(this.ribbon.mesh, this.rings.mesh, this.arcs.mesh);
    this.ribbon.mesh.name = 'weapon-ribbons';
    this.rings.mesh.name = 'weapon-charge-rings';
    this.arcs.mesh.name = 'weapon-slash-arcs';
  }
  observe(event: GameEvent): void {
    if (event.type === 'teleport' && event.entityType === 'disc' && event.entityId !== undefined)
      this.trails.delete(event.entityId);
  }

  update(state: GameState, alpha: number): void {
    if (this.disposed) return;
    if (state.round !== this.round || state.time < this.lastTime) this.clear();
    this.round = state.round;
    this.lastTime = state.time;
    this.ribbon.begin();
    this.rings.begin();
    this.arcs.begin();
    const active = new Set<number>();
    for (const disc of state.discs) {
      if (disc.dead || disc.state === 'dropped') {
        this.trails.delete(disc.id);
        continue;
      }
      active.add(disc.id);
      let trail = this.trails.get(disc.id);
      if (!trail) {
        trail = {
          points: [{ x: disc.previous.x, z: disc.previous.y, time: state.time - RULES.dt }],
          updated: -1,
        };
        this.trails.set(disc.id, trail);
      }
      const old = trail.points.at(-1)!;
      if (trail.updated !== state.time) {
        const jump = Math.hypot(disc.position.x - old.x, disc.position.y - old.z);
        // A teleport/correction must never draw a line across the entire arena.
        if (
          jump >
          Math.max(
            2.5,
            Math.hypot(disc.velocity.x, disc.velocity.y) *
              Math.max(RULES.dt, state.time - old.time) *
              2,
          )
        )
          trail.points.length = 0;
        trail.points.push({ x: disc.position.x, z: disc.position.y, time: state.time });
        trail.updated = state.time;
      }
      while (
        trail.points.length > MAX_POINTS ||
        (trail.points.length > 2 && trail.points[1].time < state.time - TRAIL_SECONDS)
      )
        trail.points.shift();
      const color = discEffectColor(disc);
      const width = (0.11 + Math.min(1, disc.charge) * 0.07) * (disc.mini ? 0.65 : 1);
      for (let i = 1; i < trail.points.length; i++) {
        const a = trail.points[i - 1],
          b = trail.points[i];
        const head = i === trail.points.length - 1;
        const bx = head ? disc.previous.x + (disc.position.x - disc.previous.x) * alpha : b.x;
        const bz = head ? disc.previous.y + (disc.position.y - disc.previous.y) * alpha : b.z;
        const dx = bx - a.x,
          dz = bz - a.z,
          distance = Math.hypot(dx, dz);
        if (distance < 0.001 || distance > 3) continue;
        const fade = Math.max(0, 1 - (state.time - b.time) / TRAIL_SECONDS);
        this.ribbon.add(
          (a.x + bx) / 2,
          0.76,
          (a.z + bz) / 2,
          width * fade,
          1,
          distance + 0.025,
          color,
          fade * (disc.state === 'returning' ? 0.38 : 0.65),
          0,
          Math.atan2(dx, dz),
        );
      }
      if (disc.explosive || (disc.powers?.length ?? 0) > 0) {
        const radius = (disc.mini ? 0.35 : 0.55) * (1 + Math.sin(state.time * 8) * 0.08);
        this.rings.add(
          disc.position.x,
          0.72,
          disc.position.y,
          radius,
          radius,
          1,
          color,
          0.3,
          -Math.PI / 2,
        );
      }
    }
    for (const id of this.trails.keys()) if (!active.has(id)) this.trails.delete(id);
    if (state.phase === 'playing')
      for (const actor of state.actors) {
        if (!actor.alive || actor.fall) continue;
        const x = actor.previous.x + (actor.position.x - actor.previous.x) * alpha;
        const z = actor.previous.y + (actor.position.y - actor.previous.y) * alpha;
        const facing = Math.atan2(actor.facing.x, actor.facing.y);
        if (actor.armed && actor.charge > 0.1) {
          const charge = Math.min(1, actor.charge / RULES.chargeTime);
          const pulse = charge === 1 ? 1 + Math.sin(state.time * 12) * 0.07 : 1;
          const radius = (0.22 + charge * 0.2) * pulse;
          this.rings.add(
            x + actor.facing.x * 0.6,
            0.92,
            z + actor.facing.y * 0.6,
            radius,
            radius,
            1,
            charge === 1 ? '#fff9dd' : '#ffd48e',
            0.45 + charge * 0.45,
            -Math.PI / 2,
          );
          this.rings.add(
            x,
            0.05,
            z,
            0.66 + charge * 0.12,
            0.66 + charge * 0.12,
            1,
            ROSTER[actor.id].color,
            charge * 0.22,
            -Math.PI / 2,
          );
        }
        if (actor.attackArmed && actor.attackTime > 0) {
          const progress = Math.max(0, Math.min(1, 1 - actor.attackTime / RULES.attackDuration));
          const turn = facing - Math.PI / 2 - RULES.attackArc / 2 + (progress - 0.5) * 0.75;
          // Two overlapping sweeps form a bright edge and fading follow-through.
          for (let i = 0; i < 2; i++)
            this.arcs.add(
              x,
              0.62 + i * 0.015,
              z,
              RULES.attackRange,
              RULES.attackRange,
              1,
              i === 0 ? '#fff3c7' : ROSTER[actor.id].color,
              Math.sin(Math.PI * Math.min(0.99, progress + 0.06)) * (i === 0 ? 0.7 : 0.25),
              -Math.PI / 2,
              0,
              turn - i * 0.13,
            );
        }
      }
    this.ribbon.end();
    this.rings.end();
    this.arcs.end();
  }

  stats(): { trailCount: number; segments: number; rings: number; arcs: number } {
    return {
      trailCount: this.trails.size,
      segments: this.ribbon.count,
      rings: this.rings.count,
      arcs: this.arcs.count,
    };
  }
  clear(): void {
    this.trails.clear();
    this.ribbon.clear();
    this.rings.clear();
    this.arcs.clear();
    this.lastTime = -1;
    this.round = -1;
  }
  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.ribbon.dispose();
    this.rings.dispose();
    this.arcs.dispose();
  }
}
