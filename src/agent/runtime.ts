import { NATIVE, RULES } from '../core/config';
import { ORIGINAL_MAP_RECORDS } from '../core/original-maps';
import { traceObstacles } from '../core/collision';
import { add, clampLength, distance, length, mul, sub, v } from '../core/math';
import type { Vec2 } from '../core/math';
import type {
  Actor,
  Command,
  Disc,
  GameEvent,
  GameState,
  MatchOptions,
  PowerupKind,
} from '../core/types';
import { MatchRecorder, type ReplayData } from '../sdk/recording';
import { aimPower } from '../simulation/actors';
import { isInBoundary } from '../simulation/boundary';
import { lineBlocked } from '../simulation/combat';
import { inPlants } from '../simulation/environment';
import { Game } from '../simulation/game';
import { hazardKind } from '../simulation/hazards';
import { heldDiscs } from '../simulation/inventory';
import { advancePath, findPath } from '../simulation/navigation';
import {
  ENGINE_ID,
  GAME_MAX_TICKS,
  MATCH_SCORE_GOAL,
  MAX_STEP_FRAMES,
  SUDDEN_DEATH_SECONDS,
  TICK_HZ,
  matchCharacters,
  normalizeAction,
  type AgentAction,
  type AgentFrame,
  type AgentMode,
  type AgentObservation,
  type AgentRay,
  type BoundaryView,
  type CharacterId,
  type PlayerView,
  type ProjectileView,
} from './contract';
import { matchPlaylist } from './playlist';
import { dcos, dsin } from '../core/dmath';

/*
 * Headless agent runtime: the web simulation behind the reference adapter's
 * reset / observe / step / snapshot / dispose methods. Physics never advance on
 * their own; each step runs an exact number of fixed 60 Hz frames.
 */
const U = NATIVE.scale;
/** Web coordinates are Unity × 0.4 with Y mirrored; agents see Unity units. */
export const toWorld = (p: Vec2): { x: number; y: number } => ({ x: p.x / U, y: -p.y / U });
const toWebDirection = (x: number, y: number): Vec2 => clampLength(v(x, -y), 1);
const RAY_DIRECTIONS = 16;
const RAY_LENGTH = 5;
const RAY_PROBE = 2;
const ROUTE_TICKS = 30;
const ROUTE_POINTS = 16;
const ROUTE_REACHED = 1.5 * U;

/** OriginalPlayerPowers bit values. */
const POWER_BITS: Record<PowerupKind, number> = {
  haste: 2,
  wallDash: 4,
  reverse: 8,
  shield: 16,
  explosive: 32,
  multi: 64,
  teleport: 128,
  fire: 256,
  extra: 512,
  ice: 1024,
  disguise: 2048,
  controlled: 8192,
  shrink: 16384,
  decoy: 32768,
};

const sceneFiles = new Map(
  ORIGINAL_MAP_RECORDS.map((record) => [
    record.info.id,
    { file: record.provenance.sceneFile, scene: record.info.subtitle },
  ]),
);

export interface ResetParams {
  seed: number;
  mode: AgentMode;
  characters?: readonly string[];
}
export interface RuntimeOptions {
  /** Also record a native web replay (playable in the browser replay studio). */
  record?: boolean;
  recordLabel?: string;
  /** Keep simulation events for a presentation layer (see `drainEvents`). */
  events?: boolean;
}
/** Longest ending presentation after a result, in fixed frames (4 s). */
export const PRESENT_MAX_FRAMES = 240;
interface Route {
  tick: number;
  points: Vec2[];
}

export class AgentRuntime {
  #game: Game | null = null;
  #mode: AgentMode = 'round';
  #seed = 0;
  #characters: [CharacterId, CharacterId] = ['Avocado', 'Watermelon'];
  #tick = 0;
  #done = false;
  #reason: AgentFrame['reason'] = '';
  #held: [boolean, boolean] = [false, false];
  #routes = new Map<number, Route>();
  #recorder: MatchRecorder | null = null;
  #events: GameEvent[] = [];
  #disposed = false;
  readonly options: RuntimeOptions;

  constructor(options: RuntimeOptions = {}) {
    this.options = options;
  }

  get tick(): number {
    return this.#tick;
  }
  get seed(): number {
    return this.#seed;
  }
  get mode(): AgentMode {
    return this.#mode;
  }
  get done(): boolean {
    return this.#done;
  }
  /** Live state; callers must treat it as read-only. */
  get state(): GameState {
    return this.#require().state;
  }

  reset(params: ResetParams): AgentFrame {
    this.#check();
    const seed = params.seed;
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
      throw new RangeError('seed must be a uint32');
    if (params.mode !== 'round' && params.mode !== 'match')
      throw new RangeError('mode must be round or match');
    this.#characters = matchCharacters(params.characters ?? ['Avocado', 'Watermelon']);
    this.#seed = seed;
    this.#mode = params.mode;
    const playlist = matchPlaylist(seed);
    const options: MatchOptions = {
      mode: 'bots',
      bots: 2,
      difficulty: 'normal',
      seed,
      scoring: 'kills',
      scoreGoal: params.mode === 'round' ? 1 : MATCH_SCORE_GOAL,
      mapId: playlist[0],
      mapRotation: 'fixed',
      mapPlaylist: playlist,
      suddenDeathTime: SUDDEN_DEATH_SECONDS,
    };
    this.#game = new Game(options);
    this.#tick = 0;
    this.#done = false;
    this.#reason = '';
    this.#held = [false, false];
    this.#routes.clear();
    this.#events = [];
    this.#recorder = this.options.record
      ? new MatchRecorder(this.#game, {
          label: this.options.recordLabel ?? 'Agent 对局',
          maxTicks: GAME_MAX_TICKS,
        })
      : null;
    return this.snapshot();
  }

  /** Advance 1..6 fixed frames with both players' actions held throughout. */
  step(actions: readonly unknown[], frames = MAX_STEP_FRAMES): AgentFrame {
    const game = this.#require();
    if (!Array.isArray(actions) || actions.length !== 2)
      throw new TypeError('actions must be a pair');
    if (!Number.isInteger(frames)) throw new TypeError('frames must be an integer');
    const pair = actions.map(normalizeAction) as [AgentAction, AgentAction];
    const count = Math.max(1, Math.min(MAX_STEP_FRAMES, frames));
    for (let frame = 0; frame < count; frame++) {
      if (this.#done) break;
      this.#tick++;
      if (this.#settle(game.state)) break;
      const commands = new Map<number, Command>();
      pair.forEach((action, id) => {
        const aim = toWebDirection(action.aimX, action.aimY);
        const command: Command = {
          move: toWebDirection(action.moveX, action.moveY),
          dash: action.dash,
          attack: action.melee,
          throwHeld: action.throw,
          // The release edge exists only on the first frame of a held block.
          throwReleased: this.#held[id] && !action.throw,
        };
        if (length(aim) > 0.01) command.aim = aim;
        commands.set(id, command);
        this.#held[id] = action.throw;
      });
      this.#recorder?.step(commands);
      game.step(commands);
      this.#keep(game.drainEvents());
      this.#recorder?.capture(game);
    }
    return this.snapshot();
  }

  /**
   * Presentation only, after a result: run up to `frames` idle frames of the
   * round-end / match-end sequence so the final pose and banners play out.
   * The tick, scores and result stay as reported; nothing is recorded. Stops
   * (`presented: false`) once the game leaves the ending, e.g. a new round.
   */
  present(frames: number): { frames: number; presented: boolean } {
    const game = this.#require();
    // A platform-settled result (score reached, next round already begun) has
    // nothing left to show; neither does a run that has not ended.
    if (!this.#done) return { frames: 0, presented: false };
    const ending = () => game.state.phase === 'roundEnd' || game.state.phase === 'matchEnd';
    let count = 0;
    const idle = new Map<number, Command>();
    while (count < Math.max(0, Math.min(PRESENT_MAX_FRAMES, frames)) && ending()) {
      game.step(idle);
      this.#keep(game.drainEvents());
      count++;
    }
    return { frames: count, presented: ending() };
  }

  /** Events since the last call (only with `events: true`). */
  drainEvents(): GameEvent[] {
    return this.#events.splice(0);
  }

  #keep(events: GameEvent[]): void {
    // Bounded: a presentation that stops draining must not grow without limit.
    if (this.options.events && this.#events.length < 4096) this.#events.push(...events);
  }

  snapshot(): AgentFrame {
    const state = this.#require().state;
    const scores = state.actors.slice(0, 2).map((actor) => actor.score) as [number, number];
    const winner =
      this.#done && scores[0] !== scores[1] ? ((scores[0] > scores[1] ? 0 : 1) as 0 | 1) : null;
    return {
      engine: ENGINE_ID,
      tick: this.#tick,
      tickHz: TICK_HZ,
      round: state.round,
      boundary: this.#boundary(state),
      map: sceneFiles.get(state.arena.id!)?.file ?? String(state.arena.id),
      characters: [...this.#characters],
      scores,
      done: this.#done,
      winner,
      reason: this.#reason,
      players: [this.#player(state, 0), this.#player(state, 1)],
      projectiles: state.discs.filter((disc) => !disc.dead).map(projectile),
    };
  }

  observe(player: number): AgentObservation {
    const state = this.#require().state;
    if (player !== 0 && player !== 1) throw new RangeError('player must be 0 or 1');
    const frame = this.snapshot();
    const me = state.actors[player],
      enemy = state.actors[1 - player];
    return {
      engine: ENGINE_ID,
      tick: this.#tick,
      round: state.round,
      self: frame.players[player],
      opponent: frame.players[1 - player],
      projectiles: frame.projectiles,
      scores: frame.scores,
      arena: {
        map: sceneFiles.get(state.arena.id!)?.scene ?? String(state.arena.id),
        units: 'game-world',
        rays: rays(state, me),
        boundary: frame.boundary,
        path: this.#route(state, player),
        lineOfSight: !lineBlocked(state, me.position, enemy.position),
      },
      done: this.#done,
    };
  }

  /** Native web replay of the frames run so far; null unless recording. */
  recording(): ReplayData | null {
    if (!this.#recorder || !this.#game) return null;
    return structuredClone(
      this.#recorder.finish(
        this.#game,
        this.#game.state.phase === 'matchEnd' ? 'match-end' : 'manual',
      ),
    );
  }

  dispose(): void {
    this.#game = null;
    this.#recorder = null;
    this.#routes.clear();
    this.#disposed = true;
  }

  /** The reference adapter ends a round-mode run when play stops, and a match on its winner. */
  #settle(state: GameState): boolean {
    if (state.phase !== 'roundEnd' && state.phase !== 'matchEnd') return false;
    const leader = settledLeader(state);
    if (this.#mode === 'round' || leader !== null || state.phase === 'matchEnd') {
      this.#done = true;
      this.#reason = leader !== null || state.phase === 'matchEnd' ? 'score' : 'round';
      return true;
    }
    return false;
  }

  #player(state: GameState, index: number): PlayerView {
    const actor = state.actors[index];
    const position = toWorld(actor.position),
      velocity = toWorld(actor.velocity),
      facing = toWorld(mul(actor.facing, U));
    let powers = 0;
    for (const power of actor.powers) powers |= POWER_BITS[power] ?? 0;
    if ((actor.reverseTime ?? 0) > 0) powers |= POWER_BITS.reverse;
    return {
      id: index,
      x: position.x,
      y: position.y,
      vx: velocity.x,
      vy: velocity.y,
      alive: actor.alive,
      state: !actor.alive ? 1 : actor.fall ? 2 : 0,
      discs: heldDiscs(actor),
      aimX: facing.x,
      aimY: facing.y,
      canDash: actor.alive && actor.dashCooldown <= 0,
      aimPower: aimPower(actor),
      stunned: actor.stun > 0,
      frozen: (actor.frozenTime ?? 0) > 0,
      visible: !actor.disguised,
      inPlants: inPlants(state, actor.position),
      inBounds: isInBoundary(state.boundary, actor.position),
      burnt: (actor.burnTime ?? 0) > 0,
      powers,
      character: this.#characters[index],
    };
  }

  #boundary(state: GameState): BoundaryView {
    const b = state.boundary;
    return {
      center: toWorld(b.center),
      size: { x: (b.halfSize.x * 2) / U, y: (b.halfSize.y * 2) / U },
      angle: Math.round(((-(b.angle ?? 0) * 180) / Math.PI) * 1e4) / 1e4 || 0,
      roundSeconds: state.roundTime,
      suddenDeathSeconds: state.options.suddenDeathTime ?? SUDDEN_DEATH_SECONDS,
      shrinking: b.phase === 'shrinking',
      suddenDeath: state.suddenDeathStarted,
    };
  }

  /** Navigation route toward the opponent, refreshed every 30 ticks like the adapter. */
  #route(state: GameState, player: number): { x: number; y: number }[] {
    const me = state.actors[player],
      enemy = state.actors[1 - player];
    let route = this.#routes.get(player);
    if (!route || this.#tick - route.tick >= ROUTE_TICKS) {
      route = {
        tick: this.#tick,
        points: me.alive && enemy.alive ? findPath(state.arena, me.position, enemy.position) : [],
      };
      this.#routes.set(player, route);
    }
    while (route.points.length && distance(me.position, route.points[0]) <= ROUTE_REACHED)
      route.points.shift();
    advancePath(route.points, me.position);
    return route.points.slice(0, ROUTE_POINTS).map(toWorld);
  }

  #require(): Game {
    this.#check();
    if (!this.#game) throw new Error('Call reset before using the runtime');
    return this.#game;
  }
  #check(): void {
    if (this.#disposed) throw new Error('Runtime is disposed');
  }
}

function settledLeader(state: GameState): number | null {
  if (state.pendingWinnerId !== undefined) return state.pendingWinnerId;
  const scores = state.actors.map((actor) => actor.score);
  const best = Math.max(...scores);
  if (best < state.options.scoreGoal) return null;
  const leaders = scores.filter((score) => score === best);
  return leaders.length === 1 ? scores.indexOf(best) : null;
}

function projectile(disc: Disc): ProjectileView {
  const position = toWorld(disc.position),
    velocity = toWorld(disc.velocity);
  return {
    owner: disc.ownerId >= 0 ? disc.ownerId : -1,
    x: position.x,
    y: position.y,
    vx: velocity.x,
    vy: velocity.y,
    grounded:
      disc.movement === 'dropped' || disc.movement === 'squished' || disc.state === 'dropped',
  };
}

/** Sixteen circle casts with the actor radius, and hazard/boundary probes 2 units out. */
function rays(state: GameState, actor: Actor): AgentRay[] {
  const result: AgentRay[] = [];
  for (let k = 0; k < RAY_DIRECTIONS; k++) {
    const angle = (k * Math.PI * 2) / RAY_DIRECTIONS;
    const x = dcos(angle),
      y = dsin(angle);
    const direction = toWebDirection(x, y);
    const hit = traceObstacles(
      state.arena,
      actor.position,
      mul(direction, RAY_LENGTH * U),
      RULES.playerRadius,
    );
    const clearance = hit
      ? distance(
          actor.position,
          sub(
            add(actor.position, mul(direction, RAY_LENGTH * U * hit.t)),
            mul(hit.normal, RULES.playerRadius),
          ),
        ) / U
      : RAY_LENGTH;
    const probe = add(actor.position, mul(direction, RAY_PROBE * U));
    result.push({
      x,
      y,
      clearance: Math.min(RAY_LENGTH, clearance),
      safe: hazardKind(state.arena, probe) === null && isInBoundary(state.boundary, probe),
    });
  }
  return result;
}
