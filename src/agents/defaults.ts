import { ROSTER } from '../core/config';
import { LOOK_RES, VOXEL_GRID, presetDraw, voxelize, type AgentLook } from './look';

/*
 * The default roster is four atelier presets. Each look is drawn from its seed
 * the first time a character is built, then voxelised exactly like a saved agent.
 * Rendering only: names and colours come from ROSTER, so Node code never draws.
 */
const cache = new Map<number, AgentLook>();

export function defaultLook(actorId: number): AgentLook | null {
  const profile = ROSTER[actorId];
  if (!profile || typeof document === 'undefined') return null;
  const cached = cache.get(actorId);
  if (cached) return cached;
  const pad = document.createElement('canvas');
  pad.width = pad.height = LOOK_RES;
  presetDraw(pad.getContext('2d')!, LOOK_RES, profile.seed, null);
  const small = document.createElement('canvas');
  small.width = small.height = VOXEL_GRID;
  const context = small.getContext('2d', { willReadFrequently: true })!;
  context.imageSmoothingEnabled = true;
  context.drawImage(pad, 0, 0, VOXEL_GRID, VOXEL_GRID);
  const look: AgentLook = {
    v: 1,
    id: `default-${actorId}`,
    name: profile.name,
    img: '',
    bg: '#e9efe6',
    hue: profile.color,
    grid: VOXEL_GRID,
    runs: voxelize(context.getImageData(0, 0, VOXEL_GRID, VOXEL_GRID), VOXEL_GRID),
    updated: 0,
  };
  cache.set(actorId, look);
  return look;
}

const thumbnails = new Map<number, string>();
/** Small PNG of a roster preset for menus (the same drawing the 3D look uses). */
export function defaultThumbnail(actorId: number, size = 96): string {
  const profile = ROSTER[actorId];
  if (!profile || typeof document === 'undefined') return '';
  const cached = thumbnails.get(actorId);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  presetDraw(canvas.getContext('2d')!, size, profile.seed, null);
  const url = canvas.toDataURL('image/png');
  thumbnails.set(actorId, url);
  return url;
}
