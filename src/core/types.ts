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
  /** Seconds of active play before sudden death; packaged default is 180. */
  suddenDeathTime?: number;
  /** Normal pickup pool; omitted means all fourteen formal effects. */
  powerupPool?: PowerupKind[];
  /** Local practice loadout, granted through the normal rules at match start. */
  startingPowers?: PowerupKind[];
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

export type DeathCause = 'weapon' | 'explosion' | 'fall' | 'boundary' | 'fire' | 'telefrag';
export interface DeathState {
  cause: DeathCause;
  variant: 'slice' | 'squash' | 'water' | 'cliff' | 'burst';
  time: number;
  position: Vec2;
  direction: Vec2;
  seed: number;
}

export interface BoundaryState {
  /** Settled includes an early stop when fewer than two opponents remain. */
  phase: 'idle' | 'shrinking' | 'settled';
  center: Vec2;
  halfSize: Vec2;
  startCenter: Vec2;
  startHalfSize: Vec2;
  targetCenter: Vec2;
  targetHalfSize: Vec2;
  elapsed: number;
  duration: number;
  startedAt: number;
  /** Normalized time; geometry uses the packaged Hermite curve. */
  progress: number;
  ownerId: number | null;
}

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
  death?: DeathState;
  fall?: { kind: 'water' | 'cliff'; elapsed: number; duration: number };
  fallsSaved?: number;
  outOfBounds?: { remaining: number; duration: number };
  score: number;
  kills: number;
  armed: boolean;
  heldDiscs?: number;
  reverseTime?: number;
  frozenTime?: number;
  burnTime?: number;
  burnSourceId?: number;
  burnDistance?: number;
  disguised?: boolean;
  disguiseTime?: number;
  controlling?: boolean;
  controlDirection?: Vec2;
  abilityCooldown?: number;
  phaseOrigin?: Vec2;
  positivePickups?: number;
  iceExposure?: number;
  slowed?: boolean;
  decoyCreated?: boolean;
  freezeChipCooldown?: number;
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
  /** Power snapshot at launch; old SDK fixtures may omit it. */
  powers?: PowerupKind[];
  mini?: boolean;
  groupId?: number;
  trailTime?: number;
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
export interface HazardZone {
  id: number;
  kind: 'fire' | 'ice';
  position: Vec2;
  ownerId: number;
  radius: number;
  remaining: number;
  duration: number;
}
export interface DecoyState {
  id: number;
  ownerId: number;
  position: Vec2;
  previous: Vec2;
  velocity: Vec2;
  facing: Vec2;
  powers: PowerupKind[];
  alive: boolean;
  age: number;
  dashTime: number;
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
    | 'teleport'
    | 'boundary'
    | 'equip'
    | 'split'
    | 'freeze'
    | 'burn'
    | 'disguise'
    | 'decoy';
  position: Vec2;
  actorId: number;
  value?: number;
  power?: PowerupKind;
  feedback?: 'parry' | 'clash' | 'disarm';
  cause?: DeathCause;
  direction?: Vec2;
  variant?: DeathState['variant'];
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
  zones: HazardZone[];
  decoys: DecoyState[];
  arena: Arena;
  events: GameEvent[];
  nextId: number;
  pickupTimer: number;
  boundary: BoundaryState;
  suddenDeathStarted: boolean;
  roundFinishTimer: number | null;
  /** @deprecated Display-only radius derived from the current rectangle. */
  safeRadius: number;
  hitStop: number;
  weaponsGranted: boolean;
  options: MatchOptions;
}
