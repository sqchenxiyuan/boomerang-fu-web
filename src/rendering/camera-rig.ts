import { RULES } from '../core/config';
import type { Vec2 } from '../core/math';
import type { Arena, GameEvent, GameState } from '../core/types';

/**
 * Godot `OriginalCameraRig` (Unity Camera3D framing) ported to Web world units.
 *
 * Every length is the reference value × 0.4 (see docs/godot-parity.md). The rig
 * only decides *what* to frame: a focus point and a zoom ratio relative to the
 * full-arena zoom. The renderer keeps its own lens and applies the ratio to its
 * full-arena distance, so a fully zoomed-out rig shows exactly the old view.
 */
const U = 0.4;
const FOV = 16;
const TANGENT = Math.tan((FOV * 0.5 * Math.PI) / 180);
export const CAMERA_RIG = {
  minimumZoom: 75 * U,
  /** Per-target padding added to twice its collider size. */
  targetPadding: 15 * U,
  /** Frame margin: `8 × aspect` horizontally, `10` vertically. */
  marginX: 8 * U,
  marginY: 10 * U,
  /** Added to each axis of the level AABB unless the level is rotated. */
  levelPadding: 15 * U,
  focusRate: 5,
  zoomInRate: 2,
  zoomOutRate: 6,
  killWait: 0.3,
  playerAdd: 1,
  playerRemove: 1.5,
  discAdd: 0.25,
  discInfluence: 0.66,
  settledInfluence: 0.75,
  influenceDuration: 2,
  blastInfluence: 0.4,
  /** Web explosions are instantaneous; the reference blast lives about this long. */
  blastLifetime: 0.5,
} as const;

interface Target {
  position: Vec2;
  last: Vec2;
  live: Vec2;
  /** Collider diameter × influence at the time it was added (as the reference). */
  size: number;
  influence: number;
  transitioning: boolean;
  detached: boolean;
  player: boolean;
}
interface Task {
  id: string;
  target: Target;
  kind: 'add' | 'remove' | 'influence';
  timer: number;
  duration: number;
  start: Vec2;
  from: number;
  to: number;
  addInfluence: number;
  fresh: boolean;
}
export interface CameraRigFrame {
  dt: number;
  scaledDt: number;
  frozen: boolean;
  aspect: number;
  alpha: number;
}
interface LevelBox {
  center: Vec2;
  half: Vec2;
  angle: number;
}

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp01(t);
const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});
const easeOut = (t: number): number => Math.sin((Math.PI / 2) * t);
const rotate = (p: Vec2, angle: number): Vec2 => ({
  x: p.x * Math.cos(angle) - p.y * Math.sin(angle),
  y: p.x * Math.sin(angle) + p.y * Math.cos(angle),
});
const interpolate = (previous: Vec2, position: Vec2, alpha: number): Vec2 => ({
  x: previous.x + (position.x - previous.x) * alpha,
  y: previous.y + (position.y - previous.y) * alpha,
});
/** World AABB half-size of a rotated rectangle. */
const worldHalf = (half: Vec2, angle: number): Vec2 => {
  const c = Math.abs(Math.cos(angle)),
    s = Math.abs(Math.sin(angle));
  return { x: half.x * c + half.y * s, y: half.x * s + half.y * c };
};
function levelBox(arena: Arena): LevelBox {
  if (arena.boundary)
    return {
      center: { ...arena.boundary.center },
      half: { ...arena.boundary.half },
      angle: arena.boundary.angle ?? 0,
    };
  return { center: { x: 0, y: 0 }, half: { x: arena.halfWidth, y: arena.halfHeight }, angle: 0 };
}

export class CameraRig {
  aspect = 16 / 9;
  maximumZoom = 1;
  currentZoom = 1;
  targetZoom = 0;
  focus: Vec2 = { x: 0, y: 0 };
  private level: LevelBox = { center: { x: 0, y: 0 }, half: { x: 10, y: 10 }, angle: 0 };
  private tracked = new Map<string, Target>();
  private transitions: Task[] = [];
  private targets: Target[] = [];
  private shrinking: { center: Vec2; half: Vec2 } | null = null;
  private frameDelta = RULES.dt;
  private aboutToZoom = false;
  private zoomingOnKill = false;
  private killWait = -1;
  private killWaitFresh = false;
  // State diffing (the reference reacts to scene callbacks; the Web renderer sees snapshots).
  private key = '';
  private lastTime = -Infinity;
  private alive = new Map<number, boolean>();
  private discs = new Map<number, { movement: string | undefined; position: Vec2 }>();
  private decoys = new Map<number, Vec2>();
  private blasts: { id: string; position: Vec2; age: number }[] = [];
  private blastSerial = 0;

  /** Forget the previous round: the next update starts it afresh (and eases in if early). */
  reset(): void {
    this.key = '';
    this.lastTime = -Infinity;
  }
  /** Zoom as a fraction of the full-arena zoom: 1 frames the whole level. */
  get ratio(): number {
    return this.maximumZoom > 0 ? this.currentZoom / this.maximumZoom : 1;
  }
  get trackedIds(): string[] {
    return [...this.tracked.keys()];
  }
  influenceOf(id: string): number | undefined {
    return this.tracked.get(id)?.influence;
  }

  zoomFromBox(width: number, height: number): number {
    return Math.max(((width / this.aspect) * 0.5) / TANGENT, (height * 0.5) / TANGENT);
  }

  /** Camera3D.Reset: full zoom on the level centre, no targets. */
  initialize(arena: Arena, aspect: number): void {
    this.aspect = aspect;
    this.level = levelBox(arena);
    // The reference skips the padding when the root quaternion's |z| > 0.1.
    const rotated = Math.abs(Math.sin(this.level.angle / 2)) > 0.1;
    const padding = rotated ? 0 : CAMERA_RIG.levelPadding;
    const half = worldHalf(this.level.half, this.level.angle);
    this.maximumZoom = this.zoomFromBox(half.x * 2 + padding, half.y * 2 + padding);
    this.currentZoom = this.maximumZoom;
    this.targetZoom = 0;
    this.focus = { ...this.level.center };
    this.shrinking = null;
    this.tracked.clear();
    this.transitions = [];
    this.targets = [];
    this.aboutToZoom = this.zoomingOnKill = this.killWaitFresh = false;
    this.killWait = -1;
    this.alive.clear();
    this.discs.clear();
    this.decoys.clear();
    this.blasts = [];
  }

  addTarget(
    id: string,
    point: Vec2,
    diameter: number,
    influence: number,
    duration: number,
    player = false,
  ): void {
    if ((this.aboutToZoom || this.zoomingOnKill) && influence < 1) return;
    const target: Target = {
      position: { x: 0, y: 0 },
      last: { x: 0, y: 0 },
      live: { ...point },
      size: diameter * influence,
      influence,
      transitioning: duration > 0,
      detached: false,
      player,
    };
    this.tracked.set(id, target);
    if (duration > 0) this.startTransition(id, target, 'add', duration);
  }
  setTargetPosition(id: string, point: Vec2): void {
    const target = this.tracked.get(id);
    if (!target) return;
    target.live = { ...point };
    target.detached = false;
  }
  removeTarget(id: string, point: Vec2, duration = CAMERA_RIG.playerRemove): void {
    const target = this.tracked.get(id);
    if (!target) return;
    if ((this.aboutToZoom || this.zoomingOnKill) && !target.player) return;
    if (duration <= 0) {
      this.tracked.delete(id);
      return;
    }
    target.last = { ...point };
    target.live = { ...point };
    target.detached = true;
    target.transitioning = true;
    this.startTransition(id, target, 'remove', duration);
  }
  setTargetInfluence(
    id: string,
    influence: number,
    duration: number = CAMERA_RIG.influenceDuration,
  ): void {
    const target = this.tracked.get(id);
    if (!target) return;
    const task: Task = {
      id,
      target,
      kind: 'influence',
      timer: 0,
      duration,
      start: { ...this.focus },
      from: target.influence,
      to: influence,
      addInfluence: target.influence,
      fresh: true,
    };
    this.transitions.push(task);
    this.transitionStep(task, this.frameDelta);
  }
  /** The last opponent fell: freeze the target set (the winner and the victim stay framed). */
  zoomInOnKill(activeExplosives: boolean): void {
    if (this.aboutToZoom || this.zoomingOnKill || activeExplosives) return;
    this.aboutToZoom = true;
    if (this.currentZoom > CAMERA_RIG.minimumZoom * 1.1) {
      this.killWait = CAMERA_RIG.killWait;
      this.killWaitFresh = true;
    }
  }

  private startTransition(
    id: string,
    target: Target,
    kind: 'add' | 'remove',
    duration: number,
  ): void {
    const task: Task = {
      id,
      target,
      kind,
      timer: 0,
      duration,
      start: { ...this.focus },
      from: 0,
      to: 0,
      addInfluence: target.influence,
      fresh: true,
    };
    this.transitions.push(task);
    this.transitionStep(task, this.frameDelta);
  }
  private transitionStep(task: Task, delta: number): void {
    const target = task.target;
    if (task.timer >= task.duration) {
      if (task.kind === 'influence') target.influence = task.to;
      else target.transitioning = false;
      if (task.kind === 'remove') this.tracked.delete(task.id);
      this.transitions.splice(this.transitions.indexOf(task), 1);
      return;
    }
    task.timer += delta;
    const amount = easeOut(task.timer / task.duration);
    if (task.kind === 'influence') {
      target.influence = lerp(task.from, task.to, amount);
      return;
    }
    const start = task.kind === 'add' ? task.start : target.last;
    const end = task.kind === 'add' ? target.last : this.focus;
    target.position = lerp2(start, end, amount);
    if (task.kind === 'add' && task.addInfluence < 1 && (this.aboutToZoom || this.zoomingOnKill)) {
      target.transitioning = false;
      this.transitions.splice(this.transitions.indexOf(task), 1);
    }
  }
  advanceTracking(delta: number, updateTransforms: boolean, scaledDelta: number): void {
    if (this.killWait >= 0) {
      if (this.killWaitFresh) this.killWaitFresh = false;
      else {
        this.killWait -= scaledDelta;
        if (this.killWait <= 0) {
          this.killWait = -1;
          this.aboutToZoom = false;
          this.zoomingOnKill = true;
        }
      }
    }
    // Concurrent coroutines resume newest first, each skipping the frame it started on.
    for (const task of [...this.transitions].reverse()) {
      if (task.fresh) task.fresh = false;
      else if (this.transitions.includes(task)) this.transitionStep(task, delta);
    }
    if (updateTransforms)
      for (const target of this.tracked.values()) {
        if (!target.detached) target.last = { ...target.live };
        if (!target.transitioning) target.position = { ...target.last };
      }
    this.targets = [...this.tracked.values()];
  }
  weightedCentroid(): Vec2 {
    if (this.targets.length === 0) return { ...this.level.center };
    let low = lerp2(this.focus, this.targets[0].position, this.targets[0].influence);
    let high = { ...low };
    for (const target of this.targets.slice(1)) {
      const p = lerp2(this.focus, target.position, target.influence);
      low = { x: Math.min(low.x, p.x), y: Math.min(low.y, p.y) };
      high = { x: Math.max(high.x, p.x), y: Math.max(high.y, p.y) };
    }
    const middle = { x: low.x + (high.x - low.x) * 0.5, y: low.y + (high.y - low.y) * 0.5 };
    const { center, half, angle } = this.level;
    const local = rotate({ x: middle.x - center.x, y: middle.y - center.y }, -angle);
    const clamped = {
      x: Math.min(half.x, Math.max(-half.x, local.x)),
      y: Math.min(half.y, Math.max(-half.y, local.y)),
    };
    const world = rotate(clamped, angle);
    return { x: world.x + center.x, y: world.y + center.y };
  }
  /** Target zoom for the current focus and targets (Camera3D.LateUpdate bounds). */
  private frameZoom(): number {
    let lowX = this.focus.x,
      lowY = this.focus.y,
      highX = this.focus.x,
      highY = this.focus.y;
    const include = (x: number, y: number): void => {
      lowX = Math.min(lowX, x);
      lowY = Math.min(lowY, y);
      highX = Math.max(highX, x);
      highY = Math.max(highY, y);
    };
    for (const target of this.targets) {
      const middle = lerp2(this.focus, target.position, target.influence);
      const extent = (target.size * 2 + CAMERA_RIG.targetPadding) * target.influence * 0.5;
      include(middle.x - extent, middle.y - extent);
      include(middle.x + extent, middle.y + extent);
    }
    if (this.shrinking) {
      const { center, half } = this.shrinking;
      include(center.x - half.x, center.y - half.y);
      include(center.x + half.x, center.y + half.y);
    }
    const width = highX - lowX + CAMERA_RIG.marginX * this.aspect,
      height = highY - lowY + CAMERA_RIG.marginY;
    return Math.min(
      Math.max(this.zoomFromBox(width, height), CAMERA_RIG.minimumZoom),
      this.maximumZoom,
    );
  }
  step(delta: number, freeze = false): void {
    if (freeze) return;
    this.focus = lerp2(this.focus, this.weightedCentroid(), delta * CAMERA_RIG.focusRate);
    this.targetZoom = this.frameZoom();
    const speed =
      this.currentZoom > this.targetZoom ? CAMERA_RIG.zoomInRate : CAMERA_RIG.zoomOutRate;
    this.currentZoom = lerp(this.currentZoom, this.targetZoom, speed * delta);
  }
  /** Jump straight to the settled framing (replay seeks, first frame). */
  snap(): void {
    this.advanceTracking(0, true, 0);
    for (let i = 0; i < 8; i++) this.focus = this.weightedCentroid();
    this.currentZoom = this.targetZoom = this.frameZoom();
  }

  /** Feed renderer events: explosions become short-lived low-influence targets. */
  observe(events: readonly GameEvent[]): void {
    for (const event of events)
      if (event.type === 'explosion') {
        const id = `blast_${this.blastSerial++}`;
        this.addTarget(
          id,
          event.position,
          RULES.explosionRadius * 2,
          CAMERA_RIG.blastInfluence,
          CAMERA_RIG.discAdd,
        );
        this.blasts.push({ id, position: { ...event.position }, age: 0 });
      }
  }

  /**
   * Mirror the reference scene callbacks from consecutive snapshots: spawns,
   * deaths, thrown and settled discs, decoys and the shrinking safe area.
   */
  update(state: GameState, frame: CameraRigFrame): void {
    this.frameDelta = frame.dt > 0 ? frame.dt : RULES.dt;
    const key = `${state.arena.id ?? 'courtyard'}:${state.round}`;
    const jumped = state.time < this.lastTime - 1e-6 || state.time - this.lastTime > 1;
    const newRound = key !== this.key;
    if (newRound || jumped) {
      this.key = key;
      this.initialize(state.arena, frame.aspect);
      // A fresh round eases in from the level centre; a seek or a late first frame snaps.
      const fresh = newRound && state.roundTime < 1;
      this.sync(state, frame.alpha, fresh ? CAMERA_RIG.playerAdd : 0);
      if (!fresh) this.snap();
    } else this.sync(state, frame.alpha, 0);
    this.lastTime = state.time;
    this.aspect = frame.aspect;
    const b = state.boundary;
    this.shrinking =
      b.phase === 'shrinking'
        ? { center: { ...b.center }, half: worldHalf(b.halfSize, b.angle ?? 0) }
        : null;
    if (frame.dt <= 0) return;
    for (const blast of this.blasts) blast.age += frame.scaledDt;
    for (const blast of this.blasts.filter((item) => item.age >= CAMERA_RIG.blastLifetime))
      this.removeTarget(blast.id, blast.position);
    this.blasts = this.blasts.filter((item) => item.age < CAMERA_RIG.blastLifetime);
    this.advanceTracking(frame.dt, !frame.frozen, frame.scaledDt);
    this.step(frame.dt, frame.frozen);
  }

  private sync(state: GameState, alpha: number, addDuration: number): void {
    const remaining = state.actors.filter((actor) => actor.alive).length;
    for (const actor of state.actors) {
      const id = `player_${actor.id}`,
        point = interpolate(actor.previous, actor.position, alpha),
        was = this.alive.get(actor.id);
      if (was === undefined) {
        if (actor.alive) this.addTarget(id, point, RULES.playerRadius * 2, 1, addDuration, true);
      } else if (was && !actor.alive) {
        if (remaining > 1) this.removeTarget(id, point);
        else if (remaining === 1) this.zoomInOnKill(this.blasts.length > 0);
      } else if (!was && actor.alive) this.addTarget(id, point, RULES.playerRadius * 2, 1, 0, true);
      this.alive.set(actor.id, actor.alive);
      this.setTargetPosition(id, point);
    }
    const seen = new Set<number>();
    for (const disc of state.discs) {
      if (disc.dead) continue;
      seen.add(disc.id);
      const id = `disc_${disc.id}`,
        point = interpolate(disc.previous, disc.position, alpha),
        previous = this.discs.get(disc.id);
      if (!previous) {
        const explosive = disc.explosive || !!disc.powers?.includes('explosive');
        this.addTarget(
          id,
          point,
          RULES.discRadius * 2,
          explosive ? 1 : CAMERA_RIG.discInfluence,
          CAMERA_RIG.discAdd,
        );
        // Disc.StartDropped: a disarmed weapon is framed less.
        if (disc.startedDropped) this.setTargetInfluence(id, CAMERA_RIG.settledInfluence);
      } else if (previous.movement === 'free' && disc.movement === 'dropped')
        this.settle(state, id, point);
      this.discs.set(disc.id, { movement: disc.movement, position: point });
      this.setTargetPosition(id, point);
    }
    for (const [discId, item] of this.discs)
      if (!seen.has(discId)) {
        this.removeTarget(`disc_${discId}`, item.position);
        this.discs.delete(discId);
      }
    const decoys = new Set<number>();
    for (const decoy of state.decoys) {
      if (!decoy.alive) continue;
      decoys.add(decoy.id);
      const id = `decoy_${decoy.id}`,
        point = interpolate(decoy.previous, decoy.position, alpha);
      if (!this.decoys.has(decoy.id))
        this.addTarget(id, point, RULES.playerRadius * 2, 1, CAMERA_RIG.playerAdd, true);
      this.decoys.set(decoy.id, point);
      this.setTargetPosition(id, point);
    }
    for (const [decoyId, point] of this.decoys)
      if (!decoys.has(decoyId)) {
        this.removeTarget(`decoy_${decoyId}`, point);
        this.decoys.delete(decoyId);
      }
  }
  /** camera_settled: drop discs that came to rest outside the safe area, dim the rest. */
  private settle(state: GameState, id: string, point: Vec2): void {
    const b = state.boundary,
      half = worldHalf(b.halfSize, b.angle ?? 0);
    if (Math.hypot(point.x - b.center.x, point.y - b.center.y) > Math.hypot(half.x, half.y))
      this.removeTarget(id, point);
    else if (state.actors.filter((actor) => actor.alive).length > 1)
      this.setTargetInfluence(id, CAMERA_RIG.settledInfluence);
  }
}
