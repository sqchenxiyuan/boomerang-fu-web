import { describe, expect, it } from 'vitest';
import { NATIVE, RULES } from '../src/core/config';
import { cross, distance, length, normalize, v } from '../src/core/math';
import { idleCommand, type Command, type GameState } from '../src/core/types';
import { tickActor } from '../src/simulation/actors';
import { advanceClock, freeze, slowMo } from '../src/simulation/clock';
import { damageActor, meleePolygon, resolveMelee } from '../src/simulation/combat';
import { heldDiscs, setHeldDiscs } from '../src/simulation/inventory';
import { grantPowerup } from '../src/simulation/powerups';
import { discOverlapPhase, throwDisc, tickDiscs } from '../src/simulation/projectiles';
import { createState, defaultOptions } from '../src/simulation/state';

/*
 * Behaviour ported from the reference Godot simulation (Actor/Disc/CombatWorld/
 * TimeKeeper). Distances are Unity units × 0.4; see docs/godot-parity.md.
 */
const U = NATIVE.scale;

function arena(players = 2): GameState {
  const state = createState({ ...defaultOptions(), bots: players - 1 });
  state.phase = 'playing';
  state.weaponsGranted = true;
  state.arena.obstacles = [];
  state.arena.pits = [];
  state.arena.halfWidth = 40;
  state.arena.halfHeight = 40;
  state.arena.floors = undefined;
  state.arena.portals = [];
  state.events = [];
  for (const actor of state.actors) {
    setHeldDiscs(actor, 1);
    actor.attacksLeft = 1;
  }
  return state;
}
const place = (state: GameState, id: number, x: number, y: number, fx = 1, fy = 0) => {
  const actor = state.actors[id];
  actor.position = v(x, y);
  actor.previous = v(x, y);
  actor.facing = normalize(v(fx, fy));
  actor.lastMove = normalize(v(fx, fy));
  return actor;
};
/** One frame of the systems under test, in Game.step order. */
function frame(state: GameState, commands: Record<number, Partial<Command>> = {}): void {
  for (const actor of state.actors)
    tickActor(state, actor, { ...idleCommand(), ...commands[actor.id] }, RULES.dt);
  tickDiscs(state, RULES.dt);
  resolveMelee(state);
  discOverlapPhase(state);
}

describe('TimeKeeper', () => {
  it('eases into a .2 slow motion, holds, then eases out over the hold duration', () => {
    const state = arena();
    slowMo(state, 0.5, 0.5);
    const scales: number[] = [];
    for (let i = 0; i < 100; i++) scales.push(advanceClock(state, RULES.dt));
    expect(scales[0]).toBeLessThan(1);
    expect(Math.min(...scales)).toBeCloseTo(0.2, 6);
    // Lerp in .5 s + hold .5 s: the trough begins around frame 30 and ends near 60.
    expect(scales[45]).toBeCloseTo(0.2, 6);
    expect(scales[75]).toBeGreaterThan(0.2);
    expect(scales[75]).toBeLessThan(1);
    expect(scales[95]).toBe(1);
    expect(state.clock?.slowMo).toBe(false);
  });
  it('a freeze frame stops scaled time while slow motion keeps counting', () => {
    const state = arena();
    slowMo(state, 0.5, 0.1);
    freeze(state, 0.1);
    const frozen = Array.from({ length: 6 }, () => advanceClock(state, RULES.dt));
    expect(frozen.every((scale) => scale === 0)).toBe(true);
    expect(advanceClock(state, RULES.dt)).toBeCloseTo(0.2, 6);
  });
});

describe('Melee', () => {
  it('uses the prefab trigger polygon: 1.35 units forward, not a radial arc', () => {
    const state = arena();
    const actor = place(state, 0, 0, 0, 1, 0);
    const polygon = meleePolygon(actor);
    expect(Math.max(...polygon.map((p) => p.x))).toBeCloseTo(1.3453, 3);
    expect(Math.min(...polygon.map((p) => p.x))).toBeGreaterThan(0);
  });
  it('swing against swing ends both attacks, pushes both back with stun and freezes .2 s', () => {
    const state = arena();
    const a = place(state, 0, -0.9, 0, 1, 0);
    const b = place(state, 1, 0.9, 0, -1, 0);
    frame(state, { 0: { attack: true }, 1: { attack: true } });
    frame(state);
    expect(a.attackTime).toBe(0);
    expect(b.attackTime).toBe(0);
    expect(a.alive && b.alive).toBe(true);
    expect(a.stun).toBeGreaterThan(0.35);
    expect(b.stun).toBeGreaterThan(0.35);
    expect(state.hitStop).toBeCloseTo(NATIVE.combat.meleeBlockFreeze);
    expect(state.events.filter((e) => e.feedback === 'clash')).toHaveLength(1);
    frame(state);
    expect(a.velocity.x).toBeLessThan(0);
    expect(b.velocity.x).toBeGreaterThan(0);
  });
  it('a swing facing the attacker blocks a cut from the front', () => {
    const state = arena();
    const attacker = place(state, 0, -1, 0, 1, 0);
    const defender = place(state, 1, 0, 0, -1, 0);
    defender.attackTime = 0.2;
    defender.attackArmed = true;
    attacker.attackTime = 0.2;
    attacker.attackArmed = true;
    defender.blockContacts = [attacker.id];
    attacker.blockContacts = [defender.id];
    resolveMelee(state);
    expect(defender.alive).toBe(true);
  });
  it('an empty-handed disarm knocks the weapon loose; once slow it becomes public', () => {
    const state = arena(3);
    const attacker = place(state, 0, -1, 0, 1, 0);
    const victim = place(state, 1, 0, 0, -1, 0);
    const thief = place(state, 2, 20, 20);
    setHeldDiscs(attacker, 0);
    attacker.attacksLeft = 0;
    frame(state, { 0: { attack: true } });
    frame(state);
    expect(victim.armed).toBe(false);
    expect(victim.stun).toBeGreaterThan(0.7);
    expect(victim.killerType).toBe('Push');
    const disc = state.discs[0];
    expect(disc.startedDropped).toBe(true);
    for (let i = 0; i < 120 && disc.ownerId >= 0; i++) frame(state);
    expect(disc.ownerId).toBe(-1);
    expect(disc.movement).toBe('dropped');
    // Anyone may collect a public disc, even into a second hand.
    thief.position = { ...disc.position };
    frame(state);
    expect(heldDiscs(thief)).toBe(2);
  });
});

describe('Disc flight', () => {
  it('throws, decelerates, returns at the speed limit and is caught by its owner', () => {
    const state = arena();
    const owner = place(state, 0, 0, 0, 1, 0);
    place(state, 1, 0, 20);
    throwDisc(state, owner);
    const disc = state.discs[0];
    const seen = new Set<string>();
    let farthest = 0;
    for (let i = 0; i < 240 && state.discs.length; i++) {
      frame(state);
      seen.add(disc.movement!);
      farthest = Math.max(farthest, distance(disc.position, owner.position));
    }
    expect([...seen]).toEqual(expect.arrayContaining(['throwing', 'returning']));
    expect(state.discs).toHaveLength(0);
    expect(owner.armed).toBe(true);
    // ~27 Unity units out at 45 u/s with a .45 s eased throw force.
    expect(farthest).toBeGreaterThan(9);
    expect(farthest).toBeLessThan(12);
  });
  it('a returning disc that strikes a wall goes free, slides and settles', () => {
    const state = arena();
    const owner = place(state, 0, 0, 0, 1, 0);
    place(state, 1, 0, 20);
    throwDisc(state, owner);
    const disc = state.discs[0];
    while (disc.movement === 'throwing') frame(state);
    // Put a wall between the returning disc and its owner.
    state.arena.obstacles = [
      {
        id: 'w',
        kind: 'stone',
        position: v(disc.position.x - 1, 0),
        half: v(0.1, 3),
        broken: false,
      },
    ];
    for (let i = 0; i < 60 && disc.movement !== 'free'; i++) frame(state);
    expect(disc.movement).toBe('free');
    for (let i = 0; i < 120 && disc.movement !== 'dropped'; i++) frame(state);
    expect(disc.movement).toBe('dropped');
    expect(disc.projectile).toBe(false);
    expect(disc.ownerId).toBe(owner.id);
  });
  it('holding throw with empty hands builds retrieveCharge by dt / 4 and pulls a dropped disc home', () => {
    const state = arena();
    const owner = place(state, 0, 0, 0, 1, 0);
    place(state, 1, 0, 20);
    throwDisc(state, owner);
    const disc = state.discs[0];
    Object.assign(disc, {
      position: v(6, 0),
      velocity: v(),
      stored: v(),
      movement: 'dropped',
      state: 'dropped',
      projectile: false,
    });
    disc.canCollideWithOwner = true;
    frame(state, { 0: { throwHeld: true } });
    expect(owner.retrieveCharge).toBeCloseTo(RULES.dt / 4, 9);
    for (let i = 0; i < 240 && state.discs.length; i++) frame(state, { 0: { throwHeld: true } });
    expect(state.discs).toHaveLength(0);
    expect(owner.armed).toBe(true);
  });
  it('sweeping the aim before release curves the throw toward the sweep', () => {
    const lateral = (turn: number): number => {
      const state = arena();
      place(state, 0, 0, 0, 1, 0);
      place(state, 1, 0, 30);
      for (let i = 0; i < 20; i++)
        frame(state, { 0: { throwHeld: true, move: v(1, (turn * i) / 20) } });
      frame(state, { 0: { throwReleased: true, move: v(1, turn) } });
      const disc = state.discs[0];
      const start = { ...disc.position };
      const heading = normalize(disc.throwDirection!);
      for (let i = 0; i < 20; i++) frame(state);
      return cross(heading, v(disc.position.x - start.x, disc.position.y - start.y));
    };
    expect(Math.abs(lateral(0))).toBeLessThan(1e-6);
    expect(Math.sign(lateral(1))).toBe(-Math.sign(lateral(-1)));
    expect(Math.abs(lateral(1))).toBeGreaterThan(0.2);
  });
  it('two discs from different owners collide and slow time briefly', () => {
    const state = arena();
    const a = place(state, 0, -6, 0, 1, 0);
    const b = place(state, 1, 6, 0, -1, 0);
    throwDisc(state, a);
    throwDisc(state, b);
    for (let i = 0; i < 30 && !state.events.some((e) => e.type === 'clash'); i++) frame(state);
    expect(state.events.some((e) => e.type === 'clash' && e.value === 1)).toBe(true);
    expect(state.clock!.slowHold + state.clock!.slowOut).toBeGreaterThan(0);
  });
  it('a shield bounces a disc and stuns its holder instead of dying', () => {
    const state = arena();
    const thrower = place(state, 0, -5, 0, 1, 0);
    const holder = place(state, 1, 2, 0, -1, 0);
    grantPowerup(state, holder, 'shield');
    throwDisc(state, thrower);
    for (let i = 0; i < 40 && holder.shield; i++) frame(state);
    expect(holder.alive).toBe(true);
    expect(holder.shield).toBe(false);
    expect(holder.invulnerable).toBeGreaterThan(0.5);
    expect(holder.killerId).toBe(thrower.id);
    expect(state.discs[0].velocity.x).toBeLessThan(0);
  });
});

describe('Actor contact and attribution', () => {
  it('dashing into a standing actor stuns and shoves them; the dash stops', () => {
    const state = arena();
    const dasher = place(state, 0, -1.2, 0, 1, 0);
    const target = place(state, 1, 0, 0, -1, 0);
    frame(state, { 0: { dash: true, move: v(1, 0) } });
    for (let i = 0; i < 6 && target.stun <= 0; i++) frame(state);
    expect(target.stun).toBeGreaterThan(0.3);
    expect(dasher.dashTime).toBeLessThan(NATIVE.actor.dashDuration * 0.35);
    frame(state);
    expect(target.velocity.x).toBeGreaterThan(0);
  });
  it('a push-off death is credited to the pusher within two seconds', () => {
    const state = arena();
    const pusher = place(state, 0, 0, 0);
    const victim = place(state, 1, 3, 0);
    victim.killerId = pusher.id;
    victim.killerType = 'Push';
    victim.killerTimer = NATIVE.combat.killerPush;
    damageActor(state, victim, victim.id, v(), 'fall');
    expect(pusher.kills).toBe(1);
    expect(pusher.score).toBe(1);
    expect(victim.score).toBe(0);
  });
  it('rapid kills raise a streak and a third freezes the frame', () => {
    const state = createState({ ...defaultOptions(), bots: 3 });
    state.phase = 'playing';
    const killer = state.actors[0];
    for (const victim of state.actors.slice(1)) damageActor(state, victim, killer.id, v(1, 0));
    const streaks = state.events.filter((e) => e.type === 'streak').map((e) => e.value);
    expect(streaks).toEqual([2, 3]);
    expect(state.hitStop).toBeCloseTo(NATIVE.slowMo.streakFreeze);
    expect(length(killer.velocity)).toBe(0);
  });
  it('uses the reference actor radius and walk speed in Web units', () => {
    expect(RULES.playerRadius).toBeCloseTo(0.66 * 1.33 * U, 9);
    const state = arena();
    const actor = place(state, 0, 0, 0);
    for (let i = 0; i < 180; i++)
      tickActor(state, actor, { ...idleCommand(), move: v(1, 0) }, RULES.dt);
    // Terminal speed = walk force / drag = 200 / 11 Unity units per second.
    expect(actor.velocity.x).toBeCloseTo(((200 * U) / 11) * (1 - 11 * RULES.dt), 1);
  });
});
