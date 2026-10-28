import { RULES } from '../core/config';
import type { Command, GameEvent, GameState } from '../core/types';
import { Game } from '../simulation/game';
import type { SimulationCheckpoint } from '../simulation/game';
import { clearActorInput } from '../simulation/input-state';
import { integer, matchOptions } from './control';
import { defaultOptions } from '../simulation/state';
import { validateReplayState } from './replay-validation';

export const REPLAY_VERSION = 1;
export const SIMULATION_VERSION = '0.6.0';
export const MAP_DATA_VERSION = '2f74e5c3393ef5555a3f91e461dd581fab65bad2154870d91503698649600e44';
export const MAX_REPLAY_TICKS = 60 * 60 * 30;
export const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const RECORDING_BUDGET = 32 * 1024 * 1024;
const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

export type ReplayOperation =
  | { type: 'step'; count: number; commands: [number, Command][] }
  | { type: 'reset'; actors: number[] };
export interface ReplayCheckpoint {
  tick: number;
  operation: number;
  world: SimulationCheckpoint;
  hash: string;
}
export interface ReplayData {
  format: 'boomerang-garden.replay';
  version: number;
  simulationVersion: string;
  mapDataVersion: string;
  tickRate: number;
  createdAt: string;
  durationTicks: number;
  label: string;
  operations: ReplayOperation[];
  checkpoints: ReplayCheckpoint[];
  finalHash: string;
  stopReason: 'manual' | 'match-end' | 'restart' | 'destroy' | 'limit' | 'size-limit';
}
export interface RecordingOptions {
  label?: string;
  checkpointInterval?: number;
  maxTicks?: number;
}
export interface RecordingStatus {
  ticks: number;
  seconds: number;
  checkpoints: number;
  operations: number;
  estimatedBytes: number;
}

/** Drift detection, not authentication. Ignore sub-nanounit floating point differences
 * between JS engine math implementations; RNG and integer identifiers stay exact. */
export function checkpointHash(value: SimulationCheckpoint): string {
  const json = JSON.stringify(value, (_key, item) =>
    typeof item === 'number' && !Number.isInteger(item)
      ? Number(item.toFixed(9))
      : item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
  );
  let hash = 2166136261;
  for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class MatchRecorder {
  private data: ReplayData;
  private interval: number;
  readonly maxTicks: number;
  private lastCommands = '';
  private sealed = true;
  private bytes = 1024;
  get full(): boolean {
    return this.bytes >= RECORDING_BUDGET;
  }

  constructor(game: Game, options: RecordingOptions = {}) {
    this.interval = integer(options.checkpointInterval ?? 600, 60, 3600, 'checkpointInterval');
    this.maxTicks = integer(options.maxTicks ?? MAX_REPLAY_TICKS, 1, MAX_REPLAY_TICKS, 'maxTicks');
    if (
      options.label !== undefined &&
      (typeof options.label !== 'string' || options.label.length > 120)
    )
      throw new TypeError('Recording label must be a string of at most 120 characters');
    this.data = {
      format: 'boomerang-garden.replay',
      version: REPLAY_VERSION,
      simulationVersion: SIMULATION_VERSION,
      mapDataVersion: MAP_DATA_VERSION,
      tickRate: 1 / RULES.dt,
      createdAt: new Date().toISOString(),
      label: options.label ?? '花园对局',
      durationTicks: 0,
      operations: [],
      checkpoints: [],
      finalHash: '',
      stopReason: 'manual',
    };
    this.checkpoint(game);
  }
  get status(): RecordingStatus {
    return {
      ticks: this.data.durationTicks,
      seconds: this.data.durationTicks * RULES.dt,
      checkpoints: this.data.checkpoints.length,
      operations: this.data.operations.length,
      estimatedBytes: this.bytes,
    };
  }
  step(commands: ReadonlyMap<number, Command>): void {
    const values = [...commands].map(
      ([id, command]) => [id, structuredClone(command)] as [number, Command],
    );
    const signature = JSON.stringify(values),
      last = this.data.operations.at(-1);
    if (!this.sealed && last?.type === 'step' && signature === this.lastCommands) {
      last.count++;
      this.bytes++;
    } else {
      this.data.operations.push({ type: 'step', count: 1, commands: values });
      this.bytes += jsonBytes(this.data.operations.at(-1)) + 1;
    }
    this.sealed = false;
    this.lastCommands = signature;
    this.data.durationTicks++;
  }
  reset(actorId: number): void {
    this.bytes += 40;
    const last = this.data.operations.at(-1);
    if (!this.sealed && last?.type === 'reset') {
      if (!last.actors.includes(actorId)) last.actors.push(actorId);
    } else this.data.operations.push({ type: 'reset', actors: [actorId] });
    this.sealed = false;
  }
  capture(game: Game): void {
    if (
      this.data.durationTicks > 0 &&
      this.data.durationTicks % this.interval === 0 &&
      this.data.checkpoints.at(-1)!.tick !== this.data.durationTicks
    )
      this.checkpoint(game);
  }
  private checkpoint(game: Game): void {
    const world = game.checkpoint();
    this.data.checkpoints.push({
      tick: this.data.durationTicks,
      operation: this.data.operations.length,
      world,
      hash: checkpointHash(world),
    });
    this.bytes += jsonBytes(this.data.checkpoints.at(-1)) + 1;
    this.sealed = true;
  }
  finish(game: Game, reason: ReplayData['stopReason']): ReplayData {
    this.data.finalHash = checkpointHash(game.checkpoint());
    this.data.stopReason = reason;
    return this.data;
  }
}

/** Validate data before it reaches physics or Three.js. No recorded JavaScript is executed. */
export function parseReplay(input: string | unknown): ReplayData {
  if (typeof input === 'string' && input.length > MAX_REPLAY_BYTES)
    throw new RangeError('Replay is too large');
  const data = typeof input === 'string' ? JSON.parse(input) : structuredClone(input);
  let members = 0;
  const finiteJSON = (value: unknown, depth = 0): void => {
    if (++members > 16_000_000 || depth > 50) throw new RangeError('Replay structure is too large');
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new TypeError('Non-finite replay number');
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          throw new TypeError('Invalid replay key');
        finiteJSON(child, depth + 1);
      }
    } else if (
      typeof value === 'function' ||
      typeof value === 'symbol' ||
      typeof value === 'bigint'
    )
      throw new TypeError('Replay must contain only data');
  };
  finiteJSON(data);
  if (jsonBytes(data) > MAX_REPLAY_BYTES) throw new RangeError('Replay is too large');
  if (!data || data.format !== 'boomerang-garden.replay' || data.version !== REPLAY_VERSION)
    throw new TypeError('Unsupported replay format');
  if (
    data.simulationVersion !== SIMULATION_VERSION ||
    data.mapDataVersion !== MAP_DATA_VERSION ||
    data.tickRate !== 60
  )
    throw new Error('Replay requires a different simulation or map version');
  integer(data.durationTicks, 0, MAX_REPLAY_TICKS, 'durationTicks');
  if (
    typeof data.label !== 'string' ||
    data.label.length > 120 ||
    typeof data.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(data.createdAt)) ||
    !['manual', 'match-end', 'restart', 'destroy', 'limit', 'size-limit'].includes(data.stopReason)
  )
    throw new TypeError('Invalid replay metadata');
  if (
    !Array.isArray(data.operations) ||
    data.operations.length > MAX_REPLAY_TICKS * 3 ||
    !Array.isArray(data.checkpoints) ||
    data.checkpoints.length < 1 ||
    data.checkpoints.length > 1801
  )
    throw new TypeError('Invalid replay operations/checkpoints');
  let ticks = 0;
  const ticksAt = [0];
  for (const op of data.operations) {
    if (op.type === 'step') {
      ticks += integer(op.count, 1, MAX_REPLAY_TICKS, 'operation.count');
      if (!Array.isArray(op.commands) || op.commands.length > 4)
        throw new TypeError('Invalid commands');
      const ids = new Set<number>();
      for (const pair of op.commands) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('Invalid command entry');
        const [id, command] = pair;
        integer(id, 0, 3, 'actorId');
        if (ids.has(id)) throw new TypeError('Duplicate actor command');
        ids.add(id);
        if (
          !command ||
          typeof command.move?.x !== 'number' ||
          typeof command.move?.y !== 'number' ||
          Math.hypot(command.move.x, command.move.y) > 1.00001 ||
          ['attack', 'dash', 'throwHeld', 'throwReleased'].some(
            (key) => typeof command[key] !== 'boolean',
          )
        )
          throw new TypeError('Invalid recorded command');
      }
    } else if (op.type === 'reset') {
      if (!Array.isArray(op.actors) || op.actors.length > 4) throw new TypeError('Invalid reset');
      op.actors.forEach((id: number) => integer(id, 0, 3, 'actorId'));
    } else throw new TypeError('Unknown replay operation');
    ticksAt.push(ticks);
  }
  if (ticks !== data.durationTicks) throw new Error('Replay tick count does not match operations');
  let previous = -1;
  for (const c of data.checkpoints) {
    integer(c.tick, 0, ticks, 'checkpoint.tick');
    integer(c.operation, 0, data.operations.length, 'checkpoint.operation');
    if (c.tick <= previous || ticksAt[c.operation] !== c.tick)
      throw new Error('Invalid checkpoint ordering');
    previous = c.tick;
    const state = c.world?.state;
    validateReplayState(state);
    if (
      !state ||
      !Array.isArray(state.actors) ||
      state.actors.length < 2 ||
      state.actors.length > 4 ||
      !Array.isArray(state.arena?.obstacles) ||
      !Array.isArray(state.discs) ||
      !Array.isArray(state.events)
    )
      throw new TypeError('Invalid checkpoint world');
    matchOptions(defaultOptions(), state.options);
    if (
      state.actors.some((a: { id: number }, index: number) => a.id !== index) ||
      state.arena.halfWidth <= 0 ||
      state.arena.halfHeight <= 0
    )
      throw new TypeError('Invalid checkpoint actors or arena');
    integer(c.world.randomSeed, 0, Number.MAX_SAFE_INTEGER, 'randomSeed');
    if (checkpointHash(c.world) !== c.hash) throw new Error('Checkpoint checksum mismatch');
  }
  if (
    data.checkpoints[0].tick !== 0 ||
    data.checkpoints[0].operation !== 0 ||
    typeof data.finalHash !== 'string' ||
    !/^[a-f0-9]{8}$/.test(data.finalHash)
  )
    throw new Error('Invalid replay boundaries');
  return data as ReplayData;
}

/** Action playback is independent of current human, bot, script or remote AI controllers. */
export class ReplayPlayer {
  private data: ReplayData;
  private game: Game;
  private operation = 0;
  private repeat = 0;
  private cursor = 0;
  private pending: GameEvent[] = [];
  private stopped = false;
  private paused = false;
  constructor(input: ReplayData | string) {
    this.data = parseReplay(input);
    this.game = new Game(this.data.checkpoints[0].world.state.options);
    this.seek(0);
  }
  get tick(): number {
    return this.cursor;
  }
  get durationTicks(): number {
    return this.data.durationTicks;
  }
  get status(): 'playing' | 'paused' | 'ended' {
    return this.stopped ? 'ended' : this.paused ? 'paused' : 'playing';
  }
  get label(): string {
    return this.data.label;
  }
  getState(): GameState {
    return structuredClone(this.game.state);
  }
  checkpoint(): SimulationCheckpoint {
    return this.game.checkpoint();
  }
  drainEvents(): GameEvent[] {
    return this.pending.splice(0);
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  private resets(): void {
    while (this.data.operations[this.operation]?.type === 'reset') {
      const op = this.data.operations[this.operation++] as Extract<
        ReplayOperation,
        { type: 'reset' }
      >;
      for (const id of op.actors) {
        const actor = this.game.state.actors.find((a) => a.id === id);
        if (!actor) throw new Error('Replay reset references a missing actor');
        clearActorInput(actor);
      }
    }
  }
  private advance(events: boolean): void {
    this.resets();
    const op = this.data.operations[this.operation];
    if (!op || op.type !== 'step') {
      this.stopped = true;
      return;
    }
    this.game.step(new Map(op.commands));
    const emitted = this.game.drainEvents();
    if (events) this.pending.push(...emitted);
    this.cursor++;
    if (++this.repeat === op.count) {
      this.operation++;
      this.repeat = 0;
    }
    this.resets();
    if (this.cursor === this.durationTicks) {
      this.stopped = true;
      if (checkpointHash(this.game.checkpoint()) !== this.data.finalHash)
        throw new Error(`Replay diverged at tick ${this.cursor}`);
    }
  }
  step(ticks = 1): void {
    integer(ticks, 1, MAX_REPLAY_TICKS, 'ticks');
    if (this.paused) return;
    for (let i = 0; i < ticks && !this.stopped; i++) this.advance(true);
  }
  seek(tick: number): void {
    integer(tick, 0, this.durationTicks, 'tick');
    const checkpoint = [...this.data.checkpoints].reverse().find((c) => c.tick <= tick)!;
    this.game.restore(checkpoint.world);
    this.cursor = checkpoint.tick;
    this.operation = checkpoint.operation;
    this.repeat = 0;
    this.stopped = this.cursor === this.durationTicks;
    this.pending = [];
    while (this.cursor < tick) this.advance(false);
    this.resets();
    if (
      tick === this.durationTicks &&
      checkpointHash(this.game.checkpoint()) !== this.data.finalHash
    )
      throw new Error(`Replay diverged at tick ${tick}`);
  }
}
