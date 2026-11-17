import { RULES } from '../core/config';
import { PRESENTATION, ROUND_END_DURATION, introDuration } from '../core/presentation';
import { Random, v } from '../core/math';
import { idleCommand } from '../core/types';
import type { Actor, Command, GameEvent, GameState, MatchOptions } from '../core/types';
import { tickActorDisguise, tickActorInput, tickActorMotion, tickActorTimers } from './actors';
import { resolveMelee, separateActors } from './combat';
import { grantPowerup, tickPowerups } from './powerups';
import { discOverlapPhase, tickDiscRespawns, tickDiscs } from './projectiles';
import { createState, defaultOptions, resetRound } from './state';
import { tickActorPortals } from './portals';
import { stopShrinkingBoundary, tickBoundary } from './boundary';
import { discCapacity, heldDiscs, setHeldDiscs } from './inventory';
import { tickStatusEffects } from './status-effects';
import { tickEnvironment, tickEnvironmentContacts } from './environment';
import { advanceClock } from './clock';

export interface SimulationCheckpoint {
  state: GameState;
  randomSeed: number;
}

/** GameManager.EndRoundScores for kill scoring; returns the match winner, if any. */
function resolveKillMatch(state: GameState): Actor | undefined {
  for (const actor of state.actors) {
    // PreventNegativeScores runs at round end, never immediately on a suicide.
    if (actor.score < 0) {
      actor.suicides = Math.max(0, (actor.suicides ?? 0) + actor.score);
      actor.score = 0;
    }
  }
  if (state.pendingWinnerId !== undefined)
    return state.actors.find((actor) => actor.id === state.pendingWinnerId);
  const goal = state.options.scoreGoal;
  const reached = state.actors.filter((actor) => actor.score >= goal);
  if (!reached.length) return undefined;
  const best = Math.max(...reached.map((actor) => actor.score));
  const winners = reached.filter((actor) => actor.score === best);
  if (winners.length === 1) return winners[0];
  state.tieBreaker = true;
  return undefined;
}

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

  checkpoint(): SimulationCheckpoint {
    return { state: structuredClone(this.state), randomSeed: this.random.seed };
  }

  /** Restore into fresh object identities so geometry/navigation caches cannot survive a seek. */
  restore(checkpoint: SimulationCheckpoint): void {
    this.state = structuredClone(checkpoint.state);
    this.random = new Random(0);
    this.random.seed = checkpoint.randomSeed;
  }

  /** One rendered 60 Hz frame. Gameplay advances by `dt × timeScale` (TimeKeeper). */
  step(commands: ReadonlyMap<number, Command> = new Map()): void {
    const state = this.state,
      frame = RULES.dt;
    if (state.phase === 'menu' || state.phase === 'matchEnd') return;
    if (state.phase === 'countdown') {
      state.time += frame;
      state.phaseTime += frame;
      const duration = introDuration(state.actors.length);
      if (
        state.phaseTime >= duration - PRESENTATION.ready &&
        state.phaseTime - frame < duration - PRESENTATION.ready
      )
        state.events.push({ type: 'countdown', position: v(), actorId: -1 });
      if (state.phaseTime + 1e-8 >= duration) {
        state.phase = 'playing';
        state.phaseTime = 0;
      }
      return;
    }
    if (state.phase === 'roundEnd') {
      state.time += frame;
      state.phaseTime += frame;
      if (state.phaseTime + 1e-8 < ROUND_END_DURATION) return;
      const winner =
        (state.options.scoring ?? 'kills') === 'kills'
          ? resolveKillMatch(state)
          : state.actors.find((p) => p.score >= state.options.scoreGoal);
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
    // A freeze frame that is active when the frame begins holds the whole frame.
    if (state.hitStop > 0) {
      advanceClock(state, frame);
      return;
    }
    const dt = frame * advanceClock(state, frame);
    if (dt <= 0) return;
    state.time += dt;
    state.phaseTime += dt;
    state.roundTime += dt;
    if (!state.weaponsGranted && state.roundTime + 1e-8 >= PRESENTATION.equipDelay) {
      for (const actor of state.actors)
        if (actor.alive) {
          if (state.round === 1)
            for (const power of state.options.startingPowers ?? [])
              grantPowerup(state, actor, power);
          setHeldDiscs(actor, discCapacity(actor));
          actor.attacksLeft = heldDiscs(actor);
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
    const eventStart = state.events.length;
    const command = (id: number): Command => commands.get(id) ?? idleCommand();
    tickBoundary(state, this.random, dt);
    tickEnvironment(state, this.random, dt);
    // FixedUpdate: locomotion, then projectiles, then the native trigger phase.
    for (const actor of state.actors) tickActorMotion(state, actor, command(actor.id), dt);
    tickActorPortals(state, dt);
    separateActors(state);
    tickDiscs(state, dt);
    resolveMelee(state);
    discOverlapPhase(state);
    // Update: PlayerInput, then Actor/Player timers.
    for (const actor of state.actors) tickActorInput(state, actor, command(actor.id), dt);
    for (const actor of state.actors) {
      tickActorTimers(actor, dt);
      tickActorDisguise(state, actor, dt);
    }
    tickDiscRespawns(state, dt);
    tickStatusEffects(state, dt);
    tickEnvironmentContacts(state, dt);
    tickPowerups(state, this.random, dt);
    const survivors = state.actors.filter((a) => a.alive);
    const newEvents = state.events.slice(eventStart);
    const decided = state.pendingWinnerId !== undefined;
    if (survivors.length > 1 && !decided) state.roundFinishTimer = null;
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
    if (
      (survivors.length <= 1 || decided) &&
      state.roundFinishTimer === 0 &&
      !survivors.some((a) => a.fall)
    ) {
      state.winnerId = survivors.length === 1 ? survivors[0].id : null;
      if ((state.options.scoring ?? 'kills') === 'survival' && survivors.length === 1)
        survivors[0].score++;
      state.phase = 'roundEnd';
      state.phaseTime = 0;
    }
  }

  drainEvents(): GameEvent[] {
    return this.state.events.splice(0);
  }
}
