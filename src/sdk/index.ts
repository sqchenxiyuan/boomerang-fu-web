export { GameSession, createSession } from './session';
export type * from './types';
export type * from '../core/types';
export type { Vec2 } from '../core/math';
export { MAPS, ORIGINAL_MAPS, CUSTOM_MAPS } from '../core/arena';
/** Display language for the browser HUD and in-game labels (default `'zh'`). */
export { setLocale, getLocale } from '../core/i18n';
export type { Locale } from '../core/i18n';
export type { MapInfo } from '../core/original-maps';
export { ReplayPlayer, parseReplay, REPLAY_VERSION, SIMULATION_VERSION } from './recording';
export type { ReplayData, RecordingOptions, RecordingStatus } from './recording';
export { ReplayTransport } from './replay-transport';
export type { ReplayLoop, ReplayTransportSnapshot } from './replay-transport';
export { ReplayTimeline } from './replay-timeline';
export type { ReplayMarker, ReplayMarkerKind, ReplayTimelineSnapshot } from './replay-timeline';
export { runAIMatch, createHttpAgent } from './ai-match';
export type {
  AIMatchOptions,
  AIMatchResult,
  AgentObservation,
  AgentPolicy,
  AgentSignal,
} from './ai-match';
