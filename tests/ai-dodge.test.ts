import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { Random, distance, normalize, sub, v } from '../src/core/math';
import { idleCommand, type Command, type Difficulty } from '../src/core/types';
import { BotController } from '../src/simulation/ai';
import { discThreats, predictDisc } from '../src/simulation/ai-threats';
import { Game } from '../src/simulation/game';
import { throwDisc, tickDiscs } from '../src/simulation/projectiles';
import { createState, defaultOptions } from '../src/simulation/state';
import { setHeldDiscs } from '../src/simulation/inventory';

/** A fixed, invulnerable thrower aims at a bot 7 units away; returns disc kills per throw. */
function dodgeTrial(difficulty: Difficulty | 'none', seed: number, throws: number): number {
  const game = new Game({
    ...defaultOptions(),
    seed,
    difficulty: difficulty === 'none' ? 'normal' : difficulty,
    scoring: 'survival',
    scoreGoal: 99,
    suddenDeathTime: 9999,
  });
  const s = game.state;
  const thrower = s.actors[0],
    bot = s.actors[1];
  const brain = new BotController(),
    random = new Random(seed ^ 0x5bd1e995),
    rng = new Random(seed * 7 + 1);
  let thrown = 0,
    kills = 0,
    cooldown = 1,
    holdLeft = -1,
    frames = 0,
    placed = false;
  while (thrown < throws && frames++ < 60 * 400) {
    if (s.phase !== 'playing') {
      placed = false;
      game.step(new Map());
      continue;
    }
    if (!placed) {
      bot.position = v(3, (rng.next() - 0.5) * 2);
      bot.previous = { ...bot.position };
      placed = true;
    }
    s.arena.obstacles = [];
    s.arena.pits = [];
    thrower.position = thrower.previous = v(-4, 0);
    thrower.velocity = v();
    thrower.invulnerable = 9;
    const t: Command = idleCommand();
    cooldown -= RULES.dt;
    if (thrower.armed && cooldown <= 0 && bot.alive) {
      if (holdLeft < 0) holdLeft = [0, 0.45, 1.05][Math.floor(rng.next() * 3)];
      t.move = normalize(sub(bot.position, thrower.position));
      if (holdLeft > 0) {
        t.throwHeld = true;
        holdLeft -= RULES.dt;
      } else {
        t.throwReleased = true;
        holdLeft = -1;
        cooldown = 1.3 + rng.next();
        thrown++;
      }
    } else if (!thrower.armed) t.throwHeld = true;
    const commands = new Map<number, Command>([[0, t]]);
    if (difficulty !== 'none') commands.set(1, brain.command(s, bot, random, RULES.dt));
    const start = s.events.length;
    game.step(commands);
    for (const e of s.events.slice(start))
      if (e.type === 'death' && e.actorId === 1 && e.cause === 'weapon' && e.value === 0) kills++;
  }
  return kills / Math.max(1, thrown);
}

describe('bot threat model', () => {
  it('predicts an unblocked throw along the simulated path', () => {
    const state = createState(defaultOptions());
    state.phase = 'playing';
    state.arena.obstacles = [];
    state.arena.pits = [];
    const owner = state.actors[0];
    owner.position = owner.previous = v(-6, 0);
    owner.facing = owner.lastMove = v(1, 0);
    state.actors[1].position = v(0, 30);
    setHeldDiscs(owner, 1);
    throwDisc(state, owner);
    const disc = state.discs[0];
    const predicted = predictDisc(state, disc, 0.6);
    for (let i = 0; i < 36; i++) {
      tickDiscs(state, RULES.dt);
      const sample = predicted[i];
      expect(distance(sample.position, state.discs[0].position)).toBeLessThan(0.05);
    }
  });
  it('flags a disc on course for the actor and ignores one flying away', () => {
    const state = createState(defaultOptions());
    state.phase = 'playing';
    state.arena.obstacles = [];
    const [thrower, target] = state.actors;
    thrower.position = v(-4, 0);
    thrower.facing = thrower.lastMove = v(1, 0);
    target.position = v(3, 0);
    setHeldDiscs(thrower, 1);
    throwDisc(state, thrower);
    const threat = discThreats(state, target)[0];
    expect(threat).toBeDefined();
    expect(threat.time).toBeGreaterThan(0.2);
    expect(threat.time).toBeLessThan(0.6);
    target.position = v(-4, 8);
    expect(discThreats(state, target)).toHaveLength(0);
  });
});

describe('bot evasion', () => {
  it('dodges more often with difficulty, and clearly better than standing still', () => {
    const rate = (difficulty: Difficulty | 'none') =>
      (dodgeTrial(difficulty, 11, 18) + dodgeTrial(difficulty, 37, 18)) / 2;
    const still = rate('none');
    const easy = rate('easy');
    const hard = rate('hard');
    const impossible = rate('impossible');
    expect(still).toBeGreaterThan(0.35);
    expect(hard).toBeLessThan(still * 0.6);
    expect(impossible).toBeLessThanOrEqual(hard);
    expect(easy).toBeGreaterThan(hard);
  }, 60000);
  it('keeps running while on fire instead of standing in the flames', () => {
    const state = createState({ ...defaultOptions(), difficulty: 'hard' });
    state.phase = 'playing';
    state.weaponsGranted = true;
    const bot = state.actors[1];
    bot.position = bot.previous = v(0, 4);
    bot.burnTime = 2;
    const brain = new BotController();
    const command = brain.command(state, bot, new Random(3), RULES.dt);
    expect(Math.hypot(command.move.x, command.move.y)).toBeGreaterThan(0.9);
  });
});
