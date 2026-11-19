import * as THREE from 'three';
import { surfaceUniforms } from './surfaces';

/*
 * Portal light effects: a swirling membrane in the doorway, a halo around the
 * frame, a pool of light on the floor and motes drifting into the gate. All of
 * it is procedural (no textures), animated from simulation time through the
 * shared surface clock, and switches to a pixel look with the voxel style:
 * per-cell colours from a few fixed tiers, ordered dithering, a stepped clock
 * and square motes. Presentation only; the simulation never reads it.
 *
 * The camera looks down at about 60°, so a gate seen edge-on shows almost
 * nothing of its membrane. The floor pool, the motes and the glowing caps on
 * the frame (built by the caller) are what make every gate readable.
 */

export interface PortalFx {
  /** 0..1, raised when something passes through; shared by every part of one portal. */
  flash: { value: number };
  membrane?: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  halo?: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  pool: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  motes: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
}

const COMMON = /* glsl */ `
uniform float uSurfPixel;
uniform float uSurfTime;
uniform vec3 uColor;
uniform float uFlash;
float pHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float pNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(pHash(i), pHash(i + vec2(1.0, 0.0)), u.x),
             mix(pHash(i + vec2(0.0, 1.0)), pHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float pBayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}
float pBayer4(vec2 a) {
  return pBayer2(0.5 * a) * 0.25 + pBayer2(a);
}
// The pixel look animates on a stepped clock, eight steps a second.
float pClock() {
  return uSurfPixel > 0.0 ? floor(uSurfTime * 8.0) / 8.0 : uSurfTime;
}
`;

const MEMBRANE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MEMBRANE_FRAGMENT = /* glsl */ `
${COMMON}
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  float px = uSurfPixel;
  vec2 m = vUv * uSize;
  vec2 cell = floor(m / max(px, 0.001));
  if (px > 0.0) m = (cell + 0.5) * px;
  float t = pClock();
  vec2 halfSize = uSize * 0.5;
  vec2 c = m - halfSize;
  vec2 e = c / halfSize;
  float r = length(e * vec2(1.0, 0.8));
  float a = atan(e.y, e.x);
  // Two spiral arms turning around the centre, broken up by drifting noise.
  float n = pNoise(e * 2.6 + vec2(t * 0.35, -t * 0.6));
  float arms = 0.5 + 0.5 * sin(a * 2.0 - r * 6.5 + t * 3.0 + n * 2.4);
  // Rings that shrink towards the centre, as if pulled in.
  float ripple = smoothstep(0.7, 1.0, fract(r * 2.3 + t * 1.05)) * (1.0 - smoothstep(0.7, 1.0, r));
  // Bright along the posts and lintel; the bottom edge meets the floor.
  vec2 side = halfSize - abs(c);
  float edge = c.y < 0.0 ? side.x : min(side.x, side.y);
  float rim = exp(-edge * 10.0);
  float core = exp(-r * r * 5.0);
  float v = 0.3 + arms * 0.34 + ripple * 0.24 + rim * 0.7 + core * 0.2 + uFlash * 0.6;
  vec3 deep = uColor * 0.5;
  vec3 hot = mix(uColor, vec3(1.0), 0.5);
  vec3 col;
  float alpha;
  if (px > 0.0) {
    // Four tiers per cell, with a light dither where they meet.
    v += (pBayer4(cell) - 0.5) * 0.08;
    col = v < 0.45 ? deep : (v < 0.72 ? uColor : (v < 1.0 ? hot : vec3(1.0)));
    alpha = 0.94;
  } else {
    col = mix(deep, uColor, smoothstep(0.25, 0.62, v));
    col = mix(col, hot, smoothstep(0.62, 1.0, v));
    col = mix(col, vec3(1.0), smoothstep(1.0, 1.35, v));
    alpha = 0.8 + 0.16 * clamp(v, 0.0, 1.0);
  }
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

const HALO_VERTEX = /* glsl */ `
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HALO_FRAGMENT = /* glsl */ `
${COMMON}
uniform vec3 uFrame; // half width, bottom, top of the frame (gate space, metres)
varying vec2 vPos;
void main() {
  float px = uSurfPixel;
  vec2 p = vPos;
  vec2 cell = floor(p / max(px, 0.001));
  if (px > 0.0) p = (cell + 0.5) * px;
  vec2 outside = vec2(abs(p.x) - uFrame.x, max(uFrame.y - p.y, p.y - uFrame.z));
  float d = length(max(outside, 0.0));
  float pulse = 0.85 + 0.15 * sin(pClock() * 2.6);
  float glow = exp(-d * 5.0) * (0.34 * pulse + uFlash * 0.4);
  // Pixel style: solid bands of light, one cell apart, instead of a gradient.
  if (px > 0.0) glow = glow > 0.24 ? 0.34 : (glow > 0.1 ? 0.17 : 0.0);
  if (glow <= 0.0) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.25), glow);
  #include <colorspace_fragment>
}
`;

const POOL_VERTEX = /* glsl */ `
varying vec2 vPos;
varying vec3 vWorld;
void main() {
  vPos = position.xz;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const POOL_FRAGMENT = /* glsl */ `
${COMMON}
uniform mat4 modelMatrix;
uniform float uSpan;   // half length of a gate's threshold (0 for a round pad)
uniform float uInner;  // radius of a pad's swirl (0 for a gate)
uniform float uExtent; // where the light has faded out
varying vec2 vPos;
varying vec3 vWorld;
void main() {
  float px = uSurfPixel;
  vec2 p = vPos;
  vec2 cell = vec2(0.0);
  if (px > 0.0) {
    // Snap to the world voxel grid, like the ground under it, then back to gate space.
    cell = floor(vWorld.xz / px);
    vec3 snapped = vec3((cell.x + 0.5) * px, vWorld.y, (cell.y + 0.5) * px);
    p = (transpose(mat3(modelMatrix)) * (snapped - modelMatrix[3].xyz)).xz;
  }
  float t = pClock();
  float radius = length(p);
  float d = uInner > 0.0
    ? max(radius - uInner, 0.0)
    : length(vec2(max(abs(p.x) - uSpan, 0.0), p.y));
  float glow = exp(-d * 1.7);
  // Rings of light rolling outwards.
  float ring = smoothstep(0.8, 1.0, fract(d * 1.8 - t * 0.7)) * exp(-d * 1.6) * step(0.001, d);
  // A bright line right under a gate's doorway.
  float threshold = uInner > 0.0 ? 0.0 : (1.0 - smoothstep(0.0, 0.12, abs(p.y))) * step(abs(p.x), uSpan);
  // A pad swirls inside its ring.
  float inside = uInner > 0.0 ? 1.0 - smoothstep(uInner - 0.04, uInner, radius) : 0.0;
  float swirl = 0.5 + 0.5 * sin(atan(p.y, p.x) * 3.0 + radius * 7.0 - t * 3.5);
  float light = (glow * 0.72 + ring * 0.45 + threshold * 0.4) * (1.0 + uFlash * 0.8);
  light += inside * (0.22 + swirl * 0.3 + uFlash * 0.4);
  light *= 1.0 - smoothstep(uExtent * 0.7, uExtent, d);
  float white = clamp(ring * 0.55 + threshold * 0.45 + swirl * inside * 0.35, 0.0, 1.0);
  if (px > 0.0) {
    // Solid bands and a crisp white ring, no gradients.
    light = light > 0.45 ? 0.72 : (light > 0.25 ? 0.46 : (light > 0.1 ? 0.22 : 0.0));
    white = step(0.3, white);
  }
  if (light <= 0.0) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), white * 0.7), min(light, 0.85));
  #include <colorspace_fragment>
}
`;

const MOTE_VERTEX = /* glsl */ `
${COMMON}
attribute vec4 aSeed;
uniform vec4 uMote;       // reach across, reach out, top, kind (0 gate, 1 pad)
uniform float uFloor;
uniform float uPointScale; // half the render height in pixels
varying float vAlpha;
varying float vHot;
void main() {
  float t = pClock();
  float life = 1.6 + aSeed.w * 1.4;
  float ph = fract(t / life + aSeed.x);
  float e = ph * ph * (3.0 - 2.0 * ph);
  vec3 p;
  if (uMote.w < 0.5) {
    // From the floor in front of the gate up into the doorway (its back is a wall).
    float x0 = (aSeed.z * 2.0 - 1.0) * (uMote.x + 0.3);
    float z0 = -(0.15 + aSeed.y * uMote.y);
    float y1 = uFloor + 0.3 + fract(aSeed.z * 5.31) * max(0.2, uMote.z - uFloor - 0.5);
    p = vec3(mix(x0, x0 * 0.5, e), mix(uFloor + 0.05, y1, ph), mix(z0, 0.0, e));
    p.x += sin(ph * 8.0 + aSeed.w * 6.283) * 0.05;
  } else {
    // Spiralling in and up over a pad.
    float angle = aSeed.y * 6.283 + ph * 2.5;
    float radius = mix(uMote.x + 0.3 + aSeed.z * uMote.y, 0.15, e);
    p = vec3(cos(angle) * radius, uFloor + 0.05 + ph * uMote.z, sin(angle) * radius);
  }
  float px = uSurfPixel;
  if (px > 0.0) p = (floor(p / px) + 0.5) * px;
  vec4 view = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * view;
  float size = px > 0.0 ? px * 1.5 : mix(0.17, 0.09, ph);
  gl_PointSize = max(2.0, size * projectionMatrix[1][1] * uPointScale / -view.z);
  float fade = smoothstep(0.0, 0.15, ph) * (1.0 - smoothstep(0.75, 1.0, ph));
  vAlpha = (px > 0.0 ? step(0.1, ph) * step(ph, 0.88) : fade) * min(1.0, 0.85 + uFlash);
  vHot = fract(aSeed.w * 13.7);
}
`;

const MOTE_FRAGMENT = /* glsl */ `
${COMMON}
varying float vAlpha;
varying float vHot;
void main() {
  float a = vAlpha;
  float white = 0.15 + vHot * 0.45;
  if (uSurfPixel <= 0.0) {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    a *= 1.0 - smoothstep(0.3, 0.5, r);
    white = mix(white, 1.0, 1.0 - smoothstep(0.0, 0.25, r));
  } else {
    white = step(0.4, white);
  }
  if (a <= 0.0) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), white), a);
  #include <colorspace_fragment>
}
`;

/**
 * The map colours are pastel; light needs more saturation to read on the pale
 * ground. Same hue, richer and a little darker.
 */
export function portalTone(color: string): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(color).getHSL(hsl, THREE.SRGBColorSpace);
  return new THREE.Color().setHSL(
    hsl.h,
    Math.min(1, hsl.s * 1.1 + 0.1),
    Math.min(0.62, Math.max(0.45, hsl.l * 0.82)),
    THREE.SRGBColorSpace,
  );
}

/** Shared by every mote material; each Points object refreshes it before it draws. */
const pointScale = { value: 300 };
const drawingSize = new THREE.Vector2();

function effectMaterial(
  vertexShader: string,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSurfPixel: surfaceUniforms.uSurfPixel,
      uSurfTime: surfaceUniforms.uSurfTime,
      ...uniforms,
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // The ground is light and bright, so additive light would wash out to white:
  // the effects blend normally in a saturated colour and skip tone mapping.
  material.toneMapped = false;
  return material;
}

function seeds(count: number, salt: number): Float32Array {
  const out = new Float32Array(count * 4);
  // A fixed sequence per portal: replays and reloads show the same motes.
  let s = (salt * 2654435761) >>> 0 || 1;
  for (let i = 0; i < out.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = ((s >>> 0) % 10007) / 10007;
  }
  return out;
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

function makePool(
  color: THREE.Color,
  flash: { value: number },
  floor: number,
  halfX: number,
  halfZ: number,
  span: number,
  inner: number,
  extent: number,
): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const geometry = new THREE.PlaneGeometry(halfX * 2, halfZ * 2);
  geometry.rotateX(-Math.PI / 2);
  const pool = new THREE.Mesh(
    geometry,
    effectMaterial(POOL_VERTEX, POOL_FRAGMENT, {
      uColor: { value: color },
      uFlash: flash,
      uSpan: { value: span },
      uInner: { value: inner },
      uExtent: { value: extent },
    }),
  );
  pool.name = 'portal-pool';
  pool.position.y = floor + 0.025;
  pool.renderOrder = 1;
  return pool;
}

function makeMotes(
  color: THREE.Color,
  flash: { value: number },
  id: string,
  count: number,
  mote: THREE.Vector4,
  floor: number,
): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds(count, hashId(id)), 4));
  const motes = new THREE.Points(
    geometry,
    effectMaterial(MOTE_VERTEX, MOTE_FRAGMENT, {
      uColor: { value: color },
      uFlash: flash,
      uMote: { value: mote },
      uFloor: { value: floor },
      uPointScale: pointScale,
    }),
  );
  motes.name = 'portal-motes';
  // Positions are computed in the shader; the zero buffer would cull wrongly.
  motes.frustumCulled = false;
  motes.renderOrder = 4;
  motes.onBeforeRender = (renderer) => {
    const target = renderer.getRenderTarget();
    pointScale.value = (target ? target.height : renderer.getDrawingBufferSize(drawingSize).y) / 2;
  };
  return motes;
}

export interface GateFxSpec {
  id: string;
  color: string;
  /** Doorway width between the posts. */
  width: number;
  /** Outer half width of the frame, posts included. */
  frameHalf: number;
  /** Top of the frame. */
  top: number;
  /** Floor level in gate space (a sunken gate starts below the floor). */
  floor: number;
  /** Height of the doorway's top edge. */
  doorTop: number;
  /**
   * Depth of the doorway face along the gate's local z. Every original gate
   * stands against a wall on its +z side and is entered from -z, so the
   * effects sit on the open side, clear of the wall (whose voxels can grow
   * by up to a cell in the pixel style).
   */
  front: number;
}

/** Membrane, halo, floor pool and motes for a standing gate, in the gate's own frame. */
export function createGateFx(root: THREE.Object3D, spec: GateFxSpec): PortalFx {
  const color = portalTone(spec.color);
  const flash = { value: 0 };
  const bottom = Math.max(0, spec.floor);
  const height = Math.max(0.2, spec.doorTop - bottom);
  const membrane = new THREE.Mesh(
    new THREE.PlaneGeometry(spec.width, height),
    effectMaterial(MEMBRANE_VERTEX, MEMBRANE_FRAGMENT, {
      uColor: { value: color },
      uFlash: flash,
      uSize: { value: new THREE.Vector2(spec.width, height) },
    }),
  );
  membrane.name = 'portal-membrane';
  membrane.position.set(0, bottom + height / 2, spec.front);
  membrane.renderOrder = 3;
  const spread = 0.65;
  const haloGeometry = new THREE.PlaneGeometry(
    (spec.frameHalf + spread) * 2,
    spec.top + spread - bottom,
  );
  haloGeometry.translate(0, bottom + (spec.top + spread - bottom) / 2, 0);
  const halo = new THREE.Mesh(
    haloGeometry,
    effectMaterial(HALO_VERTEX, HALO_FRAGMENT, {
      uColor: { value: color },
      uFlash: flash,
      uFrame: { value: new THREE.Vector3(spec.frameHalf, bottom, spec.top) },
    }),
  );
  halo.name = 'portal-halo';
  halo.position.z = spec.front - 0.02;
  halo.renderOrder = 2;
  const pool = makePool(
    color,
    flash,
    spec.floor,
    spec.frameHalf + 1.1,
    0.85,
    spec.width / 2,
    0,
    1.3,
  );
  // Mostly in front: the wall covers whatever lies behind the doorway.
  pool.geometry.translate(0, 0, -0.55);
  pool.position.z = spec.front;
  const motes = makeMotes(
    color,
    flash,
    spec.id,
    22,
    new THREE.Vector4(spec.width / 2, 0.7, spec.doorTop, 0),
    spec.floor,
  );
  motes.position.z = spec.front;
  root.add(pool, halo, membrane, motes);
  return { flash, membrane, halo, pool, motes };
}

/** Floor pool with a swirl and spiralling motes for a round pad of the given radius. */
export function createPadFx(
  root: THREE.Object3D,
  id: string,
  colorValue: string,
  radius: number,
): PortalFx {
  const color = portalTone(colorValue);
  const flash = { value: 0 };
  const reach = radius + 1.2;
  const pool = makePool(color, flash, 0.02, reach, reach, 0, radius * 0.62, 1.1);
  const motes = makeMotes(color, flash, id, 18, new THREE.Vector4(radius, 0.5, 1.6, 1), 0.05);
  root.add(pool, motes);
  return { flash, pool, motes };
}
