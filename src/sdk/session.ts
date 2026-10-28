import { RULES } from '../core/config';
import { idleCommand } from '../core/types';
import type { Actor, Command, GameState, MatchOptions } from '../core/types';
import { Game } from '../simulation/game';
import { defaultOptions } from '../simulation/state';
import { clearActorInput } from '../simulation/input-state';
import { MatchRecorder } from './recording';
import type { ReplayData, RecordingOptions, RecordingStatus } from './recording';
import {
  actionSample,
  BotDriver,
  commandFromSamples,
  humanCommand,
  integer,
  matchOptions,
  neutralSample,
} from './control';
import type { ActionSample } from './control';
import type {
  Action,
  ControlHandle,
  ControlInfo,
  ExternalController,
  ScriptController,
  SessionAPI,
  SessionEvent,
  SessionSnapshot,
} from './types';

type Source =
  | { kind: 'human'; humanIndex: number; label: string }
  | { kind: 'bot' | 'external' | 'idle'; label: string }
  | { kind: 'script'; controller: ScriptController; label: string };

interface ControlSlot {
  actorId: number;
  source: Source;
  generation: number;
  restore?: Source;
  previous: ActionSample;
  sample?: ActionSample;
  remaining: number;
  human?: Command;
}

const idleSource = (): Source => ({ kind: 'idle', label: 'Idle' });
const scriptErrorMessage = (error: unknown): string => {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'Script controller failed with an unreadable error';
  }
};

/** Owns the simulation, input arbitration and event fan-out; no browser dependencies. */
export class GameSession implements SessionAPI {
  #game: Game;
  #bots: BotDriver;
  #controls = new Map<number, ControlSlot>();
  #listeners = new Set<(event: SessionEvent) => void>();
  #events: SessionEvent[] = [];
  #dispatching = false;
  #routing = false;
  #stepping = false;
  #status: SessionSnapshot['status'] = 'running';
  #tick = 0;
  #generation = 0;
  #epoch = 0;
  #listenerErrors = 0;
  #recorder: MatchRecorder | null = null;
  #lastRecording: ReplayData | null = null;

  constructor(options: Partial<MatchOptions> = {}) {
    const resolved = matchOptions(defaultOptions(), options);
    this.#game = new Game(resolved);
    this.#bots = new BotDriver(resolved.seed);
    this.#defaults();
  }

  get status(): SessionSnapshot['status'] {
    return this.#status;
  }

  get tick(): number {
    return this.#tick;
  }

  get recording(): RecordingStatus | null {
    return this.#recorder?.status ?? null;
  }
  startRecording(options: RecordingOptions = {}): void {
    this.#mutable();
    if (this.#recorder) throw new Error('A recording is already active');
    this.#recorder = new MatchRecorder(this.#game, options);
  }
  stopRecording(): ReplayData | null {
    this.#mutable();
    this.#finishRecording('manual');
    return this.getRecording();
  }
  getRecording(): ReplayData | null {
    return this.#lastRecording ? structuredClone(this.#lastRecording) : null;
  }
  #finishRecording(reason: ReplayData['stopReason']): void {
    if (!this.#recorder) return;
    this.#lastRecording = this.#recorder.finish(this.#game, reason);
    this.#recorder = null;
  }

  start(options: Partial<MatchOptions> = {}): void {
    this.#mutable();
    const resolved = matchOptions(this.#game.state.options, options);
    this.#finishRecording('restart');
    this.#game.start(resolved);
    this.#bots = new BotDriver(resolved.seed);
    this.#controls.clear();
    this.#defaults();
    this.#tick = 0;
    this.#epoch++;
    this.#status = 'running';
    this.#emit({ type: 'lifecycle', action: 'start' });
  }

  pause(): void {
    this.#mutable();
    if (this.#status === 'paused') return;
    this.#status = 'paused';
    this.#clearInputs();
    this.#emit({ type: 'lifecycle', action: 'pause' });
  }

  resume(): void {
    this.#mutable();
    if (this.#status === 'running') return;
    this.#clearInputs();
    this.#status = 'running';
    this.#emit({ type: 'lifecycle', action: 'resume' });
  }

  step(ticks = 1): void {
    this.#alive();
    integer(ticks, 1, 1_000_000, 'ticks');
    if (this.#stepping) throw new Error('Session.step cannot be called reentrantly');
    if (this.#status !== 'running') return;
    const epoch = this.#epoch;
    this.#stepping = true;
    try {
      for (let i = 0; i < ticks; i++) {
        if (this.#status !== 'running' || this.#epoch !== epoch) break;
        const state = this.#game.state;
        if (state.phase === 'menu' || state.phase === 'matchEnd') break;
        const phase = state.phase,
          round = state.round;
        const commands = new Map<number, Command>();
        const deferred: SessionEvent[] = [];
        if (phase === 'playing' && state.hitStop <= 0) {
          // Built-in controllers are trusted readers. Script callbacks still
          // share an immutable pre-routing baseline, each through its own copy:
          // an earlier callback failure/TTL cleanup must not change a peer's view.
          const hasScript = state.actors.some(
            (actor) => actor.alive && this.#controls.get(actor.id)?.source.kind === 'script',
          );
          const observations = hasScript ? structuredClone(state) : state;
          this.#routing = true;
          try {
            // Every controller reads the same pre-physics state; scripts get individual copies.
            for (const actor of observations.actors)
              commands.set(actor.id, this.#command(actor, observations, deferred));
          } finally {
            this.#routing = false;
          }
        }
        this.#recorder?.step(commands);
        this.#game.step(commands);
        this.#tick++;
        const events = this.#game.drainEvents();
        this.#bots.observe(events);
        if (state.phase !== phase || state.round !== round) this.#clearInputs();
        for (const event of deferred) this.#emit(event);
        if (!this.#sameEpoch(epoch)) break;
        for (const event of events) {
          this.#emit({ type: 'game', tick: this.#tick, event });
          if (!this.#sameEpoch(epoch)) break;
        }
        if (!this.#sameEpoch(epoch)) break;
        this.#emit({ type: 'step', tick: this.#tick });
        this.#recorder?.capture(this.#game);
        if (this.#recorder?.full) this.#finishRecording('size-limit');
        else if (this.#recorder && this.#recorder.status.ticks >= this.#recorder.maxTicks)
          this.#finishRecording('limit');
        else if (this.#game.state.phase === 'matchEnd') this.#finishRecording('match-end');
      }
    } finally {
      this.#stepping = false;
    }
  }

  getState(): GameState {
    this.#alive();
    return structuredClone(this.#game.state);
  }

  snapshot(): SessionSnapshot {
    return {
      tick: this.#tick,
      status: this.#status,
      state: structuredClone(this.#game.state),
      controls: [...this.#controls.values()].map((slot) => this.#info(slot)),
      listenerErrors: this.#listenerErrors,
    };
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.#alive();
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  acquire(actorId: number, label?: string): ExternalController {
    this.#mutable();
    this.#actor(actorId);
    const slot = this.#replace(actorId, {
      kind: 'external',
      label: this.#label(label, 'External'),
    });
    const session = this,
      generation = slot.generation;
    return Object.freeze({
      actorId,
      get active() {
        return session.#current(actorId, generation);
      },
      release() {
        session.#release(actorId, generation);
      },
      submit(action: Action, ttlTicks = 6) {
        session.#mutable();
        if (!session.#current(actorId, generation))
          throw new Error('External control lease has been revoked');
        integer(ttlTicks, 1, 600, 'ttlTicks');
        const sample = actionSample(action);
        if (session.#status !== 'running' || session.#game.state.phase !== 'playing') return;
        slot.sample = sample;
        slot.remaining = ttlTicks;
      },
    });
  }

  useScript(actorId: number, controller: ScriptController, label?: string): ControlHandle {
    this.#mutable();
    this.#actor(actorId);
    if (typeof controller !== 'function') throw new TypeError('controller must be a function');
    const slot = this.#replace(actorId, {
      kind: 'script',
      controller,
      label: this.#label(label, 'Script'),
    });
    return this.#handle(slot);
  }

  useBot(actorId: number): void {
    this.#mutable();
    this.#actor(actorId);
    this.#replace(actorId, { kind: 'bot', label: 'Bot' });
  }

  useHuman(actorId: number, humanIndex = 0): void {
    this.#mutable();
    this.#actor(actorId);
    this.#humanAvailable(actorId, humanIndex);
    this.#replace(actorId, { kind: 'human', humanIndex, label: `Human ${humanIndex + 1}` });
  }

  takeover(actorId: number, humanIndex = 0): ControlHandle {
    this.#mutable();
    this.#actor(actorId);
    this.#humanAvailable(actorId, humanIndex);
    const previous = this.#controls.get(actorId)!;
    if (previous.restore) throw new Error('This actor already has an active human takeover');
    const restore = previous.source.kind === 'external' ? idleSource() : previous.source;
    const slot = this.#replace(
      actorId,
      { kind: 'human', humanIndex, label: `Human ${humanIndex + 1}` },
      restore,
    );
    return this.#handle(slot);
  }

  submitHuman(humanIndex: number, command: Command): void {
    this.#mutable();
    integer(humanIndex, 0, 1, 'humanIndex');
    const sample = humanCommand(command);
    if (this.#status !== 'running' || this.#game.state.phase !== 'playing') return;
    const slot = [...this.#controls.values()].find(
      (control) => control.source.kind === 'human' && control.source.humanIndex === humanIndex,
    );
    if (slot) slot.human = sample;
  }

  destroy(): void {
    if (this.#status === 'disposed') return;
    this.#mutable();
    this.#clearInputs();
    this.#finishRecording('destroy');
    this.#status = 'disposed';
    this.#epoch++;
    this.#emit({ type: 'lifecycle', action: 'destroy' });
  }

  #command(actor: Actor, observations: GameState, deferred: SessionEvent[]): Command {
    const slot = this.#controls.get(actor.id)!;
    if (!actor.alive) {
      this.#clearSlot(slot);
      return idleCommand();
    }
    switch (slot.source.kind) {
      case 'bot':
        return this.#bots.command(observations, actor);
      case 'human': {
        const command = slot.human ?? idleCommand();
        slot.human = undefined;
        return command;
      }
      case 'external': {
        if (!slot.sample || slot.remaining <= 0) {
          this.#clearSlot(slot);
          return idleCommand();
        }
        const command = commandFromSamples(slot.sample, slot.previous);
        slot.previous = slot.sample;
        slot.remaining--;
        return command;
      }
      case 'script': {
        try {
          const result = slot.source.controller({
            actorId: actor.id,
            tick: this.#tick,
            dt: RULES.dt,
            state: structuredClone(observations),
          });
          if (result && typeof (result as unknown as { then?: unknown }).then === 'function') {
            void Promise.resolve(result).catch(() => undefined);
            throw new TypeError(
              'Script controllers must return an Action synchronously, not a Promise',
            );
          }
          const sample = actionSample(result);
          const command = commandFromSamples(sample, slot.previous);
          slot.previous = sample;
          return command;
        } catch (error) {
          const replacement = this.#replace(actor.id, idleSource(), undefined, false);
          deferred.push({ type: 'control', control: this.#info(replacement) });
          deferred.push({
            type: 'error',
            code: 'script',
            message: scriptErrorMessage(error),
            actorId: actor.id,
          });
          return idleCommand();
        }
      }
      default:
        return idleCommand();
    }
  }

  #defaults(): void {
    for (const actor of this.#game.state.actors) {
      const source: Source =
        actor.controller === 'bot'
          ? { kind: 'bot', label: 'Bot' }
          : { kind: 'human', humanIndex: actor.humanIndex, label: `Human ${actor.humanIndex + 1}` };
      this.#replace(actor.id, source, undefined, false);
    }
  }

  #replace(actorId: number, source: Source, restore?: Source, emit = true): ControlSlot {
    const previous = this.#controls.get(actorId);
    if (previous) this.#clearSlot(previous);
    const slot: ControlSlot = {
      actorId,
      source,
      restore,
      generation: ++this.#generation,
      previous: neutralSample(),
      remaining: 0,
    };
    this.#controls.set(actorId, slot);
    this.#bots.resetActor(actorId);
    if (emit) this.#emit({ type: 'control', control: this.#info(slot) });
    return slot;
  }

  #handle(slot: ControlSlot): ControlHandle {
    const session = this,
      actorId = slot.actorId,
      generation = slot.generation;
    return Object.freeze({
      actorId,
      get active() {
        return session.#current(actorId, generation);
      },
      release() {
        session.#release(actorId, generation);
      },
    });
  }

  #release(actorId: number, generation: number): void {
    if (!this.#current(actorId, generation)) return;
    this.#mutable();
    const previous = this.#controls.get(actorId)!;
    const restore = previous.restore ?? idleSource();
    if (restore.kind === 'human') this.#humanAvailable(actorId, restore.humanIndex);
    this.#replace(actorId, restore);
  }

  #current(actorId: number, generation: number): boolean {
    return this.#status !== 'disposed' && this.#controls.get(actorId)?.generation === generation;
  }

  #info(slot: ControlSlot): ControlInfo {
    return {
      actorId: slot.actorId,
      kind: slot.source.kind,
      label: slot.source.label,
      generation: slot.generation,
      ...(slot.source.kind === 'human' ? { humanIndex: slot.source.humanIndex } : {}),
    };
  }

  #clearSlot(slot: ControlSlot): void {
    slot.previous = neutralSample();
    slot.sample = undefined;
    slot.remaining = 0;
    slot.human = undefined;
    const actor = this.#game.state.actors.find((item) => item.id === slot.actorId);
    if (!actor) return;
    if (clearActorInput(actor)) this.#recorder?.reset(actor.id);
  }

  #clearInputs(): void {
    for (const slot of this.#controls.values()) this.#clearSlot(slot);
    this.#bots.reset();
  }

  #actor(actorId: number): Actor {
    integer(actorId, 0, Number.MAX_SAFE_INTEGER, 'actorId');
    const actor = this.#game.state.actors.find((item) => item.id === actorId);
    if (!actor) throw new RangeError(`Unknown actorId: ${actorId}`);
    return actor;
  }

  #humanAvailable(actorId: number, humanIndex: number): void {
    integer(humanIndex, 0, 1, 'humanIndex');
    if (
      [...this.#controls.values()].some(
        (slot) =>
          slot.actorId !== actorId &&
          slot.source.kind === 'human' &&
          slot.source.humanIndex === humanIndex,
      )
    )
      throw new Error(`Human control ${humanIndex} is already assigned to another actor`);
  }

  #label(label: string | undefined, fallback: string): string {
    if (label === undefined) return fallback;
    if (typeof label !== 'string' || !label.trim() || label.length > 128)
      throw new TypeError('Controller label must be a nonempty string of at most 128 characters');
    return label.trim();
  }

  #alive(): void {
    if (this.#status === 'disposed') throw new Error('Session has been disposed');
  }
  #sameEpoch(epoch: number): boolean {
    return this.#epoch === epoch && this.#status !== 'disposed';
  }
  #mutable(): void {
    this.#alive();
    if (this.#routing) throw new Error('Controller callbacks cannot change the running session');
  }

  #emit(event: SessionEvent): void {
    this.#events.push(structuredClone(event));
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      while (this.#events.length) {
        const next = this.#events.shift()!;
        for (const listener of [...this.#listeners]) {
          try {
            listener(structuredClone(next));
          } catch {
            this.#listenerErrors++;
          }
        }
      }
    } finally {
      this.#dispatching = false;
      if (this.#status === 'disposed') this.#listeners.clear();
    }
  }
}

export function createSession(options: Partial<MatchOptions> = {}): GameSession {
  return new GameSession(options);
}
