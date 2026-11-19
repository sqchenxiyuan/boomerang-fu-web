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
// Factors are chosen as they should look on screen; colour maths here is linear.
float sT(float display) {
  return pow(display, 2.2);
}
// Ordered 4x4 dither threshold in [0, 1) for an integer cell.
float sBayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}
float sBayer4(vec2 a) {
  return sBayer2(0.5 * a) * 0.25 + sBayer2(a);
}
// The voxel a fragment belongs to: faces sit exactly on cell borders, so step half
// a cell inwards along the face normal before rounding down.
vec3 sVoxel(vec3 position, float size) {
  vec3 normal = normalize(cross(dFdx(position), dFdy(position)));
  return floor((position - normal * size * 0.5) / size);
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
if (uSurfPixel > 0.0) {
  // Pixel art: every decision is made per voxel, with a few discrete tones and
  // hand-placed looking accent pixels instead of gradients.
  float px = uSurfPixel;
  vec3 voxel = sVoxel(vSurfWorld, px);
  vec3 wp = (voxel + 0.5) * px;
  vec2 cell = voxel.xz;
  vec2 p = wp.xz;
  float n1 = sNoise(p * 0.32);
  float n2 = sNoise(p * 1.2 + 17.3);
  float h = sHash(cell + 41.0);
  float pick = sHash(cell + 97.0);
  // Per-voxel speckle that never repeats (the old 16-cell shade texture tiled visibly).
  float roll = sHash(cell + voxel.y * 7.7 + 3.0);
  float speckle = roll < 0.08 ? 0.85 : (roll < 0.26 ? 0.92 : (roll > 0.92 ? 1.03 : 0.97));
  vec3 c = diffuseColor.rgb * sT(speckle);
  if (uSurfPart < 0.5) {
    // Three-tone clumps about a metre across, dithered where they meet.
    float lump = sNoise(p * 1.1 + 5.0) + (sBayer4(cell) - 0.5) * 0.16;
    float clump = sT((lump > 0.62 ? 1.06 : (lump < 0.38 ? 0.94 : 1.0)) * (1.0 + (n1 - 0.5) * 0.08));
    if (uSurfKind < 0.5) {
      // Grass: clumps, darker tufts and the odd flower.
      c *= clump;
      if (h > 0.995)
        c = pick < 0.45 ? vec3(0.91, 0.68, 0.1) : (pick < 0.8 ? vec3(0.85, 0.27, 0.37) : vec3(0.93, 0.91, 0.79));
      else if (h > 0.94) c *= sT(0.86);
    } else if (uSurfKind < 1.5) {
      // Wood: three-voxel planks with one-voxel seams and joints.
      vec3 lp = (sVoxel(vSurfLocal, px) + 0.5) * px;
      float u = lp.z / 0.3;
      float id = floor(u);
      float along = lp.x + sHash(vec2(id, 3.0)) * 4.0;
      float seg = floor(along / 2.4);
      float fa = fract(along / 2.4) * 2.4;
      c *= sT(0.93 + sHash(vec2(id, seg) + 5.0) * 0.12);
      if (fract(u) < 0.34 || fa < px) c *= sT(0.78);
      else if (h > 0.9) c *= sT(0.93);
    } else if (uSurfKind < 2.5) {
      // Ice: clumps and bright glint pixels.
      c *= clump;
      if (h > 0.97) c = mix(c, vec3(0.9, 0.97, 1.0), 0.7);
    } else if (uSurfKind < 3.5) {
      // Stone: flagstones in four shades with one-voxel grout.
      vec2 stones = sCells(p / 0.85);
      c *= sT((0.94 + floor(stones.y * 4.0) * 0.03) * (n1 > 0.62 ? 1.03 : 1.0));
      if (stones.x < 0.1) c *= sT(0.8);
      else if (h > 0.96) c *= sT(0.92);
    } else {
      // Sand: clumps, one-voxel wind ripples and pebbles.
      c *= clump;
      if (fract(dot(p, vec2(0.6, 0.8)) / 0.7 + n2 * 1.6) < 0.16) c *= sT(0.92);
      if (h > 0.985) c *= sT(0.85);
    }
  } else {
    // Side wall: a turf row with its shadow and the odd drip, then rows of earth
    // that darken towards the water, with scattered darker voxels.
    float y = wp.y;
    c *= sT(mix(1.02, 0.84, clamp(-y / 0.65, 0.0, 1.0)));
    if (sHash(cell + voxel.y * 13.1) > 0.9) c *= sT(0.92);
    if (uSurfLipOn > 0.5) {
      if (y > -px) c = uSurfLip * sT(speckle);
      else if (y > -2.0 * px) c = sHash(cell + 5.0) > 0.78 ? uSurfLip * sT(0.95) : c * sT(0.88);
    }
  }
  diffuseColor.rgb = c;
} else {
  vec3 wp = vSurfWorld;
  vec3 lp = vSurfLocal;
  vec2 p = wp.xz;
  float n1 = sNoise(p * 0.32);
  float n2 = sNoise(p * 1.2 + 17.3);
  vec3 c = diffuseColor.rgb;
  if (uSurfPart < 0.5) {
    float n3 = sNoise(p * 5.0 + 3.1);
    float tone = 1.0 + (n1 - 0.5) * 0.2 + (n2 - 0.5) * 0.1 + (n3 - 0.5) * 0.06;
    if (uSurfKind < 0.5) {
      // Grass: broad sunlit patches and a sprinkle of light and dark blades.
      c *= tone;
      c = mix(c, c * vec3(1.08, 1.05, 0.86), smoothstep(0.56, 0.8, n1) * 0.6);
      vec2 g = p / 0.24;
      vec2 cell = floor(g);
      vec2 offset = vec2(sHash(cell + 7.0), sHash(cell + 13.0)) - 0.5;
      float h = sHash(cell + 41.0);
      float blade = (1.0 - smoothstep(0.18, 0.3, length(fract(g) - 0.5 - offset * 0.4)))
        * step(0.84, h);
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
      c *= (0.9 + plank * 0.2) * (0.95 + grain * 0.1) * (0.7 + 0.3 * seam);
    } else if (uSurfKind < 2.5) {
      // Ice: long glints and pale hairline cracks.
      c *= 1.0 + (n2 - 0.5) * 0.08;
      float glint = sNoise(vec2(dot(p, vec2(0.8, 0.6)) * 0.7, dot(p, vec2(-0.6, 0.8)) * 6.0));
      c += smoothstep(0.68, 0.9, glint) * 0.12;
      float crack = 1.0 - smoothstep(0.0, 0.025, abs(n2 - 0.5));
      c = mix(c, vec3(0.93, 0.98, 1.0), crack * 0.45);
    } else if (uSurfKind < 3.5) {
      // Stone: irregular flagstones, each with its own shade, and soft grout lines.
      vec2 stones = sCells(p / 0.85);
      c *= (1.0 + (n1 - 0.5) * 0.12 + (n3 - 0.5) * 0.05) * (0.93 + stones.y * 0.14);
      c *= 1.0 - (1.0 - smoothstep(0.04, 0.11, stones.x)) * 0.14;
    } else {
      // Sand: soft dunes and wind ripples.
      c *= 1.0 + (n1 - 0.5) * 0.12 + (n2 - 0.5) * 0.06 + (n3 - 0.5) * 0.05;
      c *= 1.0 + sin(dot(p, vec2(0.6, 0.8)) * 7.0 + n2 * 6.0) * 0.025;
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
      .replace('#include <map_fragment>', 'if (uSurfPixel <= 0.0) {\n#include <map_fragment>\n}')
      .replace('#include <color_fragment>', GROUND_FRAGMENT);
  }

  override customProgramCacheKey(): string {
    return 'surface-ground-3';
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

/* ------------------------------------------------------------------ */
/* Ice overlays                                                        */
/* ------------------------------------------------------------------ */

const ICE_VERTEX_DECL = /* glsl */ `
attribute float aIceEdge;
varying float vIceEdge;
`;

const ICE_FRAGMENT = /* glsl */ `
#include <color_fragment>
{
  vec3 base = diffuseColor.rgb;
  vec2 p = vSurfWorld.xz;
  if (uSurfPixel > 0.0) {
    // Per voxel: frozen slabs in three tones, one-voxel white cracks, sparse
    // diagonal glints and a bright one-voxel rim along the edge of the ice.
    float px = uSurfPixel;
    vec2 cell = floor(p / px);
    vec2 c = (cell + 0.5) * px;
    vec2 slabs = sCells(c / 1.3);
    vec3 col = base * sT(slabs.y < 0.33 ? 0.93 : (slabs.y < 0.66 ? 1.0 : 1.05));
    col *= sHash(cell + 7.7) < 0.08 ? sT(1.07) : 1.0;
    float crack = step(slabs.x, 0.07);
    float streak = step(mod(cell.x + cell.y, 19.0), 1.0) * step(0.5, sNoise(c * 0.6));
    float rim = step(0.5, vIceEdge);
    col = mix(col, vec3(1.0), max(max(crack * 0.5, streak * 0.65), rim * 0.6));
    diffuseColor.rgb = col;
    diffuseColor.a = mix(diffuseColor.a, 0.95, max(rim, crack));
  } else {
    // Slabs with soft seams, glossy diagonal streaks and frost.
    vec2 slabs = sCells(p / 1.3);
    vec3 col = base * (0.95 + slabs.y * 0.09);
    float crack = 1.0 - smoothstep(0.02, 0.06, slabs.x);
    float band = fract((p.x + p.y) * 0.32 + sNoise(p * 0.4) * 0.35);
    float streak = smoothstep(0.0, 0.03, band) * (1.0 - smoothstep(0.05, 0.11, band));
    float frost = smoothstep(0.62, 0.9, sNoise(p * 2.2 + 4.0));
    col = mix(col, vec3(1.0), clamp(crack * 0.45 + streak * 0.4 + frost * 0.18, 0.0, 1.0));
    diffuseColor.rgb = col;
    diffuseColor.a = mix(diffuseColor.a, 0.9, crack * 0.6 + streak * 0.3);
  }
}
`;

/** Slippery ice laid over the ground: slabs, cracks and glints; per voxel in the pixel style. */
export class IceMaterial extends THREE.MeshStandardMaterial {
  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms): void {
    shader.uniforms.uSurfPixel = surfaceUniforms.uSurfPixel;
    shader.uniforms.uSurfTime = surfaceUniforms.uSurfTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}\n${ICE_VERTEX_DECL}`)
      .replace('#include <project_vertex>', `${VERTEX_BODY}\nvIceEdge = aIceEdge;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON}\nvarying float vIceEdge;`)
      .replace('#include <color_fragment>', ICE_FRAGMENT);
  }

  override customProgramCacheKey(): string {
    return 'surface-ice-1';
  }
}

/** Ice colour and the overlay material; geometry needs an `aIceEdge` attribute. */
export function iceMaterial(): IceMaterial {
  return new IceMaterial({
    // Opaque enough to stay blue over yellow-green grass instead of turning mint.
    color: '#a6d9f2',
    roughness: 0.12,
    metalness: 0.05,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
  });
}

/** Mark every vertex as interior (the smooth style has no voxel rim). */
export function withIceEdge(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.setAttribute(
    'aIceEdge',
    new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count), 1),
  );
  return geometry;
}

/**
 * Pixel style: replace a flat overlay with whole cells of the world voxel grid
 * whose centres it covers, so its outline steps like the voxel ground under
 * it. Cells on the border carry `aIceEdge = 1`. Returns geometry in the mesh's
 * own frame, or null when nothing is covered.
 */
export function pixelOverlayGeometry(mesh: THREE.Mesh, cell: number): THREE.BufferGeometry | null {
  mesh.updateWorldMatrix(true, false);
  const source = mesh.geometry as THREE.BufferGeometry;
  const position = source.getAttribute('position');
  const index = source.getIndex();
  const count = index ? index.count : position.count;
  const vertex = new THREE.Vector3();
  const world: number[] = [];
  let y = 0;
  for (let i = 0; i < count; i++) {
    vertex.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
    world.push(vertex.x, vertex.z);
    y = vertex.y;
  }
  if (world.length < 6) return null;
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < world.length; i += 2) {
    minX = Math.min(minX, world[i]);
    maxX = Math.max(maxX, world[i]);
    minZ = Math.min(minZ, world[i + 1]);
    maxZ = Math.max(maxZ, world[i + 1]);
  }
  const x0 = Math.floor(minX / cell),
    z0 = Math.floor(minZ / cell);
  const columns = Math.ceil(maxX / cell) - x0,
    rows = Math.ceil(maxZ / cell) - z0;
  const inside = new Uint8Array(columns * rows);
  const triangles = world.length / 6;
  for (let t = 0; t < triangles; t++) {
    const [ax, az, bx, bz, cx, cz] = world.slice(t * 6, t * 6 + 6);
    const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const c0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) / cell) - x0),
      c1 = Math.min(columns - 1, Math.ceil(Math.max(ax, bx, cx) / cell) - x0),
      r0 = Math.max(0, Math.floor(Math.min(az, bz, cz) / cell) - z0),
      r1 = Math.min(rows - 1, Math.ceil(Math.max(az, bz, cz) / cell) - z0);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const px = (x0 + c + 0.5) * cell,
          pz = (z0 + r + 0.5) * cell;
        const w0 = ((bx - px) * (cz - pz) - (bz - pz) * (cx - px)) / area;
        const w1 = ((cx - px) * (az - pz) - (cz - pz) * (ax - px)) / area;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) inside[r * columns + c] = 1;
      }
  }
  const at = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < columns && r < rows && inside[r * columns + c] === 1;
  const positions: number[] = [],
    edges: number[] = [];
  const quad = (c: number, r: number, width: number, edge: number) => {
    const ax = (x0 + c) * cell,
      bx = (x0 + c + width) * cell,
      az = (z0 + r) * cell,
      bz = (z0 + r + 1) * cell;
    positions.push(ax, y, az, ax, y, bz, bx, y, bz, ax, y, az, bx, y, bz, bx, y, az);
    for (let i = 0; i < 6; i++) edges.push(edge);
  };
  for (let r = 0; r < rows; r++) {
    let run = -1;
    for (let c = 0; c <= columns; c++) {
      const filled = at(c, r);
      const edge = filled && !(at(c - 1, r) && at(c + 1, r) && at(c, r - 1) && at(c, r + 1));
      if (filled && !edge) {
        if (run < 0) run = c;
        continue;
      }
      if (run >= 0) quad(run, r, c - run, 0);
      run = -1;
      if (edge) quad(c, r, 1, 1);
    }
  }
  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aIceEdge', new THREE.Float32BufferAttribute(edges, 1));
  geometry.applyMatrix4(mesh.matrixWorld.clone().invert());
  geometry.computeVertexNormals();
  return geometry;
}

/** Signed distances are stored as bytes over this range (world units). */
const SHORE_MIN = -1,
  SHORE_RANGE = 8;

const SHORE_SAMPLE = /* glsl */ `
uniform sampler2D uShore;
uniform vec4 uShoreBox;
uniform float uShoreOn;
// Distance to the nearest shore in world units: positive over open water.
float shoreDistance(vec2 p) {
  if (uShoreOn < 0.5) return 9.0;
  vec2 uv = (p - uShoreBox.xy) / uShoreBox.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 9.0;
  return texture2D(uShore, uv).r * ${SHORE_RANGE.toFixed(1)} + (${SHORE_MIN.toFixed(1)});
}
`;

const WATER_FRAGMENT = /* glsl */ `
#include <color_fragment>
float waterFoam = 0.0;
vec3 waterTilt = vec3(0.0);
{
  vec3 base = diffuseColor.rgb;
  vec3 deep = base * vec3(0.74, 0.88, 1.0);
  float t = uSurfTime;
  if (uSurfPixel > 0.0) {
    // Pixel art water: two-voxel pixels, three dithered tones, a stepped clock.
    float wpx = uSurfPixel * 2.0;
    vec2 cell = floor(vSurfWorld.xz / wpx);
    vec2 p = (cell + 0.5) * wpx;
    float ts = floor(t * 4.0) / 4.0;
    float d = shoreDistance(p);
    float k = d / wpx;
    float swell = sNoise(p * 0.6 + vec2(ts * 0.3, ts * 0.12));
    // Bands: shallow ring by the shore, then mid and deep; dithering only blurs the
    // seams by about one pixel, the swell makes the deep patches drift.
    float v = smoothstep(0.0, 2.8, d) * 0.85 + (swell - 0.5) * 0.25 + (sBayer4(cell) - 0.5) * 0.1;
    vec3 c = v < 0.22 ? mix(base, vec3(0.6, 0.9, 0.84), 0.12) : (v < 0.6 ? base : deep);
    // Matte pixels catch more light than the old glossy plane; match its depth.
    c *= sT(0.88 + sHash(cell) * 0.05);
    // Glints: short dashes that drift sideways and re-roll every two seconds.
    float x = cell.x + floor(ts * 2.0);
    // Sparse, and only away from the shallow band: dense dashes read as snow from afar.
    float dash = step(0.965, sHash(vec2(floor(x / 3.0), cell.y) + floor(ts / 2.0) * 7.31))
      * step(mod(x, 3.0), 1.0) * step(1.5, k) * step(0.45, v);
    c = mix(c, mix(base, vec3(1.0), 0.55), dash * 0.85);
    // Foam: a solid first ring with rare gaps, and a broken ring stepping outwards.
    float hug = step(k, 1.0) * step(0.15, sHash(cell + floor(ts) * 3.1));
    float ring = 1.0 + floor(fract(t * 0.25) * 4.0);
    float wave = step(abs(floor(k) - ring), 0.0) * step(ring, 3.0) * step(0.52, sNoise(p * 1.5 + 3.0));
    waterFoam = max(hug, wave) * step(-0.05, d) * uShoreOn;
    diffuseColor.rgb = mix(c, vec3(0.95, 0.99, 1.0), waterFoam);
  } else {
    vec2 p = vSurfWorld.xz;
    float d = shoreDistance(p);
    float shallow = 1.0 - smoothstep(0.0, 3.0, d);
    vec3 c = mix(deep, mix(base, vec3(0.6, 0.9, 0.84), 0.12) * 1.02, shallow);
    // Two drifting ripple layers make soft swells; a few sun sparkles.
    vec2 q1 = p * 0.85 + vec2(t * 0.11, t * 0.04);
    vec2 q2 = p * 1.6 + vec2(-t * 0.08, t * 0.1) + 11.0;
    float r1 = sNoise(q1);
    float r = (r1 + sNoise(q2)) * 0.5;
    c *= 1.0 + (r - 0.5) * 0.12;
    c += smoothstep(0.9, 0.97, sNoise(p * 3.6 + vec2(t * 0.5, -t * 0.3))) * 0.07;
    // Shore foam: a broken band hugging the land and one wave rolling outwards.
    float fn = sNoise(p * 2.3 + vec2(t * 0.2, 0.0));
    float hug = 1.0 - smoothstep(0.04, 0.12 + fn * 0.1, d);
    float phase = fract(t * 0.18);
    float fade = (1.0 - phase) * (1.0 - phase);
    float wave = (1.0 - smoothstep(0.0, 0.05 + 0.03 * fn, abs(d - 0.14 - phase * 0.7 + (fn - 0.5) * 0.12)))
      * fade * step(0.35, fn);
    waterFoam = clamp(max(hug, wave * 0.65), 0.0, 1.0) * step(-0.05, d) * uShoreOn;
    diffuseColor.rgb = mix(c, vec3(0.95, 0.99, 1.0), waterFoam * 0.92);
    float gx = sNoise(q1 + vec2(0.35, 0.0)) - r1;
    float gz = sNoise(q1 + vec2(0.0, 0.35)) - r1;
    waterTilt = vec3(-gx, 0.0, -gz) * 0.12 * (1.0 - waterFoam);
  }
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
      .replace('#include <common>', `#include <common>\n${COMMON}\n${SHORE_SAMPLE}`)
      .replace('#include <color_fragment>', WATER_FRAGMENT)
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = uSurfPixel > 0.0 ? 0.92 : mix(roughnessFactor, 0.85, waterFoam);',
      )
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\nnormal = normalize(normal + (viewMatrix * vec4(waterTilt, 0.0)).xyz);',
      );
  }

  override customProgramCacheKey(): string {
    return 'surface-water-2';
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
