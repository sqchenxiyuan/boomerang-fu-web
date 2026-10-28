import type { Vec2 } from './math';
import type { POWERUPS } from './config';

export type PowerupKind = keyof typeof POWERUPS;
export type Phase = 'menu' | 'countdown' | 'playing' | 'roundEnd' | 'matchEnd';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type MapId = 'courtyard' | 'canal' | 'market' | 'switchback' | 'portals';
export type MapRotation = 'fixed' | 'cycle';
export interface MatchOptions {
  mode: 'solo' | 'local';
  bots: number;
  difficulty: Difficulty;
  seed: number;
  scoreGoal: number;
  mapId?: MapId;
  mapRotation?: MapRotation;
}
export interface Command {
  move: Vec2;
  dash: boolean;
  attack: boolean;
  throwHeld: boolean;
  throwReleased: boolean;
}
export const idleCommand = (): Command => ({
  move: { x: 0, y: 0 },
  dash: false,
  attack: false,
  throwHeld: false,
  throwReleased: false,
});

export interface Actor {
  id: number;
  controller: 'human' | 'bot';
  humanIndex: number;
  position: Vec2;
  previous: Vec2;
  velocity: Vec2;
  facing: Vec2;
  facingHistory: Vec2[];
  alive: boolean;
  deathTime: number;
  score: number;
  kills: number;
  armed: boolean;
  charge: number;
  aimMoveLag: number;
  lungeTime: number;
  lungeRecovery: number;
  recalling: boolean;
  throwBlocked: boolean;
  dashTime: number;
  dashCooldown: number;
  dashDirection: Vec2;
  attackTime: number;
  attackCooldown: number;
  attackSerial: number;
  attackArmed: boolean;
  hitTargets: number[];
  stun: number;
  invulnerable: number;
  powers: PowerupKind[];
  shield: boolean;
  bufferedDash: number;
  bufferedAttack: number;
  portalCooldown?: number;
}

export interface Disc {
  id: number;
  ownerId: number;
  damageOwnerId: number;
  position: Vec2;
  previous: Vec2;
  velocity: Vec2;
  state: 'outbound' | 'returning' | 'dropped';
  age: number;
  stateTime: number;
  charge: number;
  curve: number;
  bounces: number;
  explosive: boolean;
  fuse: number;
  grace: number;
  lastDeflector: number;
  dead: boolean;
  portalCooldown?: number;
}

export type Obstacle = {
  id: string;
  position: Vec2;
  kind: 'stone' | 'crate' | 'fountain';
  half: Vec2;
  broken: boolean;
};
export interface Pit {
  position: Vec2;
  half: Vec2;
}
export interface Arena {
  id?: MapId;
  revision?: number;
  halfWidth: number;
  halfHeight: number;
  obstacles: Obstacle[];
  pits: Pit[];
  spawns: Vec2[];
  pickupSpawns: Vec2[];
  portals?: Portal[];
}
export interface Portal {
  id: string;
  exitId: string;
  position: Vec2;
  direction: Vec2;
  radius: number;
  color: string;
}
export interface Pickup {
  id: number;
  position: Vec2;
  kind: PowerupKind;
  age: number;
}
export interface GameEvent {
  type:
    | 'throw'
    | 'dash'
    | 'slash'
    | 'bounce'
    | 'catch'
    | 'deflect'
    | 'shield'
    | 'death'
    | 'explosion'
    | 'pickup'
    | 'crate'
    | 'round'
    | 'win'
    | 'countdown'
    | 'teleport';
  position: Vec2;
  actorId: number;
  value?: number;
  power?: PowerupKind;
  feedback?: 'parry' | 'clash' | 'disarm';
  cause?: 'weapon' | 'explosion' | 'fall' | 'boundary';
  destination?: Vec2;
  entityId?: number;
  entityType?: 'actor' | 'disc';
}
export interface GameState {
  phase: Phase;
  phaseTime: number;
  time: number;
  roundTime: number;
  round: number;
  winnerId: number | null;
  matchWinnerId: number | null;
  actors: Actor[];
  discs: Disc[];
  pickups: Pickup[];
  arena: Arena;
  events: GameEvent[];
  nextId: number;
  pickupTimer: number;
  safeRadius: number;
  hitStop: number;
  weaponsGranted: boolean;
  options: MatchOptions;
}
