import { createArena, selectRoundMap } from '../core/arena';
import { RULES } from '../core/config';
import { normalize, sub, v } from '../core/math';
import type { Actor, GameState, MatchOptions } from '../core/types';

export const defaultOptions = (): MatchOptions => ({
  mode: 'solo',
  bots: 1,
  difficulty: 'normal',
  seed: 1261,
  scoreGoal: RULES.scoreGoal,
  mapId: 'courtyard',
  mapRotation: 'fixed',
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
    facing: v(0, -1),
    facingHistory: [],
    alive: true,
    deathTime: 0,
    score: 0,
    kills: 0,
    armed: true,
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
    options: { ...options, bots: botCount },
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
    arena: createArena(options.mapId),
    events: [],
    nextId: 1,
    pickupTimer: 3,
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
  state.safeRadius = 100;
  state.hitStop = 0;
  state.weaponsGranted = false;
  state.winnerId = null;
  state.discs = [];
  state.pickups = [];
  state.pickupTimer = 2.5;
  for (const actor of state.actors) {
    const fresh = makeActor(actor.id, actor.controller, actor.humanIndex);
    const position = state.arena.spawns[actor.id];
    Object.assign(actor, fresh, {
      score: actor.score,
      kills: actor.kills,
      powers: [...actor.powers],
      shield: actor.powers.includes('shield'),
      armed: false,
      position: { ...position },
      previous: { ...position },
      facing: normalize(sub(v(), position)),
    });
  }
  state.events.push({ type: 'round', position: v(), actorId: -1, value: state.round });
}
