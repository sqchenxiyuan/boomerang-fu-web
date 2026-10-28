import type { Phase } from './types';

/** Static-source timings and explicitly adapted Web timings; see transitions-analysis.md. */
export const PRESENTATION = {
  reveal: 1,
  firstSpawn: 0.1,
  spawnInterval: 0.4,
  crowdedSpawnInterval: 0.35,
  landing: 0.4333,
  landingSettle: 0.18,
  ready: 1,
  go: 0.7,
  equipDelay: 1.2,
  // The original waits 1.45 scaled seconds, then uses an interactive score page.
  // Web keeps automatic rounds with an explicit, deterministic adapted interval.
  roundHold: 1.45,
  close: 0.5,
  scoreReveal: 0.4,
  scoreHold: 0.75,
} as const;

/** Shield impact has no unconditional freeze in the inspected original code. */
export const HIT_STOP = {
  death: 0.1,
  deflect: 0.25,
  shield: 0,
  // Original melee-on-melee applies this only with fewer than three opponents left.
  meleeClash: 0.2,
} as const;

export const ROUND_END_DURATION =
  PRESENTATION.roundHold + PRESENTATION.close + PRESENTATION.scoreReveal + PRESENTATION.scoreHold;

export interface IntroPose {
  visible: boolean;
  /** Vertical offset in the Web world's units; this amplitude is an art choice. */
  height: number;
  scale: number;
  /** Multiply vertical scale by this, and horizontal scale by 1 / sqrt(squash). */
  squash: number;
  /** Landing ring strength, zero outside the short settling window. */
  landing: number;
}

export interface PresentationState {
  phase: Phase;
  phaseTime: number;
  round: number;
  winnerId: number | null;
  actors: readonly { id: number; score: number }[];
}

export interface TransitionPresentation {
  stage: 'none' | 'reveal' | 'spawn' | 'ready' | 'go' | 'result' | 'close' | 'score';
  label: string;
  subtitle: string;
  /** 0 covers everything, 1 reveals everything. Use a circle reaching all corners. */
  wipeRadius: number;
  /** Multiplier for camera distance/FOV; smaller values gently move closer. */
  cameraScale: number;
  /** Scalar text entrance animation, independent of the authoritative unlock. */
  labelScale: number;
  scoreOpacity: number;
  showScores: boolean;
  winnerId: number | null;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const smooth = (value: number): number => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

function validateCount(actorCount: number): void {
  if (!Number.isInteger(actorCount) || actorCount < 1)
    throw new RangeError('actorCount must be a positive integer');
}

function checkedTime(time: number): number {
  if (!Number.isFinite(time)) throw new RangeError('presentation time must be finite');
  return Math.max(0, time);
}

function interval(actorCount: number): number {
  return actorCount > 4 ? PRESENTATION.crowdedSpawnInterval : PRESENTATION.spawnInterval;
}

/** The simulation must use this same duration to switch countdown -> playing. */
export function introDuration(actorCount: number): number {
  validateCount(actorCount);
  return PRESENTATION.firstSpawn + actorCount * interval(actorCount) + PRESENTATION.ready;
}

/** actorIndex is the presentation order, independent of actor ID or spawn position. */
export function introPose(time: number, actorIndex: number, actorCount: number): IntroPose {
  validateCount(actorCount);
  if (!Number.isInteger(actorIndex) || actorIndex < 0 || actorIndex >= actorCount)
    throw new RangeError('actorIndex must identify an actor in the presentation order');
  const local = checkedTime(time) - PRESENTATION.firstSpawn - actorIndex * interval(actorCount);
  if (local < 0) return { visible: false, height: 0, scale: 1, squash: 1, landing: 0 };
  const drop = clamp01(local / PRESENTATION.landing);
  const settle = clamp01((local - PRESENTATION.landing) / PRESENTATION.landingSettle);
  const impact = local >= PRESENTATION.landing ? Math.sin(settle * Math.PI) : 0;
  return {
    visible: true,
    height: 2.6 * (1 - drop * drop),
    scale: 0.72 + 0.28 * smooth(drop) + 0.045 * impact,
    squash: 1 - 0.2 * impact,
    landing: local >= PRESENTATION.landing ? 1 - settle : 0,
  };
}

/** Unity's non-weighted Hermite curve from level1:10126 (TransitionCircleWipe). */
function circleProgress(progress: number): number {
  const t = clamp01(progress);
  const t2 = t * t;
  const t3 = t2 * t;
  return clamp01(
    (t3 - 2 * t2 + t) * 0.5680475831031799 + (-2 * t3 + 3 * t2) + (t3 - t2) * 1.487828254699707,
  );
}

function titleScale(elapsed: number): number {
  const t = clamp01(elapsed / 0.15) - 1;
  const outBack = 1 + 2.70158 * t * t * t + 1.70158 * t * t;
  return 0.5 + 0.5 * outBack;
}

/** Pure snapshot sampling: no timers, mutation, randomness or control side effects. */
export function transitionPresentation(state: PresentationState): TransitionPresentation {
  const t = checkedTime(state.phaseTime);
  const result: TransitionPresentation = {
    stage: 'none',
    label: '',
    subtitle: '',
    wipeRadius: 1,
    cameraScale: 1,
    labelScale: 1,
    scoreOpacity: 0,
    showScores: false,
    winnerId: state.winnerId,
  };
  if (state.phase === 'countdown' && state.actors.length > 0) {
    const readyAt = introDuration(state.actors.length) - PRESENTATION.ready;
    result.stage = t < PRESENTATION.firstSpawn ? 'reveal' : t < readyAt ? 'spawn' : 'ready';
    result.wipeRadius = 1 - circleProgress(1 - t / PRESENTATION.reveal);
    result.cameraScale = 1 + 0.08 * (1 - smooth(t / readyAt));
    result.subtitle = `第 ${state.round} 回合`;
    if (t >= readyAt) {
      result.label = '准备';
      result.labelScale = titleScale(t - readyAt);
    }
  } else if (state.phase === 'playing' && t < PRESENTATION.go) {
    result.stage = 'go';
    result.label = '开始';
    result.labelScale = titleScale(t);
  } else if (state.phase === 'roundEnd') {
    const closeAt = PRESENTATION.roundHold;
    const scoreAt = closeAt + PRESENTATION.close;
    result.stage = t < closeAt ? 'result' : t < scoreAt ? 'close' : 'score';
    result.label = state.winnerId === null ? '平局' : `P${state.winnerId + 1} 赢下回合`;
    result.subtitle = state.winnerId === null ? '同时出局，不计分' : '最后站着的人 +1 分';
    result.labelScale = titleScale(t);
    result.wipeRadius = 1 - circleProgress((t - closeAt) / PRESENTATION.close);
    result.cameraScale = 1 - 0.06 * smooth(t / closeAt);
    result.showScores = t >= scoreAt;
    result.scoreOpacity = smooth((t - scoreAt) / PRESENTATION.scoreReveal);
  }
  return result;
}
