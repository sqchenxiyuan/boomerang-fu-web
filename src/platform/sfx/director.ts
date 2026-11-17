import { NATIVE } from '../../core/config';
import { distance, length } from '../../core/math';
import { introDuration, introPose } from '../../core/presentation';
import type { GameEvent, GameState, PowerupKind } from '../../core/types';
import { obstacleDistance } from '../../core/geometry';
import { inPlants } from '../../simulation/environment';
import type { SfxPlayer } from './player';
import type { SoundName } from './recipes';

/*
 * Decides what to play: simulation events map to sounds (by material, charge,
 * cause, mechanism), and continuous state drives the rest (footsteps, landing,
 * loops for burning/recall/charge, out-of-bounds beeps, fuse ticks). It reads
 * detached frame states only and never feeds anything back.
 */
const PICKUP_MOTIFS: Partial<Record<PowerupKind, number[]>> = {
  shield: [69, 74, 81],
  haste: [74, 76, 77, 79, 81],
  explosive: [62, 69],
  wallDash: [69, 76, 81],
  reverse: [77, 76, 74, 73],
  multi: [86, 81, 89, 86],
  teleport: [74, 81, 86],
  fire: [81, 86],
  extra: [86, 86],
  ice: [93, 98, 101],
  disguise: [62, 69],
  controlled: [74, 77, 74, 81],
  shrink: [81, 77, 74, 69],
  decoy: [74, 81, 74],
};
const STREAK_RUN = [74, 77, 81, 86, 89, 93, 98];
/** One walk loop (0.65 s) holds two footfalls at move_speed_parameter 1. */
const STEPS_PER_SECOND = 2 / 0.65;

interface ActorMemory {
  steps: number;
  dashing: boolean;
  falling: boolean;
  frozen: boolean;
  visible: boolean;
  height: number;
  rustle: number;
  beep: number;
}

export class SfxDirector {
  private memory = new Map<number, ActorMemory>();
  private fuses = new Map<number, number>();
  private state: GameState | null = null;
  private phase = '';
  private pending: { at: number; name: SoundName; pan: number }[] = [];
  private clock = 0;

  constructor(
    private readonly player: SfxPlayer,
    private readonly panAt: (x: number) => number,
  ) {}

  reset(): void {
    this.memory.clear();
    this.fuses.clear();
    this.pending = [];
    this.player.silenceLoops();
  }

  private pan(event: GameEvent): number {
    return Number.isFinite(event.position?.x) ? this.panAt(event.position.x) : 0;
  }

  /** Material of whatever a disc just bounced off. */
  private bounceSound(event: GameEvent): SoundName {
    const arena = this.state?.arena;
    if (!arena) return 'ricoStone';
    let best: { d: number; material: string; kind: string } | null = null;
    for (const obstacle of arena.obstacles) {
      if (obstacle.broken || obstacle.disabled) continue;
      const d = obstacleDistance(obstacle, event.position);
      if (!best || d < best.d) best = { d, material: obstacle.material ?? '', kind: obstacle.kind };
    }
    if (!best || best.d > 0.6) return 'ricoStone';
    const material = best.material.toLowerCase();
    if (material === 'bamboo') return 'ricoBamboo';
    if (material === 'tree') return 'ricoTree';
    if (material === 'shrub') return 'ricoShrub';
    if (best.kind === 'crate' || /wood|crate/.test(material)) return 'ricoWood';
    return 'ricoStone';
  }

  private environmentSound(event: GameEvent): SoundName | null {
    const mechanism = this.state?.arena.environment?.mechanisms.find(
      (m) => m.id === event.mechanismId,
    );
    switch (mechanism?.kind) {
      case 'switch':
        return 'switch';
      case 'door':
      case 'movingObstacle':
      case 'reactiveFloor':
        return 'stoneGrind';
      case 'fallingFloor':
      case 'trapFloor':
      case 'trap':
        return 'floorCrack';
      case 'plant':
        return 'reeds';
      case 'destructible':
        return 'breakCrate';
      default:
        return null;
    }
  }

  events(events: readonly GameEvent[]): void {
    let count = 0;
    for (const event of events) {
      if (count++ >= 16) break;
      const pan = this.pan(event);
      const play = (name: SoundName, gain = 1, delay = 0) =>
        this.player.play(name, { pan, gain, delay });
      switch (event.type) {
        case 'throw': {
          const charge = Math.max(0, Math.min(1, event.value ?? 0));
          play(charge >= 1 ? 'throwFull' : charge > 0.35 ? 'throwHeavy' : 'throw');
          break;
        }
        case 'dash':
          play('dash');
          break;
        case 'slash':
          play(event.value ? 'melee' : 'swingEmpty');
          break;
        case 'deflect':
          if (event.feedback === 'clash') play('clash');
          else if (event.feedback === 'disarm') {
            play('disarmHit');
            if (event.value) play('ricoWood', 0.6, 0.12);
          } else play(event.charged ? 'parryCharged' : 'parry');
          break;
        case 'clash':
          play('ricoDisc', event.value ? 1 : 0.4);
          break;
        case 'bounce':
          play(this.bounceSound(event), 0.45 + 0.55 * Math.min(1, event.value ?? 0.6));
          break;
        case 'catch':
          play('catch');
          break;
        case 'equip':
          play('equip');
          break;
        case 'shield':
          play('shieldOff');
          break;
        case 'crate':
          play('breakCrate');
          break;
        case 'death':
          this.death(event, pan);
          break;
        case 'explosion': {
          const mini = (event.value ?? 4) < 3;
          play(
            mini
              ? 'explosionMini'
              : event.power === 'fire'
                ? 'explosionFire'
                : event.power === 'ice'
                  ? 'explosionIce'
                  : 'explosion',
          );
          break;
        }
        case 'pickup': {
          play('pickup');
          if (event.power === 'shield') play('shieldOn', 0.8, 0.1);
          (PICKUP_MOTIFS[event.power!] ?? []).forEach((midi, i) =>
            this.player.note(midi, { pan, delay: 0.18 + i * 0.05, gain: 0.8 }),
          );
          break;
        }
        case 'teleport': {
          const portal = this.state?.arena.portals?.some(
            (p) => distance(p.position, event.position) < 0.2,
          );
          play(event.entityType === 'disc' ? 'portalDisc' : portal ? 'portal' : 'teleport');
          break;
        }
        case 'countdown':
          this.player.play('roundReady');
          break;
        case 'round':
          this.player.play('roundTitle');
          break;
        case 'boundary':
          this.player.play('zoneAlarm');
          break;
        case 'freeze':
          play('freeze');
          break;
        case 'burn':
          play('ignite');
          break;
        case 'split':
          play('split');
          break;
        case 'disguise':
          play('disguise');
          break;
        case 'decoy':
          play(event.value ? 'decoySpawn' : 'decoyDie');
          break;
        case 'environment': {
          const name = this.environmentSound(event);
          if (name) play(name);
          break;
        }
        case 'streak': {
          const n = Math.max(2, Math.round(event.value ?? 2)),
            start = Math.min(n - 2, 3);
          this.player.play('alert', { delay: 0.08 });
          STREAK_RUN.slice(start, start + (n >= 4 ? 4 : 3)).forEach((midi, i) =>
            this.player.note(midi, { delay: 0.16 + i * 0.05, gain: 0.9 }),
          );
          break;
        }
        case 'win':
          this.player.play('victory');
          break;
      }
    }
  }

  private death(event: GameEvent, pan: number): void {
    const play = (name: SoundName, gain = 1, delay = 0) =>
      this.player.play(name, { pan, gain, delay });
    switch (event.variant) {
      case 'water':
        play('splashBig');
        break;
      case 'cliff':
        play('deathFall');
        break;
      case 'squash':
        // An explosion plays its own blast; the body adds a softer squash.
        play('deathSquash', event.cause === 'explosion' ? 0.55 : 1);
        break;
      case 'burst':
        play(event.cause === 'fire' ? 'deathBurn' : 'deathBoundary');
        break;
      default: {
        const victim = this.state?.actors.find((a) => a.id === event.actorId);
        if ((victim?.frozenTime ?? 0) > 0) play('shatter');
        else {
          play('deathSlice');
          // The top half lands a moment later (Character faceplant).
          this.pending.push({ at: this.clock + 0.55, name: 'faceplant', pan });
        }
      }
    }
  }

  /** Per rendered frame, with the scaled simulation time that elapsed. */
  observe(state: GameState, dt: number, active: boolean): void {
    this.state = state;
    this.clock += dt;
    if (!active) {
      this.player.silenceLoops();
      this.phase = state.phase;
      return;
    }
    for (const job of this.pending.splice(0))
      if (job.at <= this.clock) this.player.play(job.name, { pan: job.pan });
      else this.pending.push(job);
    if (this.phase === 'countdown' && state.phase === 'playing') this.player.play('roundGo');
    if (state.phase === 'roundEnd' && this.phase === 'playing') this.player.silenceLoops();
    this.phase = state.phase;

    const order = [...state.actors].sort((a, b) => b.score - a.score || a.id - b.id);
    let burning = 0,
      burnPan = 0,
      recalling = 0,
      controlling = 0,
      sliding = 0;
    for (const actor of state.actors) {
      let memory = this.memory.get(actor.id);
      if (!memory) {
        memory = {
          steps: 0,
          dashing: false,
          falling: false,
          frozen: false,
          visible: true,
          height: 0,
          rustle: 0,
          beep: 0,
        };
        this.memory.set(actor.id, memory);
      }
      const pan = this.panAt(actor.position.x);
      // Round entrance: whoosh when the actor appears, thud when it lands.
      if (state.phase === 'countdown') {
        const pose = introPose(
          state.phaseTime,
          order.findIndex((a) => a.id === actor.id),
          state.actors.length,
        );
        if (pose.visible && !memory.visible && state.phaseTime < introDuration(state.actors.length))
          this.player.play('spawnWhoosh', { pan, gain: 0.7 });
        if (memory.height > 0.05 && pose.height <= 0.05) this.player.play('spawnLand', { pan });
        memory.visible = pose.visible;
        memory.height = pose.height;
      } else {
        memory.visible = true;
        memory.height = 0;
      }
      if (!actor.alive || state.phase !== 'playing') {
        memory.dashing = memory.falling = memory.frozen = false;
        continue;
      }
      const speed = length(actor.velocity) / NATIVE.scale / 11;
      const dashing = actor.dashTime > 0,
        falling = !!actor.fall,
        frozen = (actor.frozenTime ?? 0) > 0;
      if (memory.dashing && !dashing && !falling) this.player.play('dashEnd', { pan, gain: 0.8 });
      if (falling && !memory.falling) this.player.play('hop', { pan });
      if (memory.frozen && !frozen) this.player.play('unfreeze', { pan });
      memory.dashing = dashing;
      memory.falling = falling;
      memory.frozen = frozen;
      // Footsteps at the walk clip's cadence (two per loop, scaled by speed).
      if (!dashing && !falling && !frozen && speed > 0.25) {
        memory.steps += dt * STEPS_PER_SECOND * Math.min(speed, 2);
        if (memory.steps >= 1) {
          memory.steps -= Math.floor(memory.steps);
          this.player.play('footstep', {
            pan,
            rate: 0.92 + actor.id * 0.06,
            gain: 0.8 + 0.2 * Math.min(1, speed),
          });
        }
        if (inPlants(state, actor.position) && (memory.rustle -= dt) <= 0) {
          memory.rustle = 0.3;
          this.player.play('reeds', { pan });
        }
        if (actor.wetFloor) sliding++;
      } else memory.steps = 0.6;
      // Out of bounds: beeps that quicken and rise as the timer runs out.
      if (actor.outOfBounds) {
        const left = actor.outOfBounds.remaining / Math.max(0.01, actor.outOfBounds.duration);
        if ((memory.beep -= dt) <= 0) {
          memory.beep = 0.12 + 0.45 * left;
          this.player.play('oobWarning', { pan, rate: 1 + 0.7 * (1 - left), jitter: false });
        }
      } else memory.beep = 0;
      if ((actor.burnTime ?? 0) > 0) {
        burning++;
        burnPan = pan;
      }
      if (actor.controlling) controlling++;
      else if (actor.recalling) recalling++;
      if (actor.charge > 0.05 && actor.armed)
        this.player.loop(`charge:${actor.id}`, 'chargeLoop', {
          gain: 0.7,
          rate: 0.75 + 0.6 * Math.min(1, actor.charge / 1.2),
          pan,
        });
    }
    if (burning)
      this.player.loop('burning', 'burningLoop', {
        gain: Math.min(1.4, 0.8 + 0.3 * burning),
        pan: burnPan,
      });
    if (recalling) this.player.loop('recall', 'recallLoop', { gain: 1 });
    if (controlling) this.player.loop('telekinesis', 'telekinesisLoop', { gain: 1 });
    if (sliding) this.player.loop('slide', 'slideLoop', { gain: 1 });
    const fire = state.zones.filter((zone) => zone.kind === 'fire').length;
    if (fire && state.phase === 'playing')
      this.player.loop('firecells', 'fireCellLoop', { gain: Math.min(1.2, 0.4 + fire * 0.04) });
    const moving = state.arena.environment?.mechanisms.some(
      (m) => (m.kind === 'movingObstacle' || m.kind === 'movingFloor') && m.active !== false,
    );
    if (moving && state.phase === 'playing')
      this.player.loop('machinery', 'rumbleLoop', { gain: 0.6 });
    // Explosive discs tick faster as the fuse burns down.
    for (const disc of state.discs) {
      if (!disc.explosive || disc.dead) continue;
      const next = (this.fuses.get(disc.id) ?? 0) - dt;
      if (next <= 0) {
        this.player.play('fuseTick', {
          pan: this.panAt(disc.position.x),
          rate: 1 + Math.max(0, 1.5 - disc.fuse) * 0.3,
          jitter: false,
        });
        this.fuses.set(disc.id, 0.08 + 0.22 * Math.min(1, disc.fuse / 1.5));
      } else this.fuses.set(disc.id, next);
    }
    this.player.endFrame();
  }
}
