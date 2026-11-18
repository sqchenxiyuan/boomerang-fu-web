import { add, rotate, type Vec2 } from '../core/math';
import type { Arena } from '../core/types';
import { arenaCameraFrame } from '../rendering/arena-camera';

/*
 * Top-down map schematic for the map gallery: terrain, hazards, walls, plants,
 * portals, spawns, pickup points and the play boundary, framed like the game
 * camera. Screen y follows web y (toward the camera is down), as in play.
 */
export const SCHEMATIC_COLORS = {
  water: '#6fa8c4',
  cliff: '#2d3138',
  grass: '#c9de9c',
  ground: '#bdd88c',
  ice: '#d3f1ff',
  wood: '#c99a5f',
  falling: '#efbc6c',
  moving: '#b9a3e0',
  pit: '#3a3e45',
  stone: '#8b929b',
  crate: '#b5844e',
  tree: '#3f7a3a',
  bamboo: '#7dab4c',
  shrub: '#5f9a48',
  plant: '#4f9a3c',
  boundary: '#d9493a',
  spawn: '#ffffff',
  pickup: '#ffd23f',
};
export interface SchematicOptions {
  /** Draw spawn numbers and pickup points (off for tiny thumbnails). */
  markers?: boolean;
  boundary?: boolean;
}

function obstacleColor(kind: string, material = ''): string {
  const m = material.toLowerCase();
  if (m.includes('bamboo')) return SCHEMATIC_COLORS.bamboo;
  if (m.includes('tree')) return SCHEMATIC_COLORS.tree;
  if (m.includes('shrub') || m.includes('bush')) return SCHEMATIC_COLORS.shrub;
  if (kind === 'crate' || m.includes('wood') || m.includes('crate')) return SCHEMATIC_COLORS.crate;
  if (kind === 'fountain') return '#86bccb';
  return SCHEMATIC_COLORS.stone;
}

export function drawSchematic(
  ctx: CanvasRenderingContext2D,
  arena: Arena,
  width: number,
  height: number,
  options: SchematicOptions = {},
): void {
  const { markers = true, boundary = true } = options;
  const frame = arenaCameraFrame(arena);
  const pad = 1.06;
  const scale = Math.min(width / (frame.half.x * 2 * pad), height / (frame.half.y * 2 * pad));
  const toScreen = (p: Vec2): [number, number] => [
    width / 2 + (p.x - frame.center.x) * scale,
    height / 2 + (p.y - frame.center.y) * scale,
  ];
  const shape = (
    position: Vec2,
    angle: number | undefined,
    paths: Vec2[][] | undefined,
    radius?: number,
  ) => {
    ctx.beginPath();
    if (paths?.length)
      for (const path of paths)
        path.forEach((point, i) => {
          const [x, y] = toScreen(add(position, rotate(point, angle ?? 0)));
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
    else if (radius) {
      const [x, y] = toScreen(position);
      ctx.arc(x, y, radius * scale, 0, Math.PI * 2);
    }
    ctx.closePath();
  };
  const box = (position: Vec2, half: Vec2, angle = 0) => {
    ctx.beginPath();
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].forEach(([sx, sy], i) => {
      const [x, y] = toScreen(add(position, rotate({ x: sx * half.x, y: sy * half.y }, angle)));
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
  };

  // Backdrop: water or a drop around islands; plain grass for rectangle arenas.
  ctx.fillStyle = arena.floors
    ? arena.hazard === 'cliff'
      ? SCHEMATIC_COLORS.cliff
      : SCHEMATIC_COLORS.water
    : SCHEMATIC_COLORS.grass;
  ctx.fillRect(0, 0, width, height);
  if (arena.floors) {
    for (const floor of arena.floors) {
      shape(floor.position, floor.angle, floor.radius ? undefined : floor.paths, floor.radius);
      ctx.fillStyle = SCHEMATIC_COLORS[floor.kind] ?? SCHEMATIC_COLORS.ground;
      ctx.globalAlpha = floor.active ? 1 : 0.35;
      ctx.fill('evenodd');
      ctx.globalAlpha = 1;
    }
  } else {
    box({ x: 0, y: 0 }, { x: arena.halfWidth, y: arena.halfHeight });
    ctx.fillStyle = SCHEMATIC_COLORS.ground;
    ctx.fill();
  }
  for (const surface of arena.surfaces ?? []) {
    shape(
      surface.position,
      surface.angle,
      surface.radius ? undefined : surface.paths,
      surface.radius,
    );
    ctx.fillStyle = surface.kind === 'ice' ? SCHEMATIC_COLORS.ice : SCHEMATIC_COLORS.water;
    ctx.fill('evenodd');
  }
  for (const pit of arena.pits) {
    box(pit.position, pit.half);
    ctx.fillStyle = SCHEMATIC_COLORS.pit;
    ctx.fill();
  }
  for (const mechanism of arena.environment?.mechanisms ?? []) {
    if (mechanism.kind !== 'plant') continue;
    const [x, y] = toScreen(mechanism.position);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.2, 0.16 * scale), 0, Math.PI * 2);
    ctx.fillStyle = SCHEMATIC_COLORS.plant;
    ctx.fill();
  }
  for (const obstacle of arena.obstacles) {
    if (obstacle.broken || obstacle.disabled) continue;
    if (obstacle.paths?.length || obstacle.radius)
      shape(obstacle.position, obstacle.angle, obstacle.paths, obstacle.radius);
    else box(obstacle.position, obstacle.half, obstacle.angle ?? 0);
    ctx.fillStyle = obstacleColor(obstacle.kind, obstacle.material);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
  for (const portal of arena.portals ?? []) {
    const [x, y] = toScreen(portal.position);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(3, portal.radius * scale), 0, Math.PI * 2);
    ctx.strokeStyle = portal.color;
    ctx.lineWidth = Math.max(1.5, 0.08 * scale);
    ctx.stroke();
  }
  if (boundary && arena.boundary && !arena.boundary.allowOutside) {
    box(arena.boundary.center, arena.boundary.half, arena.boundary.angle);
    ctx.setLineDash([Math.max(3, scale * 0.3), Math.max(3, scale * 0.25)]);
    ctx.strokeStyle = SCHEMATIC_COLORS.boundary;
    ctx.lineWidth = Math.max(1, scale * 0.06);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (!markers) return;
  for (const point of arena.pickupSpawns) {
    const [x, y] = toScreen(point),
      r = Math.max(2.5, 0.22 * scale);
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fillStyle = SCHEMATIC_COLORS.pickup;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  arena.spawns.forEach((point, i) => {
    const [x, y] = toScreen(point),
      r = Math.max(5, 0.32 * scale);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = SCHEMATIC_COLORS.spawn;
    ctx.fill();
    ctx.strokeStyle = '#203e32';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#203e32';
    ctx.font = `700 ${Math.round(r * 1.2)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x, y + 0.5);
  });
}
