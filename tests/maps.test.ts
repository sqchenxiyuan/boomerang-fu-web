import { describe, expect, it } from 'vitest';
import { createArena, MAPS, selectRoundMap } from '../src/core/arena';
import { lineOfSight, safePosition } from '../src/core/collision';
import { RULES } from '../src/core/config';
import { add, distance, v } from '../src/core/math';
import type { Arena, Disc } from '../src/core/types';
import { advancePath, clearPathSegment, findPath } from '../src/simulation/navigation';
import {
  PORTAL_COOLDOWN,
  portalDestination,
  teleportDisc,
  tickActorPortals,
  tracePortal,
} from '../src/simulation/portals';
import { createState } from '../src/simulation/state';
import { Game } from '../src/simulation/game';
import { defaultOptions } from '../src/simulation/state';
import { tickDiscs } from '../src/simulation/projectiles';
import { driveBotGame } from './bot-fixture';

function walkingDistance(arena: Arena, from = v(-9, 0), to = v(9, 0)): number {
  const path = findPath(arena, from, to);
  expect(path.length).toBeGreaterThan(0);
  return path.reduce(
    (sum, point, i) => sum + (point.viaPortal ? 0.1 : distance(i ? path[i - 1] : from, point)),
    0,
  );
}

describe('map geometry and routes', () => {
  it.each(MAPS)(
    '$id has safe, connected spawns and pickup positions before crates are broken',
    ({ id }) => {
      const arena = createArena(id);
      expect(arena.id).toBe(id);
      expect(arena.spawns).toHaveLength(4);
      for (const position of [...arena.spawns, ...arena.pickupSpawns]) {
        expect(
          safePosition(arena, position, RULES.playerRadius + 0.13),
          `${id}:${JSON.stringify(position)}`,
        ).toBe(true);
      }
      for (let i = 0; i < arena.spawns.length; i++) {
        for (const other of arena.spawns.slice(i + 1))
          expect(distance(arena.spawns[i], other)).toBeGreaterThan(4);
        for (const target of [...arena.spawns, ...arena.pickupSpawns]) {
          const start = arena.spawns[i],
            path = findPath(arena, start, target);
          expect(
            path.length,
            `${id} ${JSON.stringify(start)} -> ${JSON.stringify(target)}`,
          ).toBeGreaterThan(0);
          expect(distance(path[path.length - 1], target)).toBeLessThan(0.01);
          let previous = start;
          for (const point of path) {
            if (point.viaPortal) {
              const entry = arena.portals!.find((p) => p.id === point.viaPortal)!;
              expect(distance(previous, entry.position)).toBeLessThan(0.01);
              expect(
                distance(point, portalDestination(arena, entry, RULES.playerRadius)!),
              ).toBeLessThan(0.01);
            } else
              expect(
                clearPathSegment(arena, previous, point),
                `${id} segment ${JSON.stringify([previous, point])}`,
              ).toBe(true);
            previous = point;
          }
        }
      }
      // A conventional route remains available even when a player declines to use portals.
      const ordinary = createArena(id);
      ordinary.portals = [];
      for (const point of ordinary.spawns.slice(1))
        expect(findPath(ordinary, ordinary.spawns[0], point).length).toBeGreaterThan(0);
      for (const pit of arena.pits) {
        expect(Math.abs(pit.position.x) + pit.half.x).toBeLessThan(arena.halfWidth);
        expect(Math.abs(pit.position.y) + pit.half.y).toBeLessThan(arena.halfHeight);
      }
    },
  );

  it('keeps match instances independent and rotates deterministically from the selected map', () => {
    const first = createArena('market'),
      second = createArena('market');
    first.obstacles[0].broken = true;
    first.spawns[0].x = 900;
    expect(second.obstacles[0].broken).toBe(false);
    expect(second.spawns[0].x).toBe(-9);
    expect(selectRoundMap('market', 'fixed', 9)).toBe('market');
    expect([1, 2, 3, 4, 5, 6].map((round) => selectRoundMap('market', 'cycle', round))).toEqual([
      'market',
      'switchback',
      'portals',
      'courtyard',
      'canal',
      'market',
    ]);
  });

  it('creates real water crossings, destructible routes, winding corridors and portal shortcuts', () => {
    const canal = createArena('canal');
    expect(canal.pits).toHaveLength(4);
    expect(safePosition(canal, v(0, -5.5), RULES.playerRadius)).toBe(false);
    expect(clearPathSegment(canal, v(-2.2, -3), v(2.2, -3))).toBe(true);
    expect(clearPathSegment(canal, v(-2.2, 3), v(2.2, 3))).toBe(true);
    const market = createArena('market');
    const before = walkingDistance(market);
    expect(lineOfSight(market, v(-9, 0), v(9, 0))).toBe(false);
    market.obstacles
      .filter((o) => o.kind === 'crate')
      .forEach((o) => {
        o.broken = true;
      });
    expect(lineOfSight(market, v(-9, 0), v(9, 0))).toBe(true);
    expect(walkingDistance(market)).toBeLessThan(before);
    expect(walkingDistance(createArena('switchback'), v(-8, 0), v(8, 0))).toBeGreaterThan(
      16 * 1.15,
    );
    const portals = createArena('portals');
    const path = findPath(portals, v(-9, 2.6), v(9, -2.6));
    expect(path.some((point) => point.portalId)).toBe(true);
    const through = walkingDistance(portals, v(-9, 2.6), v(9, -2.6));
    const noPortals = createArena('portals');
    noPortals.portals = [];
    expect(through).toBeLessThan(walkingDistance(noPortals, v(-9, 2.6), v(9, -2.6)) * 0.6);
  });

  it('derives navigation bounds from the arena instead of the original courtyard grid', () => {
    const arena = createArena('market');
    arena.halfWidth = 19;
    arena.obstacles = [
      { id: 'barrier', kind: 'stone', position: v(14, 0), half: v(0.5, 3), broken: false },
    ];
    const path = findPath(arena, v(12, 0), v(17, 0));
    expect(path.length).toBeGreaterThan(1);
    expect(path.some((p) => p.x > 14)).toBe(true);
    expect(distance(path[path.length - 1], v(17, 0))).toBe(0);
  });

  it('can leave a wall-hugging position with only body clearance', () => {
    const arena = createArena('switchback');
    const start = v(-4.73, 0);
    expect(safePosition(arena, start, RULES.playerRadius)).toBe(true);
    expect(safePosition(arena, start, RULES.playerRadius + 0.13)).toBe(false);
    expect(findPath(arena, start, v(0, 0)).length).toBeGreaterThan(0);
  });
});

describe('complete autonomous matches on every map', () => {
  it('rotates through all five maps during a naturally completed match and restarts at the chosen map', () => {
    const options = {
      ...defaultOptions(),
      mapId: 'market' as const,
      mapRotation: 'cycle' as const,
      bots: 3,
      seed: 8151,
    };
    const game = new Game(options);
    game.state.actors.forEach((actor) => {
      actor.controller = 'bot';
    });
    const visited = new Set<string>();
    let ticks = 0,
      combatDeaths = 0;
    while (game.state.phase !== 'matchEnd' && ticks < 60 * 700) {
      driveBotGame(game);
      ticks++;
      expect(game.state.arena.id).toBe(selectRoundMap('market', 'cycle', game.state.round));
      visited.add(game.state.arena.id!);
      for (const event of game.drainEvents())
        if (event.type === 'death' && (event.cause === 'weapon' || event.cause === 'explosion'))
          combatDeaths++;
    }
    expect(game.state.phase).toBe('matchEnd');
    expect(visited.size).toBe(5);
    expect(combatDeaths).toBeGreaterThan(5);
    game.start(options);
    expect(game.state.arena.id).toBe('market');
    expect(game.state.round).toBe(1);
    expect(
      game.state.actors.every((actor) => actor.score === 0 && (actor.portalCooldown ?? 0) === 0),
    ).toBe(true);
  }, 30000);
  const scenarios = MAPS.flatMap(({ id }) => [
    { id, players: 2, seed: 41 },
    { id, players: 2, seed: 295 },
    { id, players: 4, seed: 5526 },
  ]);
  it.each(scenarios)(
    '$id / $players bots / seed $seed completes through actual combat',
    ({ id, players, seed }) => {
      const game = new Game({ ...defaultOptions(), mapId: id, bots: players - 1, seed });
      game.state.actors.forEach((actor) => {
        actor.controller = 'bot';
      });
      const counts: Record<string, number> = {},
        deaths: Record<string, number> = {};
      const portalTrace: Record<string, unknown>[] = [];
      let ticks = 0;
      const roundMaps = new Set<string>();
      while (game.state.phase !== 'matchEnd' && ticks < 60 * 700) {
        driveBotGame(game);
        ticks++;
        roundMaps.add(game.state.arena.id!);
        for (const event of game.drainEvents()) {
          counts[event.type] = (counts[event.type] ?? 0) + 1;
          if (event.type === 'teleport') {
            const kind = `teleport:${event.entityType}`;
            counts[kind] = (counts[kind] ?? 0) + 1;
            if (portalTrace.length < 80)
              portalTrace.push({
                tick: ticks,
                actor: event.actorId,
                entity: event.entityId,
                kind: event.entityType,
                entry: event.position,
                exit: event.destination,
              });
          }
          if (event.type === 'death')
            deaths[event.cause ?? 'unknown'] = (deaths[event.cause ?? 'unknown'] ?? 0) + 1;
        }
        for (const actor of game.state.actors) {
          if (!Number.isFinite(actor.position.x + actor.position.y))
            throw new Error('Non-finite position');
          if (game.state.discs.filter((disc) => disc.ownerId === actor.id).length > 1)
            throw new Error('Duplicate owned disc');
        }
      }
      const result = {
        map: id,
        players,
        seed,
        ticks,
        seconds: ticks / 60,
        rounds: game.state.round,
        scores: game.state.actors.map((actor) => actor.score),
        kills: game.state.actors.map((actor) => actor.kills),
        counts,
        deaths,
        phase: game.state.phase,
        portalTrace,
      };
      expect(game.state.phase, JSON.stringify(result)).toBe('matchEnd');
      expect([...roundMaps]).toEqual([id]);
      expect(game.state.actors.some((actor) => actor.score === 5)).toBe(true);
      expect(
        (deaths.weapon ?? 0) + (deaths.explosion ?? 0),
        JSON.stringify(result),
      ).toBeGreaterThanOrEqual(2);
      expect(counts.throw, JSON.stringify(result)).toBeGreaterThanOrEqual(5);
      if (id === 'portals') expect(counts.teleport, JSON.stringify(result)).toBeGreaterThan(0);
      console.log(JSON.stringify({ ...result, portalTrace: undefined }));
    },
    30000,
  );
});

function portalState() {
  const state = createState();
  state.phase = 'playing';
  state.arena = createArena('portals');
  state.arena.obstacles = [];
  state.arena.portals = [
    { id: 'a', exitId: 'b', position: v(-3, 0), direction: v(-1, 0), radius: 0.7, color: '#0ff' },
    { id: 'b', exitId: 'a', position: v(3, 0), direction: v(1, 0), radius: 0.7, color: '#0ff' },
  ];
  state.events = [];
  const actor = state.actors[0];
  actor.previous = v(-5, 0);
  actor.position = v(-2, 0);
  actor.velocity = v(5, 0);
  actor.facing = v(1, 0);
  return state;
}

describe('portal interactions', () => {
  it('orders real projectile movement through a gate before a farther wall and rejects an earlier wall', () => {
    const run = (wallX: number) => {
      const state = portalState();
      state.actors[0].position = v(-9, 6);
      state.actors[1].position = v(9, 6);
      state.arena.obstacles = [
        { id: 'wall', kind: 'stone', position: v(wallX, 0), half: v(0.1, 2), broken: false },
      ];
      const disc: Disc = {
        id: 20,
        ownerId: 0,
        damageOwnerId: 0,
        position: v(-5, 0),
        previous: v(-5, 0),
        velocity: v(180, 0),
        state: 'outbound',
        age: 0.05,
        stateTime: 0.05,
        charge: 0,
        curve: 0,
        bounces: 0,
        explosive: false,
        fuse: 1.5,
        grace: 0,
        lastDeflector: -1,
        dead: false,
      };
      state.discs = [disc];
      tickDiscs(state, RULES.dt);
      return state;
    };
    const gateFirst = run(-1);
    expect(
      gateFirst.events.some((event) => event.type === 'teleport' && event.entityType === 'disc'),
    ).toBe(true);
    expect(gateFirst.discs[0].position.x).toBeGreaterThan(4);
    const wallFirst = run(-4.5);
    expect(wallFirst.events.some((event) => event.type === 'teleport')).toBe(false);
    expect(wallFirst.discs[0].position.x).toBeLessThan(-4.5);
  });
  it('bots walk away from the exit instead of repeatedly exchanging gates', () => {
    const game = new Game({ ...defaultOptions(), mapId: 'portals', seed: 295 });
    game.state.actors.forEach((actor) => {
      actor.controller = 'bot';
    });
    let transfers = 0;
    for (let tick = 0; tick < 60 * 8; tick++) {
      driveBotGame(game);
      for (const event of game.drainEvents())
        if (event.type === 'teleport' && event.entityType === 'actor') transfers++;
    }
    expect(transfers).toBeGreaterThan(0);
    expect(transfers).toBeLessThan(20);
  });
  it('transports a crossing actor, preserves velocity and prevents interpolation across the map', () => {
    const state = portalState(),
      actor = state.actors[0];
    expect(tickActorPortals(state, RULES.dt)).toEqual([0]);
    expect(actor.position).toEqual(v(4.25, 0));
    expect(actor.previous).toEqual(actor.position);
    expect(actor.velocity).toEqual(v(5, 0));
    expect(actor.facing).toEqual(v(1, 0));
    expect(actor.portalCooldown).toBe(PORTAL_COOLDOWN);
    expect(state.events.filter((e) => e.type === 'teleport')).toHaveLength(1);
  });

  it('does not chain jump while still inside an exit or during the two-tick lock', () => {
    const state = portalState(),
      actor = state.actors[0];
    tickActorPortals(state, RULES.dt);
    actor.previous = { ...actor.position };
    actor.position = v(3, 0);
    expect(tickActorPortals(state, RULES.dt)).toEqual([]);
    for (let i = 0; i < 15; i++) {
      actor.previous = { ...actor.position };
      expect(tickActorPortals(state, RULES.dt)).toEqual([]);
    }
    expect(state.events.filter((e) => e.type === 'teleport')).toHaveLength(1);
    actor.previous = v(5, 0);
    actor.position = v(3, 0);
    expect(tickActorPortals(state, RULES.dt)).toEqual([0]);
  });

  it('cannot cross an earlier wall or teleport to an obstructed exit', () => {
    const state = portalState();
    state.arena.obstacles = [
      { id: 'wall', kind: 'stone', position: v(-4.6, 0), half: v(0.1, 2), broken: false },
    ];
    expect(tickActorPortals(state, RULES.dt)).toEqual([]);
    state.arena.obstacles[0].position = v(4.25, 0);
    expect(tracePortal(state.arena, v(-5, 0), v(4, 0), RULES.playerRadius)).toBeNull();
  });

  it('preserves projectile direction and ownership when swept across a gate at high speed', () => {
    const state = portalState();
    const disc: Disc = {
      id: 9,
      ownerId: 0,
      damageOwnerId: 1,
      position: v(-5, 0),
      previous: v(-5, 0),
      velocity: v(80, 0),
      state: 'outbound',
      age: 0.2,
      stateTime: 0.2,
      charge: 1,
      curve: 0.1,
      bounces: 0,
      explosive: false,
      fuse: 1,
      grace: 0,
      lastDeflector: 1,
      dead: false,
    };
    const hit = tracePortal(state.arena, disc.position, v(10, 0), RULES.discRadius)!;
    expect(hit.t).toBeLessThan(0.2);
    teleportDisc(state, disc, hit);
    expect(disc.position).toEqual(v(4, 0));
    expect(disc.previous).toEqual(disc.position);
    expect(disc.velocity).toEqual(v(80, 0));
    expect([disc.ownerId, disc.damageOwnerId, disc.curve]).toEqual([0, 1, 0.1]);
    expect(
      tracePortal(state.arena, v(-5, 0), v(10, 0), RULES.discRadius, disc.portalCooldown),
    ).toBeNull();
  });

  it('retains portal waypoints until the actor actually arrives at the exit', () => {
    const arena = createArena('portals');
    const path = findPath(arena, v(-9, 2.6), v(9, -2.6));
    const i = path.findIndex((p) => p.portalId);
    const portalPath = path.slice(i);
    advancePath(portalPath, add(portalPath[0], v(0.1, 0)));
    expect(portalPath[0].portalId).toBeTruthy();
    const exit = { ...portalPath[1] };
    advancePath(portalPath, exit);
    expect(portalPath[0].portalId).toBeUndefined();
    expect(portalPath.some((p) => distance(p, exit) < 0.01)).toBe(false);
  });
});
