import { safePosition, traceObstacles } from '../core/collision';
import { distance, dot, normalize, sub, v } from '../core/math';
import type { Vec2 } from '../core/math';
import type { Arena } from '../core/types';
import { RULES } from '../core/config';
import { portalDestination } from './portals';
import { floorContains, obstacleOverlaps } from '../core/geometry';

export interface NavigationWaypoint extends Vec2 {
  /** This edge must be traversed by entering a portal, never by walking across the map. */
  portalId?: string;
  viaPortal?: string;
}

const margin = RULES.playerRadius + 0.13;
export const threatenedFloor = (arena: Arena, point: Vec2): boolean =>
  arena.floors?.some((floor) => (floor.warning ?? 0) > 0 && floorContains(floor, point)) ?? false;
const navigable = (
  arena: Arena,
  point: Vec2,
  clearance: number,
  departing?: Set<string>,
): boolean =>
  safePosition(arena, point, clearance) &&
  !(
    arena.floors?.some(
      (floor) =>
        (floor.warning ?? 0) > 0 && !departing?.has(floor.id) && floorContains(floor, point),
    ) ?? false
  );

export function clearPathSegment(
  arena: Arena,
  a: Vec2,
  b: Vec2,
  clearance = margin,
  allowWarnings = false,
): boolean {
  if (traceObstacles(arena, a, sub(b, a), clearance)) return false;
  // A warning must prevent entering a tile, while still allowing a rider to leave it.
  const departing = allowWarnings
    ? undefined
    : new Set(
        arena.floors
          ?.filter((floor) => (floor.warning ?? 0) > 0 && floorContains(floor, a))
          .map((floor) => floor.id),
      );
  const count = Math.max(1, Math.ceil(distance(a, b) / 0.3));
  for (let i = 0; i <= count; i++)
    if (
      !(allowWarnings
        ? safePosition(
            arena,
            v(a.x + ((b.x - a.x) * i) / count, a.y + ((b.y - a.y) * i) / count),
            clearance,
          )
        : navigable(
            arena,
            v(a.x + ((b.x - a.x) * i) / count, a.y + ((b.y - a.y) * i) / count),
            clearance,
            departing,
          ))
    )
      return false;
  return true;
}

/** Leave a collapsing tile before resuming combat; only choose a supported route. */
export function findFloorEscape(arena: Arena, start: Vec2, heading = v()): Vec2 | null {
  const { nodes, edges } = graphFor(arena);
  const forward = normalize(heading);
  // Keep moving through successive pressure tiles instead of oscillating across
  // the nearest tile seam each time a newly touched tile starts its warning.
  const cost = (p: Vec2) =>
    Math.abs(distance(p, start) - 3) - dot(normalize(sub(p, start)), forward) * 2;
  // Test nearby escape lines first. Searching every distant maze cell by ray
  // is expensive and cannot turn corners; the graph search below can.
  const candidates = nodes
    .filter((p) => distance(p, start) <= 6)
    .sort((a, b) => cost(a) - cost(b))
    .slice(0, 24);
  const clearance = RULES.playerRadius + 0.25;
  const settled = (p: Vec2) => {
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      if (
        threatenedFloor(
          arena,
          v(p.x + Math.cos(angle) * clearance, p.y + Math.sin(angle) * clearance),
        )
      )
        return false;
    }
    return true;
  };
  const direct = candidates.find(
    (p) =>
      settled(p) &&
      navigable(arena, p, margin) &&
      clearPathSegment(arena, start, p, RULES.playerRadius),
  );
  if (direct) return direct;
  // A maze corner may hide every safe tile from the actor. Route through the
  // still-solid warning tiles instead of repeatedly running into the corner.
  const first = nodes
    .map((_, i) => i)
    .sort((a, b) => distance(nodes[a], start) - distance(nodes[b], start))
    .find((i) => clearPathSegment(arena, start, nodes[i], RULES.playerRadius, true));
  if (first === undefined) return null;
  const queue = [first],
    visited = new Set([first]),
    parents = new Map<number, number>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    if (
      distance(nodes[current], start) > 1.5 &&
      navigable(arena, nodes[current], margin) &&
      settled(nodes[current])
    ) {
      const route = [current];
      while (parents.has(route[0])) route.unshift(parents.get(route[0])!);
      while (
        route.length > 1 &&
        clearPathSegment(arena, start, nodes[route[1]], RULES.playerRadius, true)
      )
        route.shift();
      return nodes[route[0]];
    }
    for (const edge of edges[current])
      if (!visited.has(edge.to) && !edge.portalId) {
        visited.add(edge.to);
        parents.set(edge.to, current);
        queue.push(edge.to);
      }
  }
  return null;
}

interface Edge {
  to: number;
  cost: number;
  portalId?: string;
}
interface Graph {
  signature: string;
  nodes: Vec2[];
  edges: Edge[][];
}
const graphs = new WeakMap<Arena, Graph>();

interface StaticNavigation {
  signature: string;
  fixed: Arena;
  moving: Arena;
  points: Map<string, boolean>;
  segments: Map<string, boolean>;
}
const staticNavigation = new WeakMap<Arena, StaticNavigation>();

function staticTerrain(arena: Arena): StaticNavigation {
  if (!staticNavigation.has(arena)) {
    const mechanisms = new Map(arena.environment?.mechanisms.map((m) => [m.id, m]));
    const moves = (id?: string): boolean => {
      const mechanism = id ? mechanisms.get(id) : undefined;
      return (
        !!mechanism &&
        (['movingObstacle', 'movingFloor', 'reactiveFloor', 'door'].includes(mechanism.kind) ||
          moves(mechanism.parentId))
      );
    };
    staticNavigation.set(arena, {
      signature: '',
      fixed: { ...arena, obstacles: arena.obstacles.filter((o) => !moves(o.mechanismId)) },
      moving: { ...arena, obstacles: arena.obstacles.filter((o) => moves(o.mechanismId)) },
      points: new Map(),
      segments: new Map(),
    });
  }
  const cache = staticNavigation.get(arena)!;
  if (cache) {
    const signature =
      cache.fixed.obstacles.map((o) => `${+o.broken}${+!!o.disabled}`).join('') +
      ':' +
      // Circular support is invariant under rotation, but translating circles,
      // rotating polygons and collapsing tiles must invalidate cached support.
      (arena.floors
        ?.map((f) => `${+f.active},${f.position.x},${f.position.y},${f.radius ?? f.angle ?? 0}`)
        .join(';') ?? '');
    if (cache.signature !== signature) {
      cache.signature = signature;
      cache.points.clear();
      cache.segments.clear();
    }
  }
  return cache;
}

function graphFor(arena: Arena): Graph {
  const signature = `${arena.revision ?? 0}:${arena.obstacles.map((o) => Number(o.broken)).join('')}`;
  const previous = graphs.get(arena);
  if (previous?.signature === signature) return previous;
  const terrain = staticTerrain(arena);
  const sampled = new Map<string, boolean>();
  const safeNode = (point: Vec2): boolean => {
    const key = `${point.x},${point.y}`;
    const saved = sampled.get(key);
    if (saved !== undefined) return saved;
    let safe: boolean;
    if (terrain) {
      let fixedSafe = terrain.points.get(key);
      if (fixedSafe === undefined) {
        fixedSafe = safePosition(terrain.fixed, point, margin);
        terrain.points.set(key, fixedSafe);
      }
      safe =
        fixedSafe &&
        !terrain.moving.obstacles.some(
          (o) => !o.disabled && !o.broken && obstacleOverlaps(o, point, margin),
        );
    } else safe = safePosition(arena, point, margin);
    sampled.set(key, safe);
    return safe;
  };
  const nodes: Vec2[] = [],
    indices = new Map<string, number>();
  const key = (p: Vec2) => `${p.x},${p.y}`;
  const addNode = (p: Vec2): number => {
    const existing = indices.get(key(p));
    if (existing !== undefined) return existing;
    const id = nodes.length;
    nodes.push({ ...p });
    indices.set(key(p), id);
    return id;
  };
  for (let x = Math.ceil(-arena.halfWidth + margin); x <= arena.halfWidth - margin; x++)
    for (let y = Math.ceil(-arena.halfHeight + margin); y <= arena.halfHeight - margin; y++) {
      const p = v(x, y);
      if (safeNode(p)) addNode(p);
    }
  const gridCount = nodes.length;
  const links: { from: number; to: number; id: string }[] = [];
  for (const portal of arena.portals ?? []) {
    const exit = arena.portals!.find((p) => p.id === portal.exitId);
    if (!exit || portal.safeForAI === false || !navigable(arena, portal.position, margin)) continue;
    const landing = portalDestination(arena, portal, RULES.playerRadius);
    if (!landing || !navigable(arena, landing, margin)) continue;
    links.push({ from: addNode(portal.position), to: addNode(landing), id: portal.id });
  }
  const edges: Edge[][] = nodes.map(() => []);
  const join = (from: number, to: number): void => {
    if (from >= to) return;
    const a = nodes[from],
      b = nodes[to];
    if (terrain) {
      const segmentKey = `${a.x},${a.y}:${b.x},${b.y}`;
      let fixedClear = terrain.segments.get(segmentKey);
      if (fixedClear === undefined) {
        fixedClear = clearPathSegment(terrain.fixed, a, b, margin, true);
        terrain.segments.set(segmentKey, fixedClear);
      }
      if (!fixedClear || traceObstacles(terrain.moving, a, sub(b, a), margin)) return;
    } else if (!clearPathSegment(arena, a, b, margin, true)) return;
    const cost = distance(a, b);
    edges[from].push({ to, cost });
    edges[to].push({ to: from, cost });
  };
  for (let i = 0; i < gridCount; i++) {
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const next = indices.get(key(v(nodes[i].x + dx, nodes[i].y + dy)));
        if (next !== undefined) join(i, next);
      }
  }
  for (let i = gridCount; i < nodes.length; i++)
    for (let j = 0; j < nodes.length; j++)
      if (distance(nodes[i], nodes[j]) <= 1.8) {
        if (j < gridCount) join(j, i);
        else if (j > i) join(i, j);
      }
  for (const link of links) edges[link.from].push({ to: link.to, cost: 0.1, portalId: link.id });
  const graph = { signature, nodes, edges };
  graphs.set(arena, graph);
  return graph;
}

/** A* without portals, Dijkstra with shortcuts; Euclidean heuristics overestimate portal routes. */
export function findPath(arena: Arena, start: Vec2, goal: Vec2): NavigationWaypoint[] {
  const hasPortals = !!arena.portals?.length;
  const hasWarnings = arena.floors?.some((floor) => (floor.warning ?? 0) > 0) ?? false;
  if (!hasPortals && clearPathSegment(arena, start, goal)) return [{ ...goal }];
  const { nodes, edges } = graphFor(arena);
  const ordered = (point: Vec2) =>
    nodes.map((_, i) => i).sort((a, b) => distance(nodes[a], point) - distance(nodes[b], point));
  // A body can legally hug a wall more closely than the conservative grid clearance.
  // Permit a body-sized connector out to the grid so AI never loses its route at a corner.
  const first = ordered(start).find((i) =>
    clearPathSegment(arena, start, nodes[i], RULES.playerRadius),
  );
  const goalSafe = navigable(arena, goal, margin);
  const last = ordered(goal).find((i) => !goalSafe || clearPathSegment(arena, nodes[i], goal));
  if (first === undefined || last === undefined) return [];
  const open = new Set<number>([first]),
    closed = new Set<number>();
  const score = new Map<number, number>([[first, 0]]);
  const parents = new Map<number, { from: number; portalId?: string }>();
  const heuristic = (i: number): number => (hasPortals ? 0 : distance(nodes[i], nodes[last]));
  while (open.size) {
    let current = -1,
      best = Infinity;
    for (const i of open) {
      const candidate = score.get(i)! + heuristic(i);
      if (candidate < best) {
        current = i;
        best = candidate;
      }
    }
    open.delete(current);
    if (current === last) {
      const path: NavigationWaypoint[] = [{ ...nodes[last] }];
      let cursor = last;
      while (parents.has(cursor)) {
        const parent = parents.get(cursor)!;
        const point: NavigationWaypoint = { ...nodes[parent.from] };
        if (parent.portalId) {
          point.portalId = parent.portalId;
          path[0].viaPortal = parent.portalId;
        }
        path.unshift(point);
        cursor = parent.from;
      }
      if (goalSafe && distance(path[path.length - 1], goal) > 0.05) path.push({ ...goal });
      // Smooth only the first ordinary walking section. Never flatten a portal edge.
      while (
        path.length > 1 &&
        !path[0].portalId &&
        !path[1].viaPortal &&
        clearPathSegment(arena, start, path[1])
      )
        path.shift();
      return path;
    }
    closed.add(current);
    for (const edge of edges[current]) {
      if (closed.has(edge.to)) continue;
      if (hasWarnings && threatenedFloor(arena, nodes[edge.to])) continue;
      if (hasWarnings && !edge.portalId && !clearPathSegment(arena, nodes[current], nodes[edge.to]))
        continue;
      const nextScore = score.get(current)! + edge.cost;
      if (nextScore < (score.get(edge.to) ?? Infinity)) {
        score.set(edge.to, nextScore);
        parents.set(edge.to, { from: current, portalId: edge.portalId });
        open.add(edge.to);
      }
    }
  }
  return [];
}

/** Advance after an actual teleport as well as normal walking. A portal cannot be skipped early. */
export function advancePath(path: NavigationWaypoint[], position: Vec2): void {
  while (path.length > 1) {
    if (path[0].portalId) {
      if (path[1].viaPortal === path[0].portalId && distance(position, path[1]) < 1.8) path.shift();
      else return;
    } else if (distance(position, path[0]) < 0.6) path.shift();
    else return;
  }
}
