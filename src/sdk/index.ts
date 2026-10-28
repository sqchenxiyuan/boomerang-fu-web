export { GameSession, createSession } from './session';
export type * from './types';
export type * from '../core/types';
export type { Vec2 } from '../core/math';
export { MAPS, ORIGINAL_MAPS, CUSTOM_MAPS } from '../core/arena';
export type { MapInfo } from '../core/original-maps';
export { ReplayPlayer, parseReplay, REPLAY_VERSION, SIMULATION_VERSION } from './recording';
export type { ReplayData, RecordingOptions, RecordingStatus } from './recording';
export { runAIMatch, createHttpAgent } from './ai-match';
export type {
  AIMatchOptions,
  AIMatchResult,
  AgentObservation,
  AgentPolicy,
  AgentSignal,
} from './ai-match';
