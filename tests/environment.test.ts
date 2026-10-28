import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { floorContains, obstacleDistance, pathBounds } from '../src/core/geometry';
import { Random, distance, v, add, sub, normalize, rotate } from '../src/core/math';
import { createOriginalArena, ORIGINAL_MAPS } from '../src/core/original-maps';
import { safePosition } from '../src/core/collision';
import type { EnvironmentMechanism, Floor, Obstacle } from '../src/core/types';
import {
  activateEnvironment,
  damageEnvironmentObstacle,
  strikeEnvironment,
  tickEnvironment,
  tickEnvironmentContacts,
} from '../src/simulation/environment';
import { Game } from '../src/simulation/game';
import { createState, defaultOptions, resetRound } from '../src/simulation/state';

const rectangle = (x: number, y: number) => [[v(-x, -y), v(x, -y), v(x, y), v(-x, y)]];
it('clears previous-round platform ownership and slippery-floor physics', () => {
  const state = createState();
  Object.assign(state.actors[0], {
    movingFloorId: 'old-raft',
    wetFloor: true,
    slideFactor: 0.25,
    surfaceDrag: 1,
  });
  resetRound(state);
  expect(state.actors[0].movingFloorId).toBeUndefined();
  expect(state.actors[0].wetFloor).toBe(false);
  expect(state.actors[0].slideFactor).toBe(1);
  expect(state.actors[0].surfaceDrag).toBe(RULES.damping);
});
const floor = (id: string, position = v(), kind: Floor['kind'] = 'ground'): Floor => ({
  id,
  position,
  kind,
  active: true,
  paths: rectangle(2, 2),
});
const obstacle = (id: string, position = v(), half = v(0.2, 2)): Obstacle => ({
  id,
  position,
  half,
  kind: 'stone',
  broken: false,
});

function scene(items: EnvironmentMechanism[] = []) {
  const state = createState({ ...defaultOptions(), mapId: 'courtyard' });
  state.phase = 'playing';
  state.weaponsGranted = true;
  state.arena = {
    halfWidth: 30,
    halfHeight: 30,
    obstacles: [],
    pits: [],
    spawns: [],
    pickupSpawns: [],
    environment: { mechanisms: items },
  };
  state.actors[0].position = v();
  state.actors[0].previous = v();
  state.actors[1].position = v(20, 20);
  state.actors[1].previous = v(20, 20);
  const random = new Random(35);
  const tick = (frames = 1) => {
    for (let i = 0; i < frames; i++) {
      state.time += RULES.dt;
      tickEnvironment(state, random, RULES.dt);
    }
  };
  const contact = () => tickEnvironmentContacts(state, RULES.dt);
  tickEnvironment(state, random, 0);
  return { state, actor: state.actors[0], random, tick, contact };
}

describe('original switches and motion', () => {
  it('accepts a wall-mounted lever while ignoring its backing wall and non-Obstacle source layers', () => {
    const lever: EnvironmentMechanism = {
      id: 'switch',
      kind: 'switch',
      position: v(1, 0),
      radius: 0.2,
    };
    const { state } = scene([lever]);
    state.arena.obstacles = [
      { ...obstacle('backing', v(1.3, 0), v(0.4, 1)), sourceLayer: 8 },
      { ...obstacle('prop', v(0.5, 0), v(0.1, 0.2)), sourceLayer: 19 },
    ];
    strikeEnvironment(state, {
      kind: 'melee',
      position: v(),
      direction: v(1, 0),
      radius: 1.5,
      actorId: 0,
      serial: 1,
    });
    expect(lever.cooldown).toBe(0.5);
  });

  it('can activate every exported lever from a safe nearby melee position', () => {
    let count = 0;
    for (const info of ORIGINAL_MAPS) {
      const ids = createOriginalArena(info.id)
        .environment!.mechanisms.filter((m) => m.kind === 'switch')
        .map((m) => m.id);
      for (const id of ids) {
        const { state, tick } = scene();
        state.arena = createOriginalArena(info.id);
        tickEnvironment(state, new Random(1), 0);
        const lever = state.arena.environment!.mechanisms.find((m) => m.id === id)!;
        let activated = false;
        outer: for (const radius of [0.65, 1, 1.35, 1.7, 2.05, 2.4])
          for (let i = 0; i < 48; i++) {
            const point = add(lever.position, rotate(v(radius, 0), (i * Math.PI) / 24));
            if (!safePosition(state.arena, point, RULES.playerRadius + 0.02)) continue;
            strikeEnvironment(state, {
              kind: 'melee',
              position: point,
              direction: normalize(sub(lever.position, point)),
              radius: RULES.attackRange,
              actorId: 0,
              serial: ++count,
            });
            if ((lever.cooldown ?? 0) > 0) {
              activated = true;
              break outer;
            }
          }
        expect(activated, `${info.id}:${id}`).toBe(true);
        const targets = state.arena.environment!.mechanisms.filter((m) =>
          lever.targetIds?.includes(m.id),
        );
        const before = targets.map((m) => ({
          position: { ...m.position },
          angle: m.angle ?? 0,
          height: m.height ?? 0,
        }));
        tick(30);
        expect(
          targets.some(
            (m, i) =>
              distance(m.position, before[i].position) > 1e-5 ||
              Math.abs((m.angle ?? 0) - before[i].angle) > 1e-5 ||
              Math.abs((m.height ?? 0) - before[i].height) > 1e-5,
          ),
          `${info.id}:${id} target movement`,
        ).toBe(true);
      }
    }
  });
  it('rotates exported TurnTeleportals gates at 12 degrees per second, including the duplicate-component group', () => {
    const { state, tick } = scene();
    state.arena = createOriginalArena('original-turn-teleportals');
    const groups = state.arena.environment!.mechanisms.filter(
      (m) => m.source?.className === 'AutoRotate',
    );
    expect(groups).toHaveLength(2);
    const gates = groups.map((m) => state.arena.portals!.find((p) => p.id === m.portalIds![0])!);
    const before = gates.map((p) => Math.atan2(p.direction.y, p.direction.x));
    tick(60);
    for (let i = 0; i < gates.length; i++) {
      const after = Math.atan2(gates[i].direction.y, gates[i].direction.x);
      expect(Math.atan2(Math.sin(after - before[i]), Math.cos(after - before[i]))).toBeCloseTo(
        -Math.PI / 15,
      );
    }
  });

  it('keeps exported RollerSweep destroyer regions attached to their rotating parent', () => {
    const { state, tick } = scene();
    state.arena = createOriginalArena('original-roller-sweep');
    const children = state.arena.environment!.mechanisms.filter((m) => m.kind === 'destroyer');
    expect(children).toHaveLength(4);
    const parent = children.map(
      (m) => state.arena.environment!.mechanisms.find((p) => p.id === m.parentId)!,
    );
    const offsets = children.map((m, i) => (m.angle ?? 0) - (parent[i].angle ?? 0));
    tick(60);
    for (let i = 0; i < children.length; i++)
      expect((children[i].angle ?? 0) - (parent[i].angle ?? 0)).toBeCloseTo(offsets[i]);
  });
  it('toggles all linked targets, respects cooldown and one activation per melee window', () => {
    const wall: EnvironmentMechanism = {
      id: 'wall',
      kind: 'movingObstacle',
      position: v(5, 0),
      waypoints: [{ position: v(5, 0) }, { position: v(8, 0) }],
    };
    const door: EnvironmentMechanism = {
      id: 'door',
      kind: 'door',
      position: v(5, 5),
      closed: true,
      canClose: true,
    };
    const lever: EnvironmentMechanism = {
      id: 'switch',
      kind: 'switch',
      position: v(1, 0),
      targetIds: ['wall', 'door'],
    };
    const { state, tick } = scene([wall, door, lever]);
    const strike = {
      kind: 'melee' as const,
      position: v(),
      direction: v(1, 0),
      radius: 1.3,
      actorId: 0,
      serial: 1,
    };
    strikeEnvironment(state, strike);
    expect(wall.phase).toBe('preparing');
    expect(door.closed).toBe(false);
    expect(activateEnvironment(state, 'switch')).toBe(false);
    tick(31);
    strikeEnvironment(state, strike);
    expect(door.closed).toBe(false);
    strikeEnvironment(state, { ...strike, serial: 2 });
    expect(door.closed).toBe(true);
    tick(31);
    lever.oneShot = true;
    expect(activateEnvironment(state, 'switch')).toBe(true);
    tick(31);
    expect(activateEnvironment(state, 'switch')).toBe(false);
  });

  it('rejects melee behind a wall and disc impacts from the lever back', () => {
    const lever: EnvironmentMechanism = {
      id: 'switch',
      kind: 'switch',
      position: v(1, 0),
      radius: 0.2,
    };
    const { state, actor } = scene([lever]);
    state.arena.obstacles.push(obstacle('block', v(0.5, 0), v(0.1, 0.5)));
    strikeEnvironment(state, {
      kind: 'melee',
      position: v(),
      direction: v(1, 0),
      radius: 2,
      actorId: 0,
      serial: 1,
    });
    expect(lever.cooldown ?? 0).toBe(0);
    state.arena.obstacles = [];
    actor.position = v(20, 0);
    strikeEnvironment(state, {
      kind: 'disc',
      from: v(1, 1),
      position: v(1, -1),
      direction: v(0, -1),
      radius: 0.1,
      actorId: 0,
    });
    expect(lever.cooldown ?? 0).toBe(0);
    strikeEnvironment(state, {
      kind: 'disc',
      from: v(1, -1),
      position: v(1, 1),
      direction: v(0, 1),
      radius: 0.1,
      actorId: 0,
    });
    expect(lever.cooldown).toBe(0.5);
  });

  it('uses the SlideTraps resource timings and returns automatically after its spring pause', () => {
    const wall: EnvironmentMechanism = {
      id: 'wall',
      kind: 'movingObstacle',
      position: v(),
      waypoints: [{ position: v() }, { position: v(8.68, 0) }],
      duration: 0.6,
      preDelay: 0.25,
      spring: true,
      springPause: 1.2,
      returnDuration: 1.4,
    };
    const { state, tick } = scene([wall]);
    activateEnvironment(state, wall.id, 1);
    tick(14);
    expect(wall.position.x).toBe(0);
    tick(37);
    expect(wall.position.x).toBeCloseTo(8.68);
    expect(wall.phase).toBe('springPause');
    tick(70);
    expect(wall.position.x).toBeCloseTo(8.68);
    tick(87);
    expect(wall.position.x).toBeCloseTo(0);
    expect(wall.phase).toBe('idle');
  });

  it('reverses a sliding wall continuously and preserves the second pre-move delay', () => {
    const wall: EnvironmentMechanism = {
      id: 'wall',
      kind: 'movingObstacle',
      position: v(),
      waypoints: [{ position: v() }, { position: v(10, 0) }],
      duration: 1,
      preDelay: 0.1,
    };
    const { state, tick } = scene([wall]);
    activateEnvironment(state, wall.id);
    tick(20);
    const atReverse = wall.position.x;
    activateEnvironment(state, wall.id);
    tick(5);
    expect(wall.position.x).toBeCloseTo(atReverse);
    tick();
    expect(wall.position.x).toBeLessThan(atReverse);
    expect(wall.position.x).toBeGreaterThan(atReverse - 1);
    tick(60);
    expect(wall.position.x).toBeCloseTo(0);
  });

  it('keeps rotation unwrapped through complete turns and cycles configured speeds', () => {
    const wall: EnvironmentMechanism = {
      id: 'spin',
      kind: 'movingObstacle',
      position: v(),
      rotating: true,
      clockwise: false,
      rotationDurations: [2, 4],
    };
    const { state, tick } = scene([wall]);
    tick(180);
    expect(wall.angle).toBeCloseTo(Math.PI * 3);
    activateEnvironment(state, wall.id);
    tick();
    expect(wall.rotationDuration).toBeGreaterThan(2);
    expect(wall.rotationDuration).toBeLessThan(4);
    activateEnvironment(state, wall.id);
    tick();
    expect(wall.rotationDuration).toBe(2);
  });
});

describe('moving support and collision', () => {
  it('keeps reactive rotation continuous over repeated full turns', () => {
    const platform: EnvironmentMechanism = {
      id: 'maze',
      kind: 'reactiveFloor',
      position: v(),
      waypoints: [0, 1, 2].map((i) => ({ position: v(), angle: (-i * Math.PI * 2) / 3 })),
      duration: 0.2,
      preDelay: 0,
    };
    const { state, tick } = scene([platform]);
    for (let i = 0; i < 9; i++) {
      activateEnvironment(state, platform.id);
      for (let frame = 0; frame < 13; frame++) {
        tick();
        expect(Math.abs(platform.angularVelocity ?? 0)).toBeLessThan(20);
      }
    }
    expect(platform.angle).toBeCloseTo(-Math.PI * 6);
  });
  it('carries each ground object only once when two moving platforms overlap', () => {
    const platforms: EnvironmentMechanism[] = [1, 2].map((i) => ({
      id: `raft${i}`,
      kind: 'movingFloor',
      position: v(),
      floorIds: [`deck${i}`],
      waypoints: [{ position: v() }, { position: v(4, 0) }],
      duration: 1,
    }));
    const { state, tick } = scene(platforms);
    state.arena.floors = [floor('deck1', v(), 'moving'), floor('deck2', v(), 'moving')];
    state.pickups = [{ id: 1, position: v(), kind: 'shield', age: 0 }];
    state.zones = [
      { id: 2, position: v(), kind: 'fire', ownerId: 0, radius: 0.2, duration: 1, remaining: 1 },
    ];
    tick(6);
    expect(state.pickups[0].position.x).toBeCloseTo(0.4);
    expect(state.zones[0].position.x).toBeCloseTo(0.4);
    expect(state.arena.environment!.riders).toMatchObject({
      'pickup:1': 'raft1',
      'zone:2': 'raft1',
    });
  });

  it('carries a body overlapping a platform edge when most support samples are over the hazard', () => {
    const platform: EnvironmentMechanism = {
      id: 'raft',
      kind: 'movingFloor',
      position: v(),
      floorIds: ['deck'],
      waypoints: [{ position: v() }, { position: v(4, 0) }],
      duration: 1,
    };
    const { state, actor, tick } = scene([platform]);
    state.arena.floors = [floor('deck', v(), 'moving')];
    actor.position = v(2.2, 0);
    tick(6);
    expect(actor.movingFloorId).toBe('raft');
    expect(actor.position.x).toBeCloseTo(2.6);
  });
  it('attaches to only one overlapping moving platform and detaches after leaving', () => {
    const platforms: EnvironmentMechanism[] = [1, 2].map((i) => ({
      id: `raft${i}`,
      kind: 'movingFloor',
      position: v(),
      floorIds: [`deck${i}`],
      waypoints: [{ position: v() }, { position: v(4, 0) }],
      duration: 1,
    }));
    const { state, actor, tick } = scene(platforms);
    state.arena.floors = [floor('deck1', v(), 'moving'), floor('deck2', v(), 'moving')];
    tick(30);
    expect(actor.position.x).toBeCloseTo(2);
    expect(actor.movingFloorId).toBe('raft1');
    actor.position = v(20, 20);
    tick();
    expect(actor.movingFloorId).toBeUndefined();
  });
  it('carries actors, pickups and fire while transforming nested portal direction', () => {
    const platform: EnvironmentMechanism = {
      id: 'raft',
      kind: 'movingFloor',
      position: v(),
      floorIds: ['deck'],
      portalIds: ['gate'],
      waypoints: [
        { position: v(), angle: 0 },
        { position: v(4, 0), angle: Math.PI / 2 },
      ],
      minDuration: 1,
      maxDuration: 1,
      clockwise: true,
    };
    const child: EnvironmentMechanism = {
      id: 'lever',
      kind: 'switch',
      parentId: 'raft',
      position: v(1, 0),
    };
    const { state, actor, tick } = scene([platform, child]);
    state.arena.floors = [floor('deck', v(), 'moving')];
    actor.position = v(1, 0);
    actor.previous = v(1, 0);
    state.pickups.push({ id: 1, position: v(0, 1), kind: 'shield', age: 0 });
    state.zones.push({
      id: 2,
      position: v(-1, 0),
      kind: 'fire',
      ownerId: 1,
      radius: 0.2,
      duration: 5,
      remaining: 5,
    });
    state.arena.portals = [
      {
        id: 'gate',
        exitId: 'exit',
        position: v(0, -1),
        direction: v(0, -1),
        radius: 0.5,
        color: '#fff',
      },
    ];
    tick(60);
    expect(distance(actor.position, v(4, 1))).toBeLessThan(1e-6);
    expect(distance(state.pickups[0].position, v(3, 0))).toBeLessThan(1e-6);
    expect(distance(state.zones[0].position, v(4, -1))).toBeLessThan(1e-6);
    expect(distance(child.position, v(4, 1))).toBeLessThan(1e-6);
    expect(distance(state.arena.portals[0].direction, v(1, 0))).toBeLessThan(1e-6);
    expect(floorContains(state.arena.floors[0], actor.position)).toBe(true);
  });

  it('continues four-point platform rotations without a turn-sized velocity spike', () => {
    const platform: EnvironmentMechanism = {
      id: 'cog',
      kind: 'movingFloor',
      position: v(),
      clockwise: false,
      waypoints: [0, 1, 2, 3].map((i) => ({ position: v(), angle: (-i * Math.PI) / 2 })),
      duration: 0.2,
    };
    const { tick } = scene([platform]);
    for (let i = 0; i < 120; i++) {
      tick();
      expect(Math.abs(platform.angularVelocity ?? 0)).toBeLessThan(10);
    }
    expect(platform.angle).toBeLessThan(-Math.PI * 4);
  });

  it('applies anisotropic easing in the authored parent axes', () => {
    const platform: EnvironmentMechanism = {
      id: 'raft',
      kind: 'movingFloor',
      position: v(10, 20),
      motion: 'eased',
      motionOrigin: v(10, 20),
      motionAngle: Math.PI / 2,
      waypoints: [{ position: v(10, 20) }, { position: v(6, 24) }],
      duration: 1,
    };
    const { tick } = scene([platform]);
    tick(15);
    expect(platform.position.x).toBeCloseTo(10 - (4 * (1 - Math.cos(Math.PI / 4))) / 2);
    expect(platform.position.y).toBeCloseTo(20.25);
  });

  it('pushes with a fast thin wall instead of tunneling through the player', () => {
    const wall: EnvironmentMechanism = {
      id: 'wall',
      kind: 'movingObstacle',
      position: v(-2, 0),
      obstacleIds: ['body'],
      waypoints: [{ position: v(-2, 0) }, { position: v(2, 0) }],
      duration: 0.01,
      preDelay: 0,
    };
    const { state, actor, tick } = scene([wall]);
    state.arena.obstacles.push(obstacle('body', v(-2, 0)));
    activateEnvironment(state, wall.id, 1);
    tick();
    expect(actor.alive).toBe(true);
    expect(actor.position.x).toBeGreaterThan(2.6);
    expect(obstacleDistance(state.arena.obstacles[0], actor.position)).toBeGreaterThanOrEqual(
      RULES.playerRadius,
    );
  });

  it('crushes a body trapped between walls, bypasses shield and credits the lever owner', () => {
    const wall: EnvironmentMechanism = {
      id: 'wall',
      kind: 'movingObstacle',
      position: v(-2, 0),
      obstacleIds: ['body'],
      waypoints: [{ position: v(-2, 0) }, { position: v(0.7, 0) }],
      duration: 0.2,
      preDelay: 0,
    };
    const { state, actor, tick } = scene([wall]);
    state.arena.obstacles.push(obstacle('body', v(-2, 0)), obstacle('fixed', v(1, 0)));
    actor.shield = true;
    actor.invulnerable = 5;
    activateEnvironment(state, wall.id, 1);
    tick(12);
    expect(actor.alive).toBe(false);
    expect(
      state.events.some((e) => e.type === 'death' && e.cause === 'crush' && e.value === 1),
    ).toBe(true);
  });

  it('allows a wall-dash body to pass through a moving wall', () => {
    const wall: EnvironmentMechanism = {
      id: 'wall',
      kind: 'movingObstacle',
      position: v(-2, 0),
      obstacleIds: ['body'],
      waypoints: [{ position: v(-2, 0) }, { position: v(0, 0) }],
      duration: 0.01,
      preDelay: 0,
    };
    const { state, actor, tick } = scene([wall]);
    state.arena.obstacles.push(obstacle('body', v(-2, 0)));
    actor.powers = ['wallDash'];
    actor.dashTime = 0.1;
    activateEnvironment(state, wall.id);
    tick();
    expect(actor.alive).toBe(true);
    expect(actor.position).toEqual(v());
  });
});

describe('falling floors, doors and props', () => {
  it('can pressure-trigger all 397 exported trap tiles and remove their support after 2.5 seconds', () => {
    let checked = 0;
    for (const info of ORIGINAL_MAPS) {
      const { state, actor, tick } = scene();
      state.arena = createOriginalArena(info.id);
      tickEnvironment(state, new Random(1), 0);
      state.actors[1].position = v(1000, 1000);
      const traps = state.arena.environment!.mechanisms.filter((m) => m.kind === 'trapFloor');
      for (const trap of traps) {
        let triggered = false;
        const floors = state.arena.floors!.filter((f) => trap.floorIds?.includes(f.id));
        outer: for (const f of floors) {
          const { min, max } = pathBounds(f.paths);
          for (const x of [0.5, 0.25, 0.75, 0.1, 0.9])
            for (const y of [0.5, 0.25, 0.75, 0.1, 0.9]) {
              const point = add(
                f.position,
                rotate(v(min.x + (max.x - min.x) * x, min.y + (max.y - min.y) * y), f.angle ?? 0),
              );
              if (
                !floorContains(f, point) ||
                !safePosition(state.arena, point, RULES.playerRadius + 0.01)
              )
                continue;
              actor.position = point;
              delete trap.phase;
              tickEnvironmentContacts(state, 0);
              if (trap.phase === 'warning') {
                triggered = true;
                break outer;
              }
            }
        }
        expect(triggered, `${info.id}:${trap.id}`).toBe(true);
        checked++;
      }
      if (traps.length) {
        tick(150);
        for (const trap of traps)
          for (const id of trap.floorIds ?? [])
            expect(state.arena.floors!.find((f) => f.id === id)!.active, `${info.id}:${id}`).toBe(
              false,
            );
      }
    }
    expect(checked).toBe(397);
  });

  it('starts both exported permanent-collapse maps and samples the original level box', () => {
    for (const map of ['original-falling', 'original-falling2'] as const) {
      const { state, tick } = scene();
      state.arena = createOriginalArena(map);
      tickEnvironment(state, new Random(1), 0);
      const env = state.arena.environment!,
        box = state.arena.boundary!.half;
      expect(Math.abs(env.collapse!.finalPoint!.x)).toBeLessThanOrEqual(box.x * 0.8);
      expect(Math.abs(env.collapse!.finalPoint!.y)).toBeLessThanOrEqual(box.y * 0.8);
      tick(Math.ceil((env.collapse!.remaining + 2.1) / RULES.dt));
      expect(env.mechanisms.some((m) => m.kind === 'fallingFloor' && m.phase === 'falling')).toBe(
        true,
      );
      expect(state.arena.floors!.some((f) => !f.active)).toBe(true);
    }
  });
  it('does not start a trap while one of the nine foot samples is still on ordinary ground', () => {
    const trap: EnvironmentMechanism = {
      id: 'trap',
      kind: 'trapFloor',
      position: v(),
      floorIds: ['tile'],
    };
    const { state, actor, contact } = scene([trap]);
    state.arena.floors = [
      floor('tile', v(), 'falling'),
      { ...floor('shore', v(2.6, 0)), paths: rectangle(0.6, 2) },
    ];
    actor.position = v(1.8, 0);
    contact();
    expect(trap.phase).toBe('idle');
    actor.position = v(1.2, 0);
    contact();
    expect(trap.phase).toBe('warning');
  });

  it('starts a trap on body overlap even if the center has just crossed its edge', () => {
    const trap: EnvironmentMechanism = {
      id: 'trap',
      kind: 'trapFloor',
      position: v(),
      floorIds: ['tile'],
    };
    const { state, actor, contact } = scene([trap]);
    state.arena.floors = [floor('tile', v(), 'falling')];
    actor.position = v(2.2, 0);
    contact();
    expect(trap.phase).toBe('warning');
  });
  it('sinks destructibles parented to pressure floors without respawning the broken prop', () => {
    const trap: EnvironmentMechanism = {
      id: 'trap',
      kind: 'trapFloor',
      position: v(),
      floorIds: ['tile'],
      warningDuration: 0,
      fallDuration: 0.01,
    };
    const prop: EnvironmentMechanism = {
      id: 'prop',
      kind: 'destructible',
      position: v(),
      parentId: 'trap',
      obstacleIds: ['crate'],
      hitsLeft: 1,
    };
    const { state, tick } = scene([trap, prop]);
    state.arena.floors = [floor('tile', v(), 'falling')];
    state.arena.obstacles = [{ ...obstacle('crate'), kind: 'crate' }];
    activateEnvironment(state, trap.id);
    tick(2);
    expect(state.arena.obstacles[0].broken).toBe(true);
    tick(270);
    expect(trap.phase).toBe('idle');
    expect(state.arena.obstacles[0].broken).toBe(true);
  });

  it('destroyer triggers remove props and pickups without killing a live player', () => {
    const destroyer: EnvironmentMechanism = {
      id: 'destroyer',
      kind: 'destroyer',
      position: v(),
      paths: rectangle(1, 1),
    };
    const prop: EnvironmentMechanism = {
      id: 'prop',
      kind: 'destructible',
      position: v(),
      obstacleIds: ['crate'],
      hitsLeft: 1,
    };
    const { state, actor, contact } = scene([destroyer, prop]);
    state.arena.obstacles = [{ ...obstacle('crate'), kind: 'crate' }];
    state.pickups = [{ id: 1, position: v(), kind: 'shield', age: 0 }];
    contact();
    expect(actor.alive).toBe(true);
    expect(state.pickups).toHaveLength(0);
    expect(state.arena.obstacles[0].broken).toBe(true);
  });
  it('triggers pressure floors only without dash or alternative solid ground', () => {
    const trap: EnvironmentMechanism = {
      id: 'trap',
      kind: 'trapFloor',
      position: v(),
      floorIds: ['tile'],
    };
    const { state, actor, contact } = scene([trap]);
    state.arena.floors = [floor('tile', v(), 'falling')];
    actor.dashTime = 0.1;
    contact();
    expect(trap.phase).toBe('idle');
    actor.dashTime = 0;
    state.arena.floors.push(floor('bridge'));
    contact();
    expect(trap.phase).toBe('idle');
    state.arena.floors.pop();
    contact();
    expect(trap.phase).toBe('warning');
  });

  it('uses 2.5/1/4/.5-second pressure-floor phases and restores support .2 seconds into rising', () => {
    const trap: EnvironmentMechanism = {
      id: 'trap',
      kind: 'trapFloor',
      position: v(),
      floorIds: ['tile'],
    };
    const { state, tick, contact } = scene([trap]);
    state.arena.floors = [floor('tile', v(), 'falling')];
    contact();
    tick(149);
    expect(state.arena.floors[0].active).toBe(true);
    tick();
    expect(state.arena.floors[0].active).toBe(false);
    expect(trap.phase).toBe('falling');
    tick(60);
    expect(trap.phase).toBe('respawning');
    expect(trap.height).toBeCloseTo(-2);
    tick(240);
    expect(trap.phase).toBe('rising');
    tick(11);
    expect(state.arena.floors[0].active).toBe(false);
    tick();
    expect(state.arena.floors[0].active).toBe(true);
    tick(18);
    expect(trap.phase).toBe('idle');
    expect(trap.height).toBeCloseTo(0);
  });

  it('collapses the farthest chunks first, leaves six and pauses warnings after one survivor', () => {
    const items: EnvironmentMechanism[] = Array.from({ length: 8 }, (_, i) => ({
      id: `f${i}`,
      kind: 'fallingFloor',
      position: v(i, 0),
    }));
    const { state, tick } = scene(items);
    state.arena.environment!.initialized = false;
    state.arena.environment!.collapse = {
      enabled: true,
      interval: 0.1,
      remaining: 0,
      finalPoint: v(),
    };
    tick();
    expect(items[7].phase).toBe('warning');
    tick(10);
    expect(items[6].phase).toBe('warning');
    expect(state.arena.environment!.collapse!.playlist).toHaveLength(6);
    state.actors[1].alive = false;
    tick();
    const elapsed = items[7].elapsed;
    tick(180);
    expect(items[7].elapsed).toBe(elapsed);
    expect(items[0].phase).toBe('idle');
  });

  it('removes support at the start of a permanent fall, before the visual finishes', () => {
    const tile: EnvironmentMechanism = {
      id: 'tile',
      kind: 'fallingFloor',
      position: v(),
      floorIds: ['tile'],
    };
    const { state, tick } = scene([tile]);
    state.arena.floors = [floor('tile', v(), 'falling')];
    activateEnvironment(state, tile.id);
    tick(119);
    expect(state.arena.floors[0].active).toBe(true);
    tick();
    expect(state.arena.floors[0].active).toBe(false);
    expect(tile.height).toBe(0);
    tick(45);
    expect(tile.height).toBeCloseTo(-2.4);
    expect(tile.phase).toBe('cut');
  });

  it('switches door collision at the configured height and honors one-way doors', () => {
    const door: EnvironmentMechanism = {
      id: 'door',
      kind: 'door',
      position: v(5, 0),
      obstacleIds: ['body'],
      closed: true,
      canClose: false,
      height: 1,
      closedHeight: 1,
      openHeight: -1,
      solidHeight: 0,
      duration: 1,
    };
    const { state, tick } = scene([door]);
    state.arena.obstacles = [obstacle('body', v(5, 0))];
    activateEnvironment(state, door.id);
    tick(30);
    expect(state.arena.obstacles[0].disabled).toBe(false);
    tick(11);
    expect(state.arena.obstacles[0].disabled).toBe(true);
    tick(19);
    expect(activateEnvironment(state, door.id)).toBe(false);
  });

  it('shares multi-hit destructible health across colliders without repeated melee damage', () => {
    const prop: EnvironmentMechanism = {
      id: 'prop',
      kind: 'destructible',
      position: v(),
      obstacleIds: ['a', 'b'],
      hitsLeft: 2,
    };
    const { state } = scene([prop]);
    state.arena.obstacles = [obstacle('a'), obstacle('b')];
    damageEnvironmentObstacle(state, state.arena.obstacles[0], 0, 7);
    damageEnvironmentObstacle(state, state.arena.obstacles[1], 0, 7);
    expect(prop.hitsLeft).toBe(1);
    expect(state.arena.obstacles[0].broken).toBe(false);
    damageEnvironmentObstacle(state, state.arena.obstacles[1], 0, 8);
    expect(state.arena.obstacles.every((o) => o.broken)).toBe(true);
    expect(state.events.filter((e) => e.type === 'crate')).toHaveLength(1);
  });

  it('bends plants for ordinary strikes and burns or cuts them for elemental contact', () => {
    const plant: EnvironmentMechanism = {
      id: 'plant',
      kind: 'plant',
      position: v(1, 0),
      radius: 0.2,
    };
    const { state, contact } = scene([plant]);
    strikeEnvironment(state, {
      kind: 'melee',
      position: v(),
      direction: v(1, 0),
      radius: 1,
      actorId: 0,
      serial: 1,
    });
    expect(plant.disturbance).toBeGreaterThan(0);
    expect(plant.active).not.toBe(false);
    state.zones.push({
      id: 1,
      kind: 'ice',
      position: v(1, 0),
      radius: 0.5,
      ownerId: 1,
      remaining: 4,
      duration: 4,
    });
    contact();
    expect(plant.phase).toBe('cut');
  });

  it('runs environment clocks in the authoritative Game step', () => {
    const game = new Game({ ...defaultOptions(), mapId: 'courtyard' });
    game.state.phase = 'playing';
    const rotor: EnvironmentMechanism = {
      id: 'spin',
      kind: 'movingObstacle',
      rotating: true,
      position: v(),
      rotationDuration: 2,
    };
    game.state.arena.environment = { mechanisms: [rotor] };
    game.step();
    expect(rotor.angle).toBeCloseTo(-Math.PI / 60);
  });

  it('resumes environment state and seeded motion deterministically after JSON serialization', () => {
    const platform: EnvironmentMechanism = {
      id: 'raft',
      kind: 'movingFloor',
      position: v(),
      waypoints: [{ position: v() }, { position: v(4, 0) }],
      minDuration: 0.2,
      maxDuration: 0.4,
    };
    const { state, random, tick } = scene([platform]);
    tick(7);
    const restored = JSON.parse(JSON.stringify(state)),
      restoredRandom = new Random(random.seed);
    for (let i = 0; i < 80; i++) {
      tick();
      restored.time += RULES.dt;
      tickEnvironment(restored, restoredRandom, RULES.dt);
    }
    expect(restored.arena.environment).toEqual(JSON.parse(JSON.stringify(state.arena.environment)));
  });
});
