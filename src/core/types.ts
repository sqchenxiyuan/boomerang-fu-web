import type { Vec2 } from './math';
import type { POWERUPS } from './config';
import type { EnvironmentState } from './environment-types';
export type * from './environment-types';

export type PowerupKind = keyof typeof POWERUPS;
export type Phase = 'menu' | 'countdown' | 'playing' | 'roundEnd' | 'matchEnd';
export type Difficulty = 'easy' | 'normal' | 'hard' | 'impossible';
/** 'kills' is the reference DeathMatch + Kills rule; 'survival' is the legacy Web rule. */
export type Scoring = 'kills' | 'survival';
export type LegacyMapId = 'courtyard' | 'canal' | 'market' | 'switchback' | 'portals';
export type MapId = LegacyMapId | `original-${string}`;
export type MapRotation = 'fixed' | 'cycle';
export interface MatchOptions {
  mode: 'solo' | 'local' | 'bots';
  bots: number;
  difficulty: Difficulty;
  seed: number;
  /** Omitted: kill scoring uses 14 (two players) or 16, survival scoring uses 5. */
  scoreGoal?: number;
  scoring?: Scoring;
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

export type DeathCause =
  | 'weapon'
  | 'explosion'
  | 'fall'
  | 'boundary'
  | 'fire'
  | 'telefrag'
  | 'crush';
export interface DeathState {
  cause: DeathCause;
  variant: 'slice' | 'squash' | 'water' | 'cliff' | 'burst';
  time: number;
  position: Vec2;
  direction: Vec2;
  seed: number;
}

export interface BoundaryState {
  angle?: number;
  allowOutside?: boolean;
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
  /** Net score: points − suicides (kill scoring) or survived rounds (survival scoring). */
  score: number;
  kills: number;
  suicides?: number;
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
  wetFloor?: boolean;
  slideFactor?: number;
  surfaceDrag?: number;
  movingFloorId?: string;
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
  /** Reference Actor state. Optional so older SDK snapshots stay readable. */
  stored?: Vec2;
  lastMove?: Vec2;
  pushTime?: number;
  pushDuration?: number;
  pushStrength?: number;
  pushDirection?: Vec2;
  stunDirection?: Vec2;
  /** Player.attacksLeft / disarmsLeft / coolingAttack. */
  attacksLeft?: number;
  disarmsLeft?: number;
  coolingAttack?: boolean;
  /** Player.retrieveCharge, 0..1.4; `recalling` mirrors retrieveCharge > 0. */
  retrieveCharge?: number;
  /** Actor.isDisarmed: thrown weapon lost to free flight; walks at the unarmed speed. */
  disarmed?: boolean;
  /** Frames left in Actor.deflectedDiscs / deflectedMelees, keyed by entity id. */
  deflectedDiscs?: Record<number, number>;
  deflectedMelees?: Record<number, number>;
  meleeContacts?: number[];
  disarmContacts?: number[];
  blockContacts?: number[];
  justVulnerable?: boolean;
  /** PlayerInput's eight-entry failed-action buffer, oldest first, in scaled seconds. */
  inputBuffer?: { kind: 'attack' | 'throw' | 'dash'; age: number }[];
  /** Rotation is still easing toward `lastMove` after the input stopped. */
  turning?: boolean;
  /** Actor.isAiming latch (aim timer reached .1 s). */
  aiming?: boolean;
  /** Throw button state seen by the latest input frame (Player.inputHeld). */
  inputHeld?: boolean;
  /** Player.killerID / killerType / killer timer. */
  killerId?: number;
  killerType?: KillerType;
  killerTimer?: number;
  streak?: { count: number; last: number };
  /** Player.RequestRespawn jobs: seconds until a replacement disc arrives. */
  discRespawns?: number[];
}
export type KillerType =
  | 'Suicide'
  | 'Disc'
  | 'Melee'
  | 'Push'
  | 'Explosion'
  | 'Telefrag'
  | 'MovingObstacle'
  | 'Fire'
  | 'Freeze'
  | 'Boundary';
export type DiscMovement =
  | 'throwing'
  | 'returning'
  | 'free'
  | 'dropped'
  | 'squished'
  | 'controlled';

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
  /** Reference Disc state machine; `state` is its coarse legacy projection. */
  movement?: DiscMovement;
  stored?: Vec2;
  speedLimit?: number;
  throwTimer?: number;
  throwDuration?: number;
  throwStrength?: number;
  throwDirection?: Vec2;
  spinAngle?: number;
  spinTimer?: number;
  spinning?: boolean;
  returnTimer?: number;
  returnDirection?: Vec2;
  freeStrength?: number;
  homingRadius?: number;
  canHome?: boolean;
  canReturn?: boolean;
  canBeControlled?: boolean;
  controlledFactor?: number;
  canCollideWithOwner?: boolean;
  startedDropped?: boolean;
  deflectedTimer?: number;
  pickable?: boolean;
  colliderDisabled?: number;
  /** Actors currently overlapping each trigger, for enter-only callbacks. */
  damageContacts?: number[];
  shieldContacts?: number[];
  meleeContacts?: number[];
  /** Owner died: seconds until the disc becomes public. */
  publicTimer?: number;
  /** Projectile layer: false once a disc settles, or while it was knocked loose. */
  projectile?: boolean;
}

/** TimeKeeper: freeze frames and eased slow motion, advanced in unscaled time. */
export interface ClockState {
  timeScale: number;
  slowScale: number;
  slowTimer: number;
  slowIn: number;
  slowHold: number;
  slowOut: number;
  slowMo: boolean;
  locked: boolean;
}

export type Obstacle = {
  id: string;
  position: Vec2;
  kind: 'stone' | 'crate' | 'fountain';
  half: Vec2;
  broken: boolean;
  /** Local contours, relative to position and rotated by angle (radians). */
  paths?: Vec2[][];
  angle?: number;
  radius?: number;
  height?: number;
  /** Visual lower face, including portions buried below the walkable plane. */
  baseHeight?: number;
  material?: string;
  sourceName?: string;
  sourceLayer?: number;
  mechanismId?: string;
  disabled?: boolean;
};
/** All original terrain uses the same geometry for rendering, footing and pathfinding. */
export interface Floor {
  id: string;
  position: Vec2;
  paths: Vec2[][];
  /** Exact CircleCollider2D radius; paths remain the visual tessellation. */
  radius?: number;
  angle?: number;
  kind: 'ground' | 'ice' | 'wood' | 'falling' | 'moving';
  active: boolean;
  height?: number;
  mechanismId?: string;
  fallProgress?: number;
  warning?: number;
}
export interface Surface {
  id: string;
  position: Vec2;
  paths: Vec2[][];
  radius?: number;
  angle?: number;
  kind: 'ice' | 'water';
}
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
  /** When present, walkable terrain is the union of these shapes, not the bounds rectangle. */
  floors?: Floor[];
  surfaces?: Surface[];
  environment?: EnvironmentState;
  sourceScene?: string;
  hazard?: 'water' | 'cliff';
  boundary?: { center: Vec2; half: Vec2; angle: number; allowOutside: boolean };
}
export interface Portal {
  height?: number;
  baseHeight?: number;
  id: string;
  exitId: string;
  position: Vec2;
  direction: Vec2;
  radius: number;
  color: string;
  /** Original gates use a rectangular trigger. Legacy pads omit these fields. */
  half?: Vec2;
  triggerOffset?: Vec2;
  angle?: number;
  thickness?: number;
  safeForAI?: boolean;
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
    | 'decoy'
    | 'environment'
    | 'clash'
    | 'streak';
  mechanismId?: string;
  position: Vec2;
  actorId: number;
  value?: number;
  power?: PowerupKind;
  feedback?: 'parry' | 'clash' | 'disarm' | 'block';
  charged?: boolean;
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
  /** Remaining freeze-frame time in unscaled seconds (TimeKeeper.Freeze). */
  hitStop: number;
  /** Absent in older snapshots: time then runs at scale 1. */
  clock?: ClockState;
  /** Kill scoring: a second player reached the goal in the same round. */
  tieBreaker?: boolean;
  /** Kill scoring: the match is decided; the round finishes its resolve delay first. */
  pendingWinnerId?: number;
  weaponsGranted: boolean;
  options: MatchOptions & { scoreGoal: number };
}
