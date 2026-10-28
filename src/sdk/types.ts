import type { Command, GameEvent, GameState, MatchOptions } from '../core/types';
import type { Vec2 } from '../core/math';

/** A full button-state sample. Omitted controls are neutral; edges are derived by the SDK. */
export interface Action {
  move?: Vec2;
  attack?: boolean;
  dash?: boolean;
  throw?: boolean;
}
export type ControlKind = 'human' | 'bot' | 'external' | 'script' | 'idle';
export interface ControlInfo {
  actorId: number;
  kind: ControlKind;
  label: string;
  humanIndex?: number;
  generation: number;
}
export interface SessionSnapshot {
  tick: number;
  status: 'running' | 'paused' | 'disposed';
  state: GameState;
  controls: ControlInfo[];
  listenerErrors: number;
}
export interface ScriptContext {
  actorId: number;
  tick: number;
  dt: number;
  /** A detached snapshot; modifying it never changes the running game. */
  state: GameState;
}
export type ScriptController = (context: ScriptContext) => Action;
export interface ControlHandle {
  readonly actorId: number;
  readonly active: boolean;
  release(): void;
}
export interface ExternalController extends ControlHandle {
  /** Samples last 1..600 input-consuming combat ticks (default 6). Pauses/hit stop do not consume TTL; phase changes clear samples. Expiry cancels charging without throwing. */
  submit(action: Action, ttlTicks?: number): void;
}
export type SessionEvent =
  | { type: 'game'; tick: number; event: GameEvent }
  | { type: 'step'; tick: number }
  | { type: 'control'; control: ControlInfo }
  | { type: 'lifecycle'; action: 'start' | 'pause' | 'resume' | 'destroy' }
  | { type: 'error'; code: 'script'; message: string; actorId: number };

/** Public core contract. The implementation lives in session.ts, without DOM/Three imports. */
export interface SessionAPI {
  /** Allocation-free lifecycle reads; remain available after destroy. */
  readonly status: SessionSnapshot['status'];
  readonly tick: number;
  start(options?: Partial<MatchOptions>): void;
  pause(): void;
  resume(): void;
  step(ticks?: number): void;
  getState(): GameState;
  snapshot(): SessionSnapshot;
  onEvent(listener: (event: SessionEvent) => void): () => void;
  acquire(actorId: number, label?: string): ExternalController;
  useScript(actorId: number, controller: ScriptController, label?: string): ControlHandle;
  useBot(actorId: number): void;
  useHuman(actorId: number, humanIndex?: number): void;
  takeover(actorId: number, humanIndex?: number): ControlHandle;
  /** Browser adapters only submit human commands to actors currently controlled by that human. */
  submitHuman(humanIndex: number, command: Command): void;
  destroy(): void;
}
