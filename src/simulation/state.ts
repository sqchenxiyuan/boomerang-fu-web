import { createArena, selectRoundMap } from '../core/arena';
import { RULES } from '../core/config';
import { normalize, sub, v } from '../core/math';
import type { Actor, GameState, MatchOptions } from '../core/types';
import { createBoundary } from './boundary';
import { depenetrate } from '../core/collision';

export const defaultOptions = (): MatchOptions => ({
  mode: 'solo',
  bots: 1,
  difficulty: 'normal',
  seed: 1261,
  scoreGoal: RULES.scoreGoal,
  mapId: 'courtyard',
  mapRotation: 'fixed',
  suddenDeathTime: RULES.suddenDeathStart,
});

export function makeActor(id: number, controller: Actor['controller'], humanIndex: number): Actor {
  return {
    id,
    portalCooldown: 0,
    controller,
    humanIndex,
    position: v(),
    previous: v(),
    velocity: v(),
    movingFloorId: undefined,
    wetFloor: false,
    slideFactor: 1,
    surfaceDrag: RULES.damping,
    facing: v(0, -1),
    facingHistory: [],
    alive: true,
    deathTime: 0,
    death: undefined,
    fall: undefined,
    fallsSaved: 0,
    outOfBounds: undefined,
    score: 0,
    kills: 0,
    armed: true,
    heldDiscs: 1,
    reverseTime: 0,
    frozenTime: 0,
    burnTime: 0,
    burnSourceId: -1,
    burnDistance: 0,
    disguised: false,
    disguiseTime: 0,
    controlling: false,
    controlDirection: v(),
    abilityCooldown: 0,
    phaseOrigin: undefined,
    positivePickups: 0,
    iceExposure: 0,
    slowed: false,
    decoyCreated: false,
    freezeChipCooldown: 0,
    charge: 0,
    aimMoveLag: 0,
    lungeTime: 0,
    lungeRecovery: 0,
    recalling: false,
    throwBlocked: false,
    dashTime: 0,
    dashCooldown: 0,
    dashDirection: v(),
    attackTime: 0,
    attackCooldown: 0,
    attackSerial: 0,
    attackArmed: false,
    hitTargets: [],
    stun: 0,
    invulnerable: 0,
    powers: [],
    shield: false,
    bufferedDash: 0,
    bufferedAttack: 0,
  };
}

export function createState(options: MatchOptions = defaultOptions()): GameState {
  const humanCount = options.mode === 'local' ? 2 : 1;
  const botCount = Math.max(
    options.mode === 'solo' ? 1 : 0,
    Math.min(4 - humanCount, options.bots),
  );
  const actors = Array.from({ length: humanCount + botCount }, (_, i) =>
    makeActor(i, i < humanCount ? 'human' : 'bot', i < humanCount ? i : -1),
  );
  const state: GameState = {
    options: {
      ...options,
      powerupPool: options.powerupPool ? [...options.powerupPool] : undefined,
      startingPowers: options.startingPowers ? [...options.startingPowers] : undefined,
      bots: botCount,
      suddenDeathTime: options.suddenDeathTime ?? RULES.suddenDeathStart,
    },
    phase: 'countdown',
    phaseTime: 0,
    time: 0,
    roundTime: 0,
    round: 1,
    winnerId: null,
    matchWinnerId: null,
    actors,
    discs: [],
    pickups: [],
    zones: [],
    decoys: [],
    arena: createArena(options.mapId),
    events: [],
    nextId: 1,
    pickupTimer: 3,
    boundary: createBoundary(createArena(options.mapId)),
    suddenDeathStarted: false,
    roundFinishTimer: null,
    safeRadius: 100,
    hitStop: 0,
    weaponsGranted: false,
  };
  resetRound(state);
  return state;
}

export function resetRound(state: GameState): void {
  state.arena = createArena(
    selectRoundMap(state.options.mapId, state.options.mapRotation, state.round),
  );
  state.phase = 'countdown';
  state.phaseTime = 0;
  state.roundTime = 0;
  state.boundary = createBoundary(state.arena);
  state.suddenDeathStarted = false;
  state.roundFinishTimer = null;
  state.safeRadius = Math.min(state.boundary.halfSize.x, state.boundary.halfSize.y);
  state.hitStop = 0;
  state.weaponsGranted = false;
  state.winnerId = null;
  state.discs = [];
  state.pickups = [];
  state.zones = [];
  state.decoys = [];
  state.pickupTimer = 2.5;
  for (const actor of state.actors) {
    const fresh = makeActor(actor.id, actor.controller, actor.humanIndex);
    const sourcePosition = state.arena.spawns[actor.id % state.arena.spawns.length];
    const position = state.arena.floors
      ? depenetrate(state.arena, sourcePosition, RULES.playerRadius)
      : sourcePosition;
    Object.assign(actor, fresh, {
      score: actor.score,
      kills: actor.kills,
      powers: [...actor.powers],
      shield: actor.powers.includes('shield'),
      armed: false,
      heldDiscs: 0,
      positivePickups: actor.positivePickups ?? 0,
      position: { ...position },
      previous: { ...position },
      facing: normalize(sub(v(), position)),
    });
  }
  state.events.push({ type: 'round', position: v(), actorId: -1, value: state.round });
}
