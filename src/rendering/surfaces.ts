import * as THREE from 'three';
import type { Arena, Floor, Obstacle } from '../core/types';
import type { Vec2 } from '../core/math';
import { obstaclePaths } from '../core/geometry';

/*
 * Ground and water surface detail. Everything is procedural and computed in the
 * shader from world (or local) coordinates, so no image assets are involved and
 * the look is the same for every seed and replay. Only presentation changes:
 * the simulation never reads any of this.
 */

export type GroundKind = 'grass' | 'wood' | 'ice' | 'stone' | 'sand';
const KIND_CODE: Record<GroundKind, number> = { grass: 0, wood: 1, ice: 2, stone: 3, sand: 4 };

export interface GroundSurface {
  kind: GroundKind;
  part: 'top' | 'side';
  /** Colour of the turf lip along the top of a side wall; omitted = no lip. */
  lip?: string;
}

/** Shared by every surface material: voxel edge in pixel style (0 = smooth) and the clock. */
export const surfaceUniforms = {
  uSurfPixel: { value: 0 },
  uSurfTime: { value: 0 },
};

/** Pixel style quantises the patterns to the voxel grid; 0 restores the smooth look. */
export function setSurfacePixel(size: number): void {
  surfaceUniforms.uSurfPixel.value = size;
}

/** Water animation follows simulation time, so replays and seeks look identical. */
export function setSurfaceTime(time: number): void {
  surfaceUniforms.uSurfTime.value = time;
}

const COMMON = /* glsl */ `
varying vec3 vSurfWorld;
varying vec3 vSurfLocal;
uniform float uSurfPixel;
uniform float uSurfTime;
float sHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float sNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x),
             mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Cellular pattern: x = gap between the two nearest seeds (0 on a border), y = cell hash.
vec2 sCells(vec2 p) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  float id = 0.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + vec2(sHash(n + g), sHash(n + g + 19.7)) * 0.8 + 0.1 - f;
      float d = dot(r, r);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        id = sHash(n + g + 3.3);
      } else if (d < d2) {
        d2 = d;
      }
    }
  return vec2(sqrt(d2) - sqrt(d1), id);
}
`;

const VERTEX_DECL = /* glsl */ `
varying vec3 vSurfWorld;
varying vec3 vSurfLocal;
`;

const VERTEX_BODY = /* glsl */ `
#include <project_vertex>
{
  vec4 surfWorld = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    surfWorld = instanceMatrix * surfWorld;
  #endif
  vSurfWorld = (modelMatrix * surfWorld).xyz;
  vSurfLocal = transformed;
}
`;

const GROUND_FRAGMENT = /* glsl */ `
#include <color_fragment>
{
  float px = uSurfPixel;
  vec3 wp = vSurfWorld;
  vec3 lp = vSurfLocal;
  if (px > 0.0) {
    wp = (floor(wp / px) + 0.5) * px;
    lp = (floor(lp / px) + 0.5) * px;
  }
  // Hair-line details only exist in the smooth style; voxels carry their own speckle.
  float fineK = 1.0 - step(0.0001, px);
  vec2 p = wp.xz;
  float n1 = sNoise(p * 0.32);
  float n2 = sNoise(p * 1.2 + 17.3);
  vec3 c = diffuseColor.rgb;
  if (uSurfPart < 0.5) {
    float n3 = sNoise(p * 5.0 + 3.1);
    float tone = 1.0 + (n1 - 0.5) * 0.2 + (n2 - 0.5) * 0.1 + (n3 - 0.5) * 0.06 * fineK;
    if (uSurfKind < 0.5) {
      // Grass: broad sunlit patches and a sprinkle of light and dark blades.
      c *= tone;
      c = mix(c, c * vec3(1.08, 1.05, 0.86), smoothstep(0.56, 0.8, n1) * 0.6);
      vec2 g = p / 0.24;
      vec2 cell = floor(g);
      vec2 offset = vec2(sHash(cell + 7.0), sHash(cell + 13.0)) - 0.5;
      float h = sHash(cell + 41.0);
      float blade = (1.0 - smoothstep(0.18, 0.3, length(fract(g) - 0.5 - offset * 0.4)))
        * step(0.84, h) * fineK;
      c *= 1.0 + blade * (h > 0.93 ? 0.12 : -0.1);
    } else if (uSurfKind < 1.5) {
      // Wood: planks along local x, staggered end joints, grain and seams.
      float u = lp.z / 0.3;
      float id = floor(u);
      float fu = fract(u);
      float along = lp.x + sHash(vec2(id, 3.0)) * 4.0;
      float seg = floor(along / 2.4);
      float fa = fract(along / 2.4) * 2.4;
      float plank = sHash(vec2(id, seg) + 5.0);
      float seam = smoothstep(0.0, 0.08, fu) * smoothstep(1.0, 0.92, fu)
        * smoothstep(0.0, 0.03, fa) * smoothstep(2.4, 2.37, fa);
      float grain = sNoise(vec2(lp.x * 1.1, lp.z * 18.0) + id * 7.0);
      c *= (0.9 + plank * 0.2) * (0.95 + grain * 0.1 * fineK) * mix(1.0, 0.7 + 0.3 * seam, fineK);
    } else if (uSurfKind < 2.5) {
      // Ice: long glints and pale hairline cracks.
      c *= 1.0 + (n2 - 0.5) * 0.08;
      float glint = sNoise(vec2(dot(p, vec2(0.8, 0.6)) * 0.7, dot(p, vec2(-0.6, 0.8)) * 6.0));
      c += smoothstep(0.68, 0.9, glint) * 0.12;
      float crack = 1.0 - smoothstep(0.0, 0.025, abs(n2 - 0.5));
      c = mix(c, vec3(0.93, 0.98, 1.0), crack * 0.45 * fineK);
    } else if (uSurfKind < 3.5) {
      // Stone: irregular flagstones, each with its own shade, and soft grout lines.
      vec2 stones = sCells(p / 0.85);
      c *= (1.0 + (n1 - 0.5) * 0.12 + (n3 - 0.5) * 0.05 * fineK) * (0.93 + stones.y * 0.14);
      c *= 1.0 - (1.0 - smoothstep(0.04, 0.11, stones.x)) * 0.14 * fineK;
    } else {
      // Sand: soft dunes and wind ripples.
      c *= 1.0 + (n1 - 0.5) * 0.12 + (n2 - 0.5) * 0.06 + (n3 - 0.5) * 0.05 * fineK;
      c *= 1.0 + sin(dot(p, vec2(0.6, 0.8)) * 7.0 + n2 * 6.0) * 0.025 * fineK;
    }
  } else {
    // Side wall: a turf lip on top, darker towards the water, faint strata.
    float y = wp.y;
    c *= mix(1.05, 0.7, clamp(-y / 0.65, 0.0, 1.0));
    c *= 0.94 + sNoise(vec2((wp.x + wp.z) * 0.5, y * 7.0)) * 0.12;
    c = mix(c, uSurfLip, smoothstep(-0.095, -0.065, y) * uSurfLipOn);
  }
  diffuseColor.rgb = c;
}
`;

/**
 * Ground material with procedural detail. A subclass (not an onBeforeCompile
 * property) so clones, voxel twins and tinted copies keep the detail; every
 * instance shares one compiled program and differs only in uniforms.
 */
export class GroundMaterial extends THREE.MeshStandardMaterial {
  constructor(parameters?: THREE.MeshStandardMaterialParameters, surface?: GroundSurface) {
    super(parameters);
    if (surface) this.userData.surface = surface;
  }

  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms): void {
    const surface = (this.userData.surface ?? { kind: 'grass', part: 'top' }) as GroundSurface;
    shader.uniforms.uSurfPixel = surfaceUniforms.uSurfPixel;
    shader.uniforms.uSurfTime = surfaceUniforms.uSurfTime;
    shader.uniforms.uSurfKind = { value: KIND_CODE[surface.kind] };
    shader.uniforms.uSurfPart = { value: surface.part === 'side' ? 1 : 0 };
    shader.uniforms.uSurfLip = { value: new THREE.Color(surface.lip ?? '#000000') };
    shader.uniforms.uSurfLipOn = { value: surface.lip ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <project_vertex>', VERTEX_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${COMMON}\nuniform float uSurfKind;\nuniform float uSurfPart;\nuniform vec3 uSurfLip;\nuniform float uSurfLipOn;`,
      )
      .replace('#include <color_fragment>', GROUND_FRAGMENT);
  }

  override customProgramCacheKey(): string {
    return 'surface-ground-1';
  }
}

const groundCache = new Map<string, GroundMaterial>();
/** Shared (never disposed by a view), like `palette.material`. */
export function groundMaterial(color: string, surface: GroundSurface): GroundMaterial {
  const key = `${color}:${surface.kind}:${surface.part}:${surface.lip ?? ''}`;
  let cached = groundCache.get(key);
  if (!cached) {
    cached = new GroundMaterial(
      { color, roughness: surface.kind === 'ice' ? 0.42 : 0.88, flatShading: true },
      surface,
    );
    cached.userData.shared = true;
    groundCache.set(key, cached);
  }
  return cached;
}

/** Signed distances are stored as bytes over this range (world units). */
const SHORE_MIN = -1,
  SHORE_RANGE = 8;

const WATER_FRAGMENT = /* glsl */ `
#include <color_fragment>
float waterFoam = 0.0;
vec3 waterTilt = vec3(0.0);
{
  float px = uSurfPixel;
  vec2 p = vSurfWorld.xz;
  if (px > 0.0) p = (floor(p / px) + 0.5) * px;
  float fineK = 1.0 - step(0.0001, px);
  float t = uSurfTime;
  // Distance to the nearest shore: positive over open water.
  float d = 9.0;
  if (uShoreOn > 0.5) {
    vec2 uv = (p - uShoreBox.xy) / uShoreBox.zw;
    if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0)
      d = texture2D(uShore, uv).r * ${SHORE_RANGE.toFixed(1)} + (${SHORE_MIN.toFixed(1)});
  }
  vec3 base = diffuseColor.rgb;
  float shallow = 1.0 - smoothstep(0.0, 3.0, d);
  vec3 c = mix(base * vec3(0.74, 0.88, 1.0), mix(base, vec3(0.6, 0.9, 0.84), 0.12) * 1.02, shallow);
  // Two drifting ripple layers and a few sun sparkles.
  vec2 q1 = p * 0.85 + vec2(t * 0.11, t * 0.04);
  vec2 q2 = p * 1.6 + vec2(-t * 0.08, t * 0.1) + 11.0;
  float r1 = sNoise(q1);
  float r = (r1 + sNoise(q2)) * 0.5;
  // Soft light and dark swells (banded in pixel style); thin iso-lines read as worms.
  float swell = px > 0.0 ? floor(r * 4.0) / 3.0 - 0.5 : r - 0.5;
  c *= 1.0 + swell * 0.12;
  float spark = sNoise(p * 3.6 + vec2(t * 0.5, -t * 0.3));
  c += (px > 0.0 ? step(0.93, spark) : smoothstep(0.9, 0.97, spark)) * 0.07;
  // Shore foam: a broken band hugging the land and one wave rolling outwards.
  float fn = sNoise(p * 2.3 + vec2(t * 0.2, 0.0));
  float hug = 1.0 - smoothstep(0.04, 0.12 + fn * 0.1, d);
  float phase = fract(t * 0.18);
  float fade = (1.0 - phase) * (1.0 - phase);
  float wave = (1.0 - smoothstep(0.0, 0.05 + 0.03 * fn, abs(d - 0.14 - phase * 0.7 + (fn - 0.5) * 0.12)))
    * fade * step(0.35, fn);
  waterFoam = clamp(max(hug, wave * 0.65), 0.0, 1.0) * step(-0.05, d) * uShoreOn;
  if (px > 0.0) waterFoam = step(0.45, waterFoam);
  c = mix(c, vec3(0.95, 0.99, 1.0), waterFoam * 0.92);
  diffuseColor.rgb = c;
  float gx = sNoise(q1 + vec2(0.35, 0.0)) - r1;
  float gz = sNoise(q1 + vec2(0.0, 0.35)) - r1;
  waterTilt = vec3(-gx, 0.0, -gz) * 0.12 * fineK * (1.0 - waterFoam);
}
`;

/** Water plane with depth tint, drifting ripples, sparkles and shore foam. */
export class WaterMaterial extends THREE.MeshStandardMaterial {
  readonly shore: { texture: THREE.DataTexture | null; box: THREE.Vector4 } = {
    texture: null,
    box: new THREE.Vector4(0, 0, 1, 1),
  };

  constructor(parameters?: THREE.MeshStandardMaterialParameters) {
    super(parameters);
    this.addEventListener('dispose', () => this.shore.texture?.dispose());
  }

  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms): void {
    shader.uniforms.uSurfPixel = surfaceUniforms.uSurfPixel;
    shader.uniforms.uSurfTime = surfaceUniforms.uSurfTime;
    shader.uniforms.uShore = { value: this.shore.texture };
    shader.uniforms.uShoreBox = { value: this.shore.box };
    shader.uniforms.uShoreOn = { value: this.shore.texture ? 1 : 0 };
    this.userData.uniforms = shader.uniforms;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <project_vertex>', VERTEX_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${COMMON}\nuniform sampler2D uShore;\nuniform vec4 uShoreBox;\nuniform float uShoreOn;`,
      )
      .replace('#include <color_fragment>', WATER_FRAGMENT)
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.85, waterFoam);',
      )
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\nnormal = normalize(normal + (viewMatrix * vec4(waterTilt, 0.0)).xyz);',
      );
  }

  override customProgramCacheKey(): string {
    return 'surface-water-1';
  }

  /** Install (or refresh) the shore distance field. */
  setShore(grid: ShoreGrid | null): void {
    if (!grid) return;
    const bytes = new Uint8Array(grid.width * grid.height);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = Math.round(
        Math.max(0, Math.min(1, (grid.data[i] - SHORE_MIN) / SHORE_RANGE)) * 255,
      );
    const current = this.shore.texture;
    if (current && current.image.width === grid.width && current.image.height === grid.height) {
      (current.image.data as Uint8Array).set(bytes);
      current.needsUpdate = true;
    } else {
      current?.dispose();
      const texture = new THREE.DataTexture(
        bytes,
        grid.width,
        grid.height,
        THREE.RedFormat,
        THREE.UnsignedByteType,
      );
      texture.magFilter = texture.minFilter = THREE.LinearFilter;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      this.shore.texture = texture;
      const uniforms = this.userData.uniforms as Record<string, THREE.IUniform> | undefined;
      if (uniforms) {
        uniforms.uShore.value = texture;
        uniforms.uShoreOn.value = 1;
      }
    }
    // Texel centres sit on cell centres.
    this.shore.box.set(
      grid.minX - grid.cell / 2,
      grid.minY - grid.cell / 2,
      grid.width * grid.cell,
      grid.height * grid.cell,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Shore distance field                                                */
/* ------------------------------------------------------------------ */

export interface ShoreGrid {
  /** World x/y (Three x/z) of cell (0, 0)'s centre. */
  minX: number;
  minY: number;
  cell: number;
  width: number;
  height: number;
  /** Signed distance to the nearest shore, world units: negative on land. */
  data: Float32Array;
}

/** Floors that do not move and are standing now; foam is drawn only around these. */
export function shoreFloor(floor: Floor): boolean {
  return (
    !floor.mechanismId &&
    floor.kind !== 'moving' &&
    floor.active &&
    !((floor.fallProgress ?? 0) > 0)
  );
}

const shoreObstacle = (obstacle: Obstacle): boolean =>
  !obstacle.mechanismId && obstacle.kind !== 'crate' && !obstacle.broken && !obstacle.disabled;

/** Ids of the falling floors that are standing: the field changes when this does. */
export function shoreSignature(arena: Arena): string {
  let signature = '';
  for (const floor of arena.floors ?? [])
    if (floor.kind === 'falling' && shoreFloor(floor)) signature += `${floor.id},`;
  return signature;
}

interface Polygon {
  paths: Vec2[][];
}

function worldPaths(shape: { position: Vec2; angle?: number }, paths: Vec2[][]): Vec2[][] {
  const cos = Math.cos(shape.angle ?? 0),
    sin = Math.sin(shape.angle ?? 0);
  return paths.map((path) =>
    path.map((p) => ({
      x: shape.position.x + p.x * cos - p.y * sin,
      y: shape.position.y + p.x * sin + p.y * cos,
    })),
  );
}

function landPolygons(arena: Arena): { land: Polygon[]; extent: Polygon[] } {
  if (!arena.floors) {
    // Built-in arenas: one rectangle with pits cut out (pits are holes, even-odd).
    const x = arena.halfWidth,
      y = arena.halfHeight;
    const outer: Vec2[] = [
      { x: -x, y: -y },
      { x, y: -y },
      { x, y },
      { x: -x, y },
    ];
    const holes = arena.pits.map((pit) => [
      { x: pit.position.x - pit.half.x, y: pit.position.y - pit.half.y },
      { x: pit.position.x + pit.half.x, y: pit.position.y - pit.half.y },
      { x: pit.position.x + pit.half.x, y: pit.position.y + pit.half.y },
      { x: pit.position.x - pit.half.x, y: pit.position.y + pit.half.y },
    ]);
    const land = [{ paths: [outer, ...holes] }];
    return { land, extent: land };
  }
  const land: Polygon[] = [],
    extent: Polygon[] = [];
  for (const floor of arena.floors) {
    const polygon = { paths: worldPaths(floor, floor.paths) };
    extent.push(polygon);
    if (shoreFloor(floor)) land.push(polygon);
  }
  for (const obstacle of arena.obstacles)
    if (shoreObstacle(obstacle))
      land.push({ paths: worldPaths(obstacle, obstaclePaths(obstacle)) });
  return { land, extent };
}

/** Even-odd scanline fill of one polygon into the mask (cell centres). Each edge
 * only visits the rows it crosses, so big contours and many small obstacles stay cheap. */
function fill(mask: Uint8Array, grid: Omit<ShoreGrid, 'data'>, polygon: Polygon): void {
  let low = Infinity,
    high = -Infinity;
  for (const path of polygon.paths)
    for (const p of path) {
      low = Math.min(low, p.y);
      high = Math.max(high, p.y);
    }
  const first = Math.max(0, Math.ceil((low - grid.minY) / grid.cell));
  const last = Math.min(grid.height - 1, Math.floor((high - grid.minY) / grid.cell));
  if (first > last) return;
  const rows: number[][] = Array.from({ length: last - first + 1 }, () => []);
  for (const path of polygon.paths)
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      const a = path[j],
        b = path[i];
      if (a.y === b.y) continue;
      const y0 = Math.min(a.y, b.y),
        y1 = Math.max(a.y, b.y);
      const from = Math.max(first, Math.ceil((y0 - grid.minY) / grid.cell));
      const to = Math.min(last, Math.ceil((y1 - grid.minY) / grid.cell));
      for (let row = from; row <= to; row++) {
        const y = grid.minY + row * grid.cell;
        // Half-open crossing rule: a vertex on the scanline counts once.
        if (y < y0 || y >= y1) continue;
        rows[row - first].push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
  for (let index = 0; index < rows.length; index++) {
    const xs = rows[index];
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const row = first + index;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const start = Math.max(0, Math.ceil((xs[k] - grid.minX) / grid.cell));
      const stop = Math.min(grid.width - 1, Math.floor((xs[k + 1] - grid.minX) / grid.cell));
      for (let column = start; column <= stop; column++) mask[row * grid.width + column] = 1;
    }
  }
}

const FAR = 1e20;
/** Felzenszwalb–Huttenlocher squared distance transform, in place, in cells. */
function distanceTransform(values: Float64Array, width: number, height: number): void {
  const n = Math.max(width, height);
  const f = new Float64Array(n),
    d = new Float64Array(n),
    v = new Int32Array(n),
    z = new Float64Array(n + 1);
  const pass = (length: number): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -FAR;
    z[1] = FAR;
    for (let q = 1; q < length; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = FAR;
    }
    k = 0;
    for (let q = 0; q < length; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = values[y * width + x];
    pass(height);
    for (let y = 0; y < height; y++) values[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = values[y * width + x];
    pass(width);
    for (let x = 0; x < width; x++) values[y * width + x] = d[x];
  }
}

/** Finest cell (world units) and the largest grid side the field may use. */
const SHORE_CELL = 0.1,
  SHORE_MAX_CELLS = 384,
  SHORE_MARGIN = 4;

/**
 * Signed distance from every point of the water to the nearest standing land.
 * Bounds cover every floor (moving or not) so a refresh keeps the same grid.
 * Returns null when there is no water to decorate.
 */
export function shoreDistances(arena: Arena): ShoreGrid | null {
  if (arena.hazard === 'cliff') return null;
  const { land, extent } = landPolygons(arena);
  if (!extent.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const polygon of extent)
    for (const path of polygon.paths)
      for (const p of path) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
  if (!Number.isFinite(minX)) return null;
  minX -= SHORE_MARGIN;
  minY -= SHORE_MARGIN;
  maxX += SHORE_MARGIN;
  maxY += SHORE_MARGIN;
  const cell = Math.max(SHORE_CELL, Math.max(maxX - minX, maxY - minY) / SHORE_MAX_CELLS);
  const grid = {
    minX,
    minY,
    cell,
    width: Math.ceil((maxX - minX) / cell) + 1,
    height: Math.ceil((maxY - minY) / cell) + 1,
  };
  const mask = new Uint8Array(grid.width * grid.height);
  for (const polygon of land) fill(mask, grid, polygon);
  const outside = new Float64Array(mask.length),
    inside = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    outside[i] = mask[i] ? 0 : FAR;
    inside[i] = mask[i] ? FAR : 0;
  }
  distanceTransform(outside, grid.width, grid.height);
  distanceTransform(inside, grid.width, grid.height);
  const data = new Float32Array(mask.length);
  // The shore lies half a cell beyond the last cell centre on either side.
  for (let i = 0; i < mask.length; i++)
    data[i] = mask[i]
      ? -(Math.sqrt(Math.min(inside[i], FAR / 2)) - 0.5) * cell
      : (Math.sqrt(Math.min(outside[i], FAR / 2)) - 0.5) * cell;
  return { ...grid, data };
}

/** Sample the field at a world point (nearest cell); open water far away is +Infinity. */
export function shoreDistanceAt(grid: ShoreGrid, point: Vec2): number {
  const column = Math.round((point.x - grid.minX) / grid.cell),
    row = Math.round((point.y - grid.minY) / grid.cell);
  if (column < 0 || row < 0 || column >= grid.width || row >= grid.height) return Infinity;
  return grid.data[row * grid.width + column];
}
