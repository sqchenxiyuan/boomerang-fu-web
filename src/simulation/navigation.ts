import { safePosition, traceObstacles } from '../core/collision';
import { distance, sub, v } from '../core/math';
import type { Vec2 } from '../core/math';
import type { Arena } from '../core/types';
import { RULES } from '../core/config';

export interface NavigationWaypoint extends Vec2 {
  /** This edge must be traversed by entering a portal, never by walking across the map. */
  portalId?: string;
  viaPortal?: string;
}

const margin = RULES.playerRadius + 0.13;

export function clearPathSegment(arena: Arena, a: Vec2, b: Vec2, clearance = margin): boolean {
  if (traceObstacles(arena, a, sub(b, a), clearance)) return false;
  const count = Math.max(1, Math.ceil(distance(a, b) / 0.3));
  for (let i = 0; i <= count; i++)
    if (
      !safePosition(
        arena,
        v(a.x + ((b.x - a.x) * i) / count, a.y + ((b.y - a.y) * i) / count),
        clearance,
      )
    )
      return false;
  return true;
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

function graphFor(arena: Arena): Graph {
  const signature = `${arena.revision ?? 0}:${arena.obstacles.map((o) => Number(o.broken)).join('')}`;
  const previous = graphs.get(arena);
  if (previous?.signature === signature) return previous;
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
      if (safePosition(arena, p, margin)) addNode(p);
    }
  const gridCount = nodes.length;
  const links: { from: number; to: number; id: string }[] = [];
  for (const portal of arena.portals ?? []) {
    const exit = arena.portals!.find((p) => p.id === portal.exitId);
    if (!exit || !safePosition(arena, portal.position, margin)) continue;
    const landing = v(
      exit.position.x + exit.direction.x * (exit.radius + RULES.playerRadius + 0.08),
      exit.position.y + exit.direction.y * (exit.radius + RULES.playerRadius + 0.08),
    );
    if (!safePosition(arena, landing, margin)) continue;
    links.push({ from: addNode(portal.position), to: addNode(landing), id: portal.id });
  }
  const edges: Edge[][] = nodes.map(() => []);
  const join = (from: number, to: number): void => {
    if (from === to || !clearPathSegment(arena, nodes[from], nodes[to])) return;
    edges[from].push({ to, cost: distance(nodes[from], nodes[to]) });
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
        join(i, j);
        join(j, i);
      }
  for (const link of links) edges[link.from].push({ to: link.to, cost: 0.1, portalId: link.id });
  const graph = { signature, nodes, edges };
  graphs.set(arena, graph);
  return graph;
}

/** A* without portals, Dijkstra with shortcuts; Euclidean heuristics overestimate portal routes. */
export function findPath(arena: Arena, start: Vec2, goal: Vec2): NavigationWaypoint[] {
  const hasPortals = !!arena.portals?.length;
  if (!hasPortals && clearPathSegment(arena, start, goal)) return [{ ...goal }];
  const { nodes, edges } = graphFor(arena);
  const ordered = (point: Vec2) =>
    nodes.map((_, i) => i).sort((a, b) => distance(nodes[a], point) - distance(nodes[b], point));
  // A body can legally hug a wall more closely than the conservative grid clearance.
  // Permit a body-sized connector out to the grid so AI never loses its route at a corner.
  const first = ordered(start).find((i) =>
    clearPathSegment(arena, start, nodes[i], RULES.playerRadius),
  );
  const goalSafe = safePosition(arena, goal, margin);
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
