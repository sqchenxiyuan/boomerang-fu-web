import { createArena, mapInfo } from '../core/arena';
import { NATIVE, RULES } from '../core/config';
import { onGround, safePosition } from '../core/collision';
import { add, rotate, v, type Vec2 } from '../core/math';
import type { Arena, MapId } from '../core/types';
import { arenaCameraFrame } from '../rendering/arena-camera';
import { createBoundary, isInBoundary } from '../simulation/boundary';
import { hazardKind } from '../simulation/hazards';
import { Game } from '../simulation/game';
import { defaultOptions } from '../simulation/state';
import { BotDriver } from '../sdk/control';
import type { Command } from '../core/types';

/*
 * Static map audit: the layout facts a level designer checks, measured on the
 * map's start state. A walkability grid (player-radius clearance, no hazard)
 * is flood-filled from the spawns, with portal pairs linking their cells.
 * Distances and areas are reported in Unity units (web units / NATIVE.scale).
 * Moving/falling mechanisms are only seen at their starting positions.
 */
export const AUDIT_CELL = 0.2;
/** Actors take spawns by id and a web match has at most four, so spawns 5–6 never host anyone. */
export const PLAYER_SLOTS = 4; // web units (0.5 Unity units)
const U = NATIVE.scale;
const R = RULES.playerRadius;

export type FindingLevel = 'error' | 'warning' | 'info';
export interface Finding {
  level: FindingLevel;
  code: string;
  message: string;
}
export interface MapFeatures {
  hazard: 'water' | 'cliff' | 'none';
  pits: number;
  portals: number;
  mechanisms: string[];
  floorKinds: string[];
  /** Surface patches laid over the ground ('ice' slides, 'water' pools). */
  surfaceKinds: string[];
  plants: number;
  obstacles: number;
}
export interface StaticAudit {
  id: MapId;
  /** Walkable and spawn-reachable area, Unity units². */
  walkableArea: number;
  reachableArea: number;
  /** Reachable walkable area outside the play boundary (the out-of-bounds timer kills there). */
  outsideBoundaryArea: number;
  /** Reachable walkable area outside the camera framing. */
  outsideCameraArea: number;
  minSpawnDistance: number;
  /** The camera-framed play area, Unity units (the honest size of the map). */
  frame: { width: number; height: number };
  spawns: number;
  pickupSpawns: number;
  features: MapFeatures;
  findings: Finding[];
}

function pointProblems(
  arena: Arena,
  boundary: ReturnType<typeof createBoundary>,
  p: Vec2,
): string[] {
  const problems: string[] = [];
  if (!onGround(arena, p)) problems.push('不在地面上');
  else if (!safePosition(arena, p, R))
    problems.push(onGround(arena, p, R) ? '与障碍重叠' : '离边缘不足一个身位');
  if (hazardKind(arena, p)) problems.push('在坑/水上');
  if (!isInBoundary(boundary, p, R)) problems.push('在边界外');
  return problems;
}

function extents(arena: Arena): { min: Vec2; max: Vec2 } {
  let minX = -arena.halfWidth,
    maxX = arena.halfWidth,
    minY = -arena.halfHeight,
    maxY = arena.halfHeight;
  for (const floor of arena.floors ?? [])
    for (const path of floor.paths)
      for (const point of path) {
        const p = add(floor.position, rotate(point, floor.angle ?? 0));
        const r = floor.radius ?? 0;
        minX = Math.min(minX, p.x - r);
        maxX = Math.max(maxX, p.x + r);
        minY = Math.min(minY, p.y - r);
        maxY = Math.max(maxY, p.y + r);
      }
  if (arena.boundary) {
    const b = arena.boundary;
    minX = Math.min(minX, b.center.x - b.half.x);
    maxX = Math.max(maxX, b.center.x + b.half.x);
    minY = Math.min(minY, b.center.y - b.half.y);
    maxY = Math.max(maxY, b.center.y + b.half.y);
  }
  return { min: v(minX - 0.5, minY - 0.5), max: v(maxX + 0.5, maxY + 0.5) };
}

export function mapFeatures(arena: Arena): MapFeatures {
  const mechanisms = [...new Set((arena.environment?.mechanisms ?? []).map((m) => m.kind))].sort();
  const floorKinds = [...new Set((arena.floors ?? []).map((f) => f.kind))]
    .filter((k) => k !== 'ground')
    .sort();
  const plants = (arena.environment?.mechanisms ?? []).filter((m) => m.kind === 'plant').length;
  return {
    hazard: arena.hazard ?? (arena.floors ? 'water' : 'none'),
    pits: arena.pits.length,
    portals: arena.portals?.length ?? 0,
    mechanisms: mechanisms.filter((kind) => kind !== 'plant'),
    floorKinds,
    surfaceKinds: [...new Set((arena.surfaces ?? []).map((s) => s.kind))].sort(),
    plants,
    obstacles: arena.obstacles.length,
  };
}

export function auditMap(id: MapId): StaticAudit {
  const arena = createArena(id);
  const boundary = createBoundary(arena);
  const { min, max } = extents(arena);
  const cols = Math.ceil((max.x - min.x) / AUDIT_CELL),
    rows = Math.ceil((max.y - min.y) / AUDIT_CELL);
  const cell = (i: number, j: number) =>
    v(min.x + (i + 0.5) * AUDIT_CELL, min.y + (j + 0.5) * AUDIT_CELL);
  const index = (p: Vec2) => {
    const i = Math.floor((p.x - min.x) / AUDIT_CELL),
      j = Math.floor((p.y - min.y) / AUDIT_CELL);
    return i >= 0 && j >= 0 && i < cols && j < rows ? j * cols + i : -1;
  };
  const walkable = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const p = cell(i, j);
      walkable[j * cols + i] = safePosition(arena, p, R) && !hazardKind(arena, p) ? 1 : 0;
    }
  // Nearest walkable cell to a point (spawns sit exactly on cell borders sometimes).
  const near = (p: Vec2): number => {
    const k = index(p);
    if (k >= 0 && walkable[k]) return k;
    for (let r = 1; r <= 3; r++)
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          const q = index(v(p.x + di * AUDIT_CELL, p.y + dj * AUDIT_CELL));
          if (q >= 0 && walkable[q]) return q;
        }
    return -1;
  };
  // Flood fill from every spawn; portals link their two ends.
  const links = new Map<number, number[]>();
  for (const portal of arena.portals ?? []) {
    const exit = arena.portals!.find((p) => p.id === portal.exitId);
    if (!exit) continue;
    const a = near(portal.position),
      b = near(exit.position);
    if (a >= 0 && b >= 0) links.set(a, [...(links.get(a) ?? []), b]);
  }
  const component = new Int32Array(cols * rows).fill(-1);
  const fill = (start: number, label: number) => {
    const stack = [start];
    component[start] = label;
    while (stack.length) {
      const k = stack.pop()!,
        i = k % cols,
        j = (k - i) / cols;
      const next = [
        i > 0 ? k - 1 : -1,
        i < cols - 1 ? k + 1 : -1,
        j > 0 ? k - cols : -1,
        j < rows - 1 ? k + cols : -1,
        ...(links.get(k) ?? []),
      ];
      for (const n of next)
        if (n >= 0 && walkable[n] && component[n] < 0) {
          component[n] = label;
          stack.push(n);
        }
    }
  };
  const spawnCells = arena.spawns.map(near);
  spawnCells.forEach((k, label) => {
    if (k >= 0 && component[k] < 0) fill(k, label);
  });
  const main = spawnCells[0] >= 0 ? component[spawnCells[0]] : -1;
  const frame = arenaCameraFrame(arena);
  const cellArea = (AUDIT_CELL / U) ** 2;
  let walkableCells = 0,
    reachableCells = 0,
    outsideBoundary = 0,
    outsideCamera = 0;
  for (let k = 0; k < walkable.length; k++) {
    if (!walkable[k]) continue;
    walkableCells++;
    if (component[k] < 0) continue;
    reachableCells++;
    const p = cell(k % cols, Math.floor(k / cols));
    if (!isInBoundary(boundary, p)) outsideBoundary++;
    if (
      Math.abs(p.x - frame.center.x) > frame.half.x ||
      Math.abs(p.y - frame.center.y) > frame.half.y
    )
      outsideCamera++;
  }
  const findings: Finding[] = [];
  const features = mapFeatures(arena);
  const dynamic = features.mechanisms.some((kind) =>
    ['movingFloor', 'movingObstacle', 'fallingFloor', 'door', 'trapFloor', 'switch'].includes(kind),
  );
  const tutorial = mapInfo(id).tutorial;
  arena.spawns.forEach((p, i) => {
    const problems = pointProblems(arena, boundary, p);
    if (problems.length)
      findings.push({
        level: 'error',
        code: 'spawn',
        message: `出生点 ${i + 1}：${problems.join('、')}`,
      });
    else if (spawnCells[i] >= 0 && main >= 0 && component[spawnCells[i]] !== main)
      findings.push(
        i >= PLAYER_SLOTS
          ? {
              level: 'info',
              code: 'spawn-isolated',
              message: `出生点 ${i + 1} 与出生点 1 不连通（网页版最多 ${PLAYER_SLOTS} 人，用不到这个点）`,
            }
          : dynamic || tutorial
            ? {
                level: 'info',
                code: 'spawn-isolated',
                message: `开局时出生点 ${i + 1} 与出生点 1 不连通（${tutorial ? '教程分区' : '靠机关连通'}）`,
              }
            : {
                level: 'error',
                code: 'spawn-isolated',
                message: `出生点 ${i + 1} 与出生点 1 不连通`,
              },
      );
  });
  arena.pickupSpawns.forEach((p, i) => {
    const problems = pointProblems(arena, boundary, p);
    if (problems.length)
      findings.push({
        level: 'warning',
        code: 'pickup',
        message: `道具点 ${i + 1}：${problems.join('、')}`,
      });
  });
  let minSpawn = Infinity;
  const used = Math.min(PLAYER_SLOTS, arena.spawns.length);
  for (let a = 0; a < used; a++)
    for (let b = a + 1; b < used; b++)
      minSpawn = Math.min(
        minSpawn,
        Math.hypot(arena.spawns[a].x - arena.spawns[b].x, arena.spawns[a].y - arena.spawns[b].y) /
          U,
      );
  if (minSpawn < 4)
    findings.push({
      level: 'warning',
      code: 'spawn-close',
      message: `最近的两个出生点只相距 ${minSpawn.toFixed(1)}`,
    });
  const outsideBoundaryArea = outsideBoundary * cellArea,
    outsideCameraArea = outsideCamera * cellArea;
  if (!arena.boundary?.allowOutside && outsideBoundaryArea >= 4)
    findings.push({
      level: 'info',
      code: 'outside-boundary',
      message: `边界外有约 ${outsideBoundaryArea.toFixed(0)} 平方单位可走地面，走进去会触发出界计时`,
    });
  if (
    outsideCameraArea >= 4 &&
    !arena.floors?.some(
      (f) => f.kind === 'ground' && f.paths.flat().some((p) => Math.abs(p.x) > 40),
    )
  )
    findings.push({
      level: 'info',
      code: 'outside-camera',
      message: `约 ${outsideCameraArea.toFixed(0)} 平方单位可走地面在镜头取景外`,
    });
  if (dynamic)
    findings.push({
      level: 'info',
      code: 'dynamic',
      message: '含移动/掉落机关：静态检查只看开局状态',
    });
  return {
    id,
    walkableArea: walkableCells * cellArea,
    reachableArea: reachableCells * cellArea,
    outsideBoundaryArea,
    outsideCameraArea,
    minSpawnDistance: Number.isFinite(minSpawn) ? minSpawn : 0,
    frame: { width: (frame.half.x * 2) / U, height: (frame.half.y * 2) / U },
    spawns: arena.spawns.length,
    pickupSpawns: arena.pickupSpawns.length,
    features,
    findings,
  };
}

export interface BotAudit {
  id: MapId;
  rounds: number;
  meanSeconds: number;
  /** Rounds decided by an opponent's kill, by a self-inflicted death, or not at all. */
  kills: number;
  selfKills: number;
  draws: number;
  /** Rounds that reached the shrinking (sudden death) boundary. */
  suddenDeath: number;
  causes: Record<string, number>;
  /** Seconds per round a living bot spent stuck (moving < 0.4 Unity units in 3 s). */
  stuckSeconds: number;
}

/** Two built-in hard bots play `rounds` rounds on one map; layout pain shows up as stalls and self-kills. */
export function botAudit(id: MapId, rounds = 6, seed = 7): BotAudit {
  return runBots(id, rounds, seed);
}

function runBots(id: MapId, rounds: number, seed: number): BotAudit {
  const game = new Game({
    ...defaultOptions(),
    mode: 'bots',
    bots: 2,
    difficulty: 'hard',
    seed,
    mapId: id,
    mapRotation: 'fixed',
    scoring: 'kills',
    scoreGoal: 999,
  });
  const state = game.state;
  const driver = new BotDriver(seed);
  const causes: Record<string, number> = {};
  let played = 0,
    kills = 0,
    selfKills = 0,
    draws = 0,
    suddenDeath = 0,
    totalSeconds = 0,
    stuck = 0,
    roundStart = 0,
    shrinkSeen = false,
    scores = state.actors.map((a) => a.score),
    phase = state.phase;
  const window = Math.round(3 / RULES.dt);
  const history = new Map<number, Vec2[]>();
  for (let tick = 0; played < rounds && tick < rounds * 160 * 60; tick++) {
    const commands = new Map<number, Command>();
    for (const actor of state.actors) commands.set(actor.id, driver.command(state, actor));
    game.step(commands);
    const events = game.drainEvents();
    driver.observe(events);
    for (const event of events)
      if (event.type === 'death')
        causes[event.cause ?? event.variant ?? 'unknown'] =
          (causes[event.cause ?? event.variant ?? 'unknown'] ?? 0) + 1;
    if (state.phase === 'playing') {
      if (phase !== 'playing') roundStart = state.time;
      if (state.boundary.phase === 'shrinking') shrinkSeen = true;
      for (const actor of state.actors) {
        if (!actor.alive || actor.fall || (actor.frozenTime ?? 0) > 0) {
          history.delete(actor.id);
          continue;
        }
        const trail = history.get(actor.id) ?? [];
        trail.push({ ...actor.position });
        if (trail.length > window) trail.shift();
        history.set(actor.id, trail);
        if (
          trail.length === window &&
          Math.hypot(trail[0].x - actor.position.x, trail[0].y - actor.position.y) / U < 0.4
        )
          stuck += RULES.dt;
      }
    }
    if ((state.phase === 'roundEnd' || state.phase === 'matchEnd') && phase === 'playing') {
      played++;
      totalSeconds += state.time - roundStart;
      if (shrinkSeen) suddenDeath++;
      shrinkSeen = false;
      history.clear();
      const next = state.actors.map((a) => a.score);
      const gained = next.some((s, i) => s > scores[i]),
        lost = next.some((s, i) => s < scores[i]);
      if (gained) kills++;
      else if (lost) selfKills++;
      else draws++;
      scores = next;
    }
    phase = state.phase;
  }
  return {
    id,
    rounds: played,
    meanSeconds: played ? totalSeconds / played : 0,
    kills,
    selfKills,
    draws,
    suddenDeath,
    causes,
    stuckSeconds: played ? stuck / played : 0,
  };
}
