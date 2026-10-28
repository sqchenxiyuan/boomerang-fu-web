import { MAPS } from '../core/arena';
import { POWERUPS, RULES } from '../core/config';
import { Random } from '../core/math';
import type { Vec2 } from '../core/math';
import type {
  Actor,
  Command,
  GameEvent,
  GameState,
  MatchOptions,
  PowerupKind,
} from '../core/types';
import { BotController } from '../simulation/ai';
import type { Action } from './types';

export interface ActionSample {
  move: Vec2;
  attack: boolean;
  dash: boolean;
  throw: boolean;
}

export const neutralSample = (): ActionSample => ({
  move: { x: 0, y: 0 },
  attack: false,
  dash: false,
  throw: false,
});

export function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function boolean(value: unknown, name: string): boolean {
  if (value !== undefined && typeof value !== 'boolean')
    throw new TypeError(`${name} must be a boolean`);
  return value === true;
}

function movement(value: unknown): Vec2 {
  if (value === undefined) return { x: 0, y: 0 };
  const move = record(value, 'move');
  const x = move.x,
    y = move.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y))
    throw new TypeError('move.x and move.y must be finite numbers');
  // Scale before measuring so even finite values near Number.MAX_VALUE normalize safely.
  const scale = Math.max(1, Math.abs(x), Math.abs(y));
  const size = Math.hypot(x / scale, y / scale);
  return scale > 1 || size > 1 ? { x: x / scale / size, y: y / scale / size } : { x, y };
}

export function actionSample(action: Action): ActionSample {
  const sample = record(action, 'action');
  for (const key of Object.keys(sample))
    if (!['move', 'attack', 'dash', 'throw'].includes(key))
      throw new TypeError(`Unknown action field: ${key}`);
  return {
    move: movement(sample.move),
    attack: boolean(sample.attack, 'attack'),
    dash: boolean(sample.dash, 'dash'),
    throw: boolean(sample.throw, 'throw'),
  };
}

export function humanCommand(command: Command): Command {
  const sample = record(command, 'command');
  return {
    move: movement(sample.move),
    attack: boolean(sample.attack, 'attack'),
    dash: boolean(sample.dash, 'dash'),
    throwHeld: boolean(sample.throwHeld, 'throwHeld'),
    throwReleased: boolean(sample.throwReleased, 'throwReleased'),
  };
}

export function commandFromSamples(sample: ActionSample, previous: ActionSample): Command {
  return {
    move: { ...sample.move },
    attack: sample.attack && !previous.attack,
    dash: sample.dash && !previous.dash,
    throwHeld: sample.throw,
    throwReleased: !sample.throw && previous.throw,
  };
}

export function matchOptions(
  base: MatchOptions,
  overrides: Partial<MatchOptions> = {},
): MatchOptions {
  const supplied = record(overrides, 'options');
  const options = { ...base };
  const keys = [
    'mode',
    'bots',
    'difficulty',
    'seed',
    'scoreGoal',
    'mapId',
    'mapRotation',
    'suddenDeathTime',
    'powerupPool',
    'startingPowers',
  ];
  for (const [key, value] of Object.entries(supplied)) {
    if (!keys.includes(key)) throw new TypeError(`Unknown match option: ${key}`);
    if (value !== undefined) Object.assign(options, { [key]: value });
  }
  if (!['solo', 'local', 'bots'].includes(options.mode)) throw new RangeError('Unknown match mode');
  if (!['easy', 'normal', 'hard'].includes(options.difficulty))
    throw new RangeError('Unknown difficulty');
  integer(
    options.bots,
    options.mode === 'bots' ? 2 : options.mode === 'solo' ? 1 : 0,
    options.mode === 'bots' ? 4 : options.mode === 'solo' ? 3 : 2,
    'bots',
  );
  integer(options.seed, 0, 0xffffffff, 'seed');
  integer(options.scoreGoal, 1, 100, 'scoreGoal');
  if (
    options.suddenDeathTime !== undefined &&
    (typeof options.suddenDeathTime !== 'number' ||
      !Number.isFinite(options.suddenDeathTime) ||
      options.suddenDeathTime < 0)
  )
    throw new RangeError('suddenDeathTime must be a finite non-negative number');
  if (!MAPS.some((map) => map.id === options.mapId)) throw new RangeError('Unknown mapId');
  if (options.mapRotation !== 'fixed' && options.mapRotation !== 'cycle')
    throw new RangeError('Unknown mapRotation');
  // Copy inherited lists too: start({ seed }) must not retain an earlier caller's
  // array, and validating an override must never mutate the current match.
  for (const name of ['powerupPool', 'startingPowers'] as const) {
    const values = options[name];
    if (values === undefined) continue;
    const minimum = name === 'powerupPool' ? 1 : 0;
    const maximum = name === 'powerupPool' ? Object.keys(POWERUPS).length : 3;
    if (!Array.isArray(values) || values.length < minimum || values.length > maximum)
      throw new RangeError(`${name} must be an array containing ${minimum} to ${maximum} powerups`);
    const copied = [...values];
    if (copied.some((value) => typeof value !== 'string' || !Object.hasOwn(POWERUPS, value)))
      throw new RangeError(`${name} contains an unknown powerup`);
    if (name === 'powerupPool' && new Set(copied).size !== copied.length)
      throw new RangeError(`${name} must not contain duplicate powerups`);
    options[name] = copied as PowerupKind[];
  }
  return options;
}

/** Controller-only RNG streams never consume the simulation's pickup RNG. */
export class BotDriver {
  #controller = new BotController();
  #randoms = new Map<number, Random>();
  constructor(private readonly seed: number) {}

  command(state: GameState, actor: Actor): Command {
    let random = this.#randoms.get(actor.id);
    if (!random) {
      random = new Random((this.seed ^ Math.imul(actor.id + 1, 0x9e3779b9)) >>> 0);
      this.#randoms.set(actor.id, random);
    }
    return this.#controller.command(state, actor, random, RULES.dt);
  }

  resetActor(actorId: number): void {
    this.#controller.resetActor(actorId);
  }
  reset(): void {
    this.#controller.reset();
  }

  observe(events: readonly GameEvent[]): void {
    for (const event of events) {
      if (event.type === 'round') this.reset();
      else if (event.type === 'teleport' && event.entityType === 'actor')
        this.resetActor(event.actorId);
    }
  }
}
