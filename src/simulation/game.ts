import { RULES } from '../core/config';
import { HIT_STOP, PRESENTATION, ROUND_END_DURATION, introDuration } from '../core/presentation';
import { Random, v } from '../core/math';
import { idleCommand } from '../core/types';
import type { Command, GameEvent, GameState, MatchOptions } from '../core/types';
import { tickActor } from './actors';
import { resolveMelee, separateActors } from './combat';
import { tickPowerups } from './powerups';
import { tickDiscs } from './projectiles';
import { createState, defaultOptions, resetRound } from './state';
import { tickActorPortals } from './portals';

/** Sole authoritative owner of gameplay state. No rendering or DOM dependencies. */
export class Game {
  state: GameState;
  private random: Random;

  constructor(options: MatchOptions = defaultOptions()) {
    this.state = createState(options);
    this.random = new Random(options.seed);
  }

  start(options: MatchOptions): void {
    this.state = createState(options);
    this.random = new Random(options.seed);
  }

  step(commands: ReadonlyMap<number, Command> = new Map()): void {
    const state = this.state,
      dt = RULES.dt;
    if (state.phase === 'menu' || state.phase === 'matchEnd') return;
    if (state.hitStop > 0) {
      state.hitStop = Math.max(0, state.hitStop - dt - 1e-10);
      return;
    }
    state.time += dt;
    state.phaseTime += dt;
    if (state.phase === 'countdown') {
      const duration = introDuration(state.actors.length);
      if (
        state.phaseTime >= duration - PRESENTATION.ready &&
        state.phaseTime - dt < duration - PRESENTATION.ready
      )
        state.events.push({ type: 'countdown', position: v(), actorId: -1 });
      if (state.phaseTime + 1e-8 >= duration) {
        state.phase = 'playing';
        state.phaseTime = 0;
      }
      return;
    }
    if (state.phase === 'roundEnd') {
      if (state.phaseTime + 1e-8 < ROUND_END_DURATION) return;
      const winner = state.actors.find((p) => p.score >= state.options.scoreGoal);
      if (winner) {
        state.phase = 'matchEnd';
        state.matchWinnerId = winner.id;
        state.events.push({ type: 'win', position: { ...winner.position }, actorId: winner.id });
      } else {
        state.round++;
        resetRound(state);
      }
      return;
    }
    state.roundTime += dt;
    if (!state.weaponsGranted && state.roundTime + 1e-8 >= PRESENTATION.equipDelay) {
      for (const actor of state.actors)
        if (actor.alive) {
          actor.armed = true;
          actor.throwBlocked = true;
        }
      state.weaponsGranted = true;
    }
    state.safeRadius =
      state.roundTime < RULES.suddenDeathStart
        ? 100
        : Math.max(0.2, 15 - (state.roundTime - RULES.suddenDeathStart) * 0.55);
    const eventStart = state.events.length;
    for (const actor of state.actors)
      tickActor(state, actor, commands.get(actor.id) ?? idleCommand(), dt);
    tickActorPortals(state, dt);
    separateActors(state);
    resolveMelee(state);
    tickDiscs(state, dt);
    tickPowerups(state, this.random, dt);
    const survivors = state.actors.filter((a) => a.alive);
    for (const event of state.events.slice(eventStart)) {
      const freeze =
        event.type === 'death' && (event.cause === 'weapon' || event.cause === 'explosion')
          ? HIT_STOP.death
          : event.feedback === 'parry'
            ? HIT_STOP.deflect
            : event.feedback === 'clash' && survivors.length < 4
              ? HIT_STOP.meleeClash
              : 0;
      state.hitStop = Math.max(state.hitStop, freeze);
    }
    if (survivors.length <= 1 || state.roundTime >= RULES.roundLimit) {
      state.winnerId = survivors.length === 1 ? survivors[0].id : null;
      if (survivors.length === 1) survivors[0].score++;
      state.phase = 'roundEnd';
      state.phaseTime = 0;
    }
  }

  drainEvents(): GameEvent[] {
    return this.state.events.splice(0);
  }
}
