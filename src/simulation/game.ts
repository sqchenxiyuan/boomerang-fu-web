import { RULES } from '../core/config';
import { HIT_STOP, PRESENTATION, ROUND_END_DURATION, introDuration } from '../core/presentation';
import { Random, v } from '../core/math';
import { idleCommand } from '../core/types';
import type { Command, GameEvent, GameState, MatchOptions } from '../core/types';
import { tickActor } from './actors';
import { resolveMelee, separateActors } from './combat';
import { grantPowerup, tickPowerups } from './powerups';
import { tickDiscs } from './projectiles';
import { createState, defaultOptions, resetRound } from './state';
import { tickActorPortals } from './portals';
import { stopShrinkingBoundary, tickBoundary } from './boundary';
import { discCapacity, setHeldDiscs } from './inventory';
import { tickStatusEffects } from './status-effects';

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
          if (state.round === 1)
            for (const power of state.options.startingPowers ?? [])
              grantPowerup(state, actor, power);
          setHeldDiscs(actor, discCapacity(actor));
          actor.throwBlocked = true;
          state.events.push({
            type: 'equip',
            position: { ...actor.position },
            actorId: actor.id,
            value: discCapacity(actor),
          });
        }
      state.weaponsGranted = true;
    }
    tickBoundary(state, this.random, dt);
    const eventStart = state.events.length;
    for (const actor of state.actors)
      tickActor(state, actor, commands.get(actor.id) ?? idleCommand(), dt);
    tickActorPortals(state, dt);
    separateActors(state);
    resolveMelee(state);
    tickDiscs(state, dt);
    tickStatusEffects(state, dt);
    tickPowerups(state, this.random, dt);
    const survivors = state.actors.filter((a) => a.alive);
    const newEvents = state.events.slice(eventStart);
    for (const event of newEvents) {
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
    if (survivors.length > 1) state.roundFinishTimer = null;
    else {
      stopShrinkingBoundary(state);
      state.roundFinishTimer =
        state.roundFinishTimer === null
          ? RULES.roundResolveDelay
          : newEvents.some((event) => event.type === 'death')
            ? RULES.roundResolveDelay
            : Math.max(0, state.roundFinishTimer - dt - 1e-12);
    }
    // The original checks again after 0.15 + 1.3 scaled seconds. Keep simulating
    // pending discs/explosions, and never award a survival point while still falling.
    if (survivors.length <= 1 && state.roundFinishTimer === 0 && !survivors.some((a) => a.fall)) {
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
