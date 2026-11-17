import { SIMULATION_VERSION } from '../sdk/recording';

/*
 * Agent contract aligned with the MUNDI Godot adapter (`arkena.game.v1`):
 * the same observation/action shape, units, cadence and press/hold/release
 * semantics, so one `decide(observation, memory)` strategy runs on both engines.
 * Coordinates are reported in the reference game-world units (Unity, Y up).
 */
export const AGENT_PROTOCOL = 'arkena.game.v1';
/** Line protocol of the MUNDI local runner (reset / advance / snapshot / quit). */
export const LOCAL_PROTOCOL = 'mundi.local.v1';
export const ENGINE_ID = `boomerang-garden-web-${SIMULATION_VERSION}-agent.1`;
export const TICK_HZ = 60;
/** Strategies decide once per this many fixed frames. */
export const DECISION_TICKS = 6;
export const MAX_STEP_FRAMES = 6;
/** 30 minutes of simulation; reaching it never invents a winner. */
export const GAME_MAX_TICKS = 108000;
export const MATCH_SCORE_GOAL = 14;
export const SUDDEN_DEATH_SECONDS = 60;
export const LIMITS = Object.freeze({
  codeBytes: 24000,
  memoryBytes: 8 * 1024 * 1024,
  turnMs: 30,
  memoryJsonBytes: 8000,
});
export const ACTION_KEYS = ['moveX', 'moveY', 'aimX', 'aimY', 'throw', 'dash', 'melee'] as const;
export const CHARACTERS = ['Avocado', 'Watermelon', 'Bread', 'Banana', 'Milk', 'Coffee'] as const;
export type CharacterId = (typeof CHARACTERS)[number];
export const DEFAULT_CHARACTERS: readonly [CharacterId, CharacterId] = ['Avocado', 'Watermelon'];
export type AgentMode = 'round' | 'match';

export interface AgentAction {
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  /** true holds/charges; the true → false edge releases the throw once. */
  throw: boolean;
  /** Repeated request on every frame it is true; game cooldowns decide. */
  dash: boolean;
  melee: boolean;
}
export const neutralAction = (): AgentAction => ({
  moveX: 0,
  moveY: 0,
  aimX: 0,
  aimY: 0,
  throw: false,
  dash: false,
  melee: false,
});

/** Same rules as the MUNDI platform: finite numbers clamp to [-1, 1], booleans only. */
export function normalizeAction(input: unknown): AgentAction {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Strategy must return an action object');
  const value = input as Record<string, unknown>;
  const out = neutralAction();
  for (const key of ['moveX', 'moveY', 'aimX', 'aimY'] as const) {
    const item = value[key] ?? 0;
    if (typeof item !== 'number' || !Number.isFinite(item))
      throw new Error(`${key} must be a finite number`);
    out[key] = Math.max(-1, Math.min(1, item));
  }
  for (const key of ['throw', 'dash', 'melee'] as const) {
    const item = value[key];
    if (item !== undefined && typeof item !== 'boolean')
      throw new Error(`${key} must be a boolean`);
    out[key] = item === true;
  }
  return out;
}

export function matchCharacters(value: unknown = DEFAULT_CHARACTERS): [CharacterId, CharacterId] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] === value[1] ||
    !value.every((id) => (CHARACTERS as readonly string[]).includes(id))
  )
    throw new RangeError(`characters must be two different ids from: ${CHARACTERS.join(', ')}`);
  return [value[0], value[1]];
}

export interface PlayerView {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: boolean;
  /** OriginalActorMotion.State: 0 alive, 1 dead, 2 falling. */
  state: 0 | 1 | 2;
  discs: number;
  /** Facing unit vector. */
  aimX: number;
  aimY: number;
  canDash: boolean;
  /** Eased charge, 0..1. */
  aimPower: number;
  stunned: boolean;
  frozen: boolean;
  visible: boolean;
  inPlants: boolean;
  inBounds: boolean;
  burnt: boolean;
  /** OriginalPlayerPowers bit mask. */
  powers: number;
  character: CharacterId;
}
export interface ProjectileView {
  /** Owning player, or -1 for a public disc. */
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
}
export interface BoundaryView {
  center: { x: number; y: number };
  /** Full extents, like the reference boundary size. */
  size: { x: number; y: number };
  /** Degrees. */
  angle: number;
  roundSeconds: number;
  suddenDeathSeconds: number;
  shrinking: boolean;
  suddenDeath: boolean;
}
export interface AgentFrame {
  engine: string;
  tick: number;
  tickHz: number;
  round: number;
  boundary: BoundaryView;
  /** Reference scene file (level2 …). */
  map: string;
  characters: [CharacterId, CharacterId];
  scores: [number, number];
  done: boolean;
  winner: 0 | 1 | null;
  reason: '' | 'score' | 'round';
  players: [PlayerView, PlayerView];
  projectiles: ProjectileView[];
}
export interface AgentRay {
  x: number;
  y: number;
  clearance: number;
  safe: boolean;
}
export interface AgentObservation {
  engine: string;
  tick: number;
  round: number;
  self: PlayerView;
  opponent: PlayerView;
  projectiles: ProjectileView[];
  scores: [number, number];
  arena: {
    /** Reference scene name (LevelEnclosed …). */
    map: string;
    units: 'game-world';
    rays: AgentRay[];
    boundary: BoundaryView;
    path: { x: number; y: number }[];
    lineOfSight: boolean;
  };
  done: boolean;
}

export const INSTRUCTIONS = `This is the Boomerang Garden web simulation ${ENGINE_ID}, aligned with the MUNDI Godot Boomerang Fu adapter (arkena.game.v1). It is a separate engine: physics follow the Godot reference values, but trajectories are not bit-identical to Godot, so results and replays are not interchangeable across engines.
Fixed time is 60 Hz; decide runs every ${DECISION_TICKS} frames and the returned action is held for those frames. Coordinates use the reference game-world units (Unity, Y up; maps about 43 units wide, melee about 4 units, projectile danger about 5 units).
Observe self/opponent {id,x,y,vx,vy,alive,state(0 alive,1 dead,2 falling),discs,canDash,aimPower,stunned,frozen,visible,inPlants,inBounds,burnt,powers(bit mask),aimX,aimY,character}; projectiles {owner,x,y,vx,vy,grounded}; scores [self-index order]; arena {map,units,lineOfSight,path:[{x,y}],rays:[{x,y,clearance,safe}],boundary}.
arena.rays are 16 directions: clearance is the circle-cast distance to the first wall (max 5); safe=false means the point 2 units away is over a hazard or outside the boundary. arena.path holds up to 16 waypoints of the web navigation graph toward the opponent, refreshed every 30 ticks; empty means unavailable. arena.boundary has center, full size, angle (degrees), roundSeconds, suddenDeathSeconds (${SUDDEN_DEATH_SECONDS}), shrinking and suddenDeath. After ${SUDDEN_DEATH_SECONDS} active round seconds the boundary shrinks.
Actions: moveX/moveY move; aimX/aimY snap facing each frame (alive, standing, not stunned) but the turn eases back toward the last movement and a throw flies along the last movement direction, as in the reference. throw=true holds/charges and the true→false edge releases once; continuous true never throws. dash/melee are requested on every frame they are true, subject to game cooldowns and the input buffer.
Modes: round (one round, scoring goal 1) or match (first to ${MATCH_SCORE_GOAL} net kills on the reference two-player random map playlist; the map changes between rounds).
Return function decide(observation, memory) => {action:{moveX,moveY,aimX,aimY,throw,dash,melee},memory:{}}. No imports, async, DOM, networking or Date; Math.random is seeded. Finite vectors -1..1, booleans, code <${LIMITS.codeBytes / 1000}KB, memory JSON <${LIMITS.memoryJsonBytes / 1000}KB, QuickJS ${LIMITS.memoryBytes / 1024 / 1024}MB/${LIMITS.turnMs}ms per decision.`;
