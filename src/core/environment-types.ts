import type { Vec2 } from './math';

export type EnvironmentKind =
  | 'movingObstacle'
  | 'movingFloor'
  | 'reactiveFloor'
  | 'door'
  | 'fallingFloor'
  | 'trapFloor'
  | 'switch'
  | 'trap'
  | 'plant'
  | 'destructible'
  | 'destroyer'
  | 'animated';
export type EnvironmentPhase =
  | 'idle'
  | 'preparing'
  | 'moving'
  | 'springPause'
  | 'warning'
  | 'falling'
  | 'respawning'
  | 'rising'
  | 'charging'
  | 'attacking'
  | 'cooldown'
  | 'cut';
export type EnvironmentMotion = 'linear' | 'circular' | 'eased' | 'supercircular' | 'easedsoft';

export interface EnvironmentWaypoint {
  /** World coordinates after the static hierarchy has been resolved. */
  position: Vec2;
  /** Radians; preserve explicit complete turns instead of normalizing to [-pi, pi]. */
  angle?: number;
}

/** Both instance parameters and mutable clocks are serializable; no renderer-owned motion. */
export interface EnvironmentMechanism {
  id: string;
  kind: EnvironmentKind;
  position: Vec2;
  angle?: number;
  previous?: Vec2;
  previousAngle?: number;
  /** Vertical display coordinate, positive up (Unity scene -z). */
  height?: number;
  initialHeight?: number;
  previousHeight?: number;
  velocity?: Vec2;
  angularVelocity?: number;
  parentId?: string;
  floorIds?: string[];
  obstacleIds?: string[];
  portalIds?: string[];
  /** Local trigger contours; world pose is position/angle. */
  paths?: Vec2[][];
  radius?: number;
  active?: boolean;
  phase?: EnvironmentPhase;
  elapsed?: number;
  progress?: number;
  ownerId?: number;
  flashTime?: number;
  initialized?: boolean;
  waypoints?: EnvironmentWaypoint[];
  motion?: EnvironmentMotion;
  /** Parent-space axes needed by anisotropic/circular easing after static hierarchy flattening. */
  motionOrigin?: Vec2;
  motionAngle?: number;
  targetIndex?: number;
  startPosition?: Vec2;
  targetPosition?: Vec2;
  startAngle?: number;
  targetAngle?: number;
  duration?: number;
  minDuration?: number;
  maxDuration?: number;
  currentDuration?: number;
  targetDuration?: number;
  preDelay?: number;
  spring?: boolean;
  springPause?: number;
  returnDuration?: number;
  returning?: boolean;
  reverse?: boolean;
  randomizedStart?: boolean;
  rotating?: boolean;
  clockwise?: boolean;
  rotationDuration?: number;
  rotationDurations?: number[];
  rotationSmoothingVelocity?: number;
  rotationModulation?: { amplitude: number; rate: number; initialDuration: number };
  targetIds?: string[];
  cooldown?: number;
  cooldownDuration?: number;
  oneShot?: boolean;
  automaticDelay?: number;
  closed?: boolean;
  canClose?: boolean;
  closedHeight?: number;
  openHeight?: number;
  startHeight?: number;
  targetHeight?: number;
  /** Door obstacle exists when height is above this threshold. */
  solidHeight?: number;
  warningDuration?: number;
  fallDuration?: number;
  fallDistance?: number;
  respawnDuration?: number;
  riseDuration?: number;
  solidAfter?: number;
  hitsLeft?: number;
  burnHealth?: number;
  burnTime?: number;
  disturbance?: number;
  disturbedDirection?: Vec2;
  lastMeleeSerials?: Record<string, number>;
  /** Unity script/path IDs retained as provenance, never executable code. */
  source?: { file: string; pathId: number; className: string };
}

export interface EnvironmentState {
  mechanisms: EnvironmentMechanism[];
  initialized?: boolean;
  navigationTimer?: number;
  /** One transform parent for each ground object; keys are type-prefixed entity IDs. */
  riders?: Record<string, string>;
  collapse?: {
    enabled: boolean;
    interval: number;
    remaining: number;
    /** Nearest to finalPoint first; remove from the end, leaving six intact. */
    playlist?: string[];
    finalPoint?: Vec2;
  };
}

export interface EnvironmentStrike {
  kind: 'melee' | 'disc' | 'explosion';
  position: Vec2;
  /** Segment start for swept disc hits. */
  from?: Vec2;
  direction: Vec2;
  radius: number;
  actorId: number;
  /** Used to prevent one melee window repeatedly flipping the same switch. */
  serial?: number;
  fire?: boolean;
  ice?: boolean;
}
