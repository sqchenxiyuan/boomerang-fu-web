/*
 * Custom agent looks, after MUNDI's Agent atelier (src/client/features/appearance.js
 * and agent-world.js): a hand-drawn face whose silhouette is voxelised into the
 * head of a blocky body. The drawing is stored as a PNG for editing; the voxel
 * runs are stored beside it so the 3D model can be built synchronously.
 */

/** Pad resolution. MUNDI uses 1000²; 512² keeps several agents inside localStorage. */
export const LOOK_RES = 512;
/** Voxel grid, as MUNDI's voxelizeTex(tex, 30). */
export const VOXEL_GRID = 30;
const ALPHA_CUT = 110;
const MERGE_DISTANCE = 34;
const MAX_AGENTS = 12;
const STORAGE_KEY = 'boomerang-garden.agents.v1';

/** One run-length merged row of voxels: grid x, grid y (top = 0), width, colour. */
export type VoxelRun = [x: number, y: number, w: number, color: string];

export interface AgentLook {
  v: 1;
  id: string;
  name: string;
  /** PNG data URL of the drawing, transparent outside the silhouette. */
  img: string;
  /** Pad backdrop, for editing only; the silhouette ignores it. */
  bg: string;
  /** Main body colour, also the player colour in the HUD. */
  hue: string;
  grid: number;
  runs: VoxelRun[];
  updated: number;
}

export interface AgentLibrary {
  agents: AgentLook[];
  /** Agent chosen for each human slot (1P = 0, 2P = 1). */
  slots: (string | null)[];
}

export interface PixelSource {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

const HEX = /^#[0-9a-f]{6}$/i;
const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
export const toHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => clampByte(v).toString(16).padStart(2, '0')).join('');
export function hexRgb(hex: string): [number, number, number] {
  const value = HEX.test(hex) ? hex : '#c6f24e';
  return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}
export function mixHex(a: string, b: string, t: number): string {
  const x = hexRgb(a),
    y = hexRgb(b);
  return toHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
}

/** Body, limb and accent colours derived from the main hue (MUNDI's build()). */
export function lookPalette(hue: string): {
  main: string;
  body: string;
  belly: string;
  dark: string;
  back: string;
  light: string;
} {
  const ink = '#0e1012';
  return {
    main: hue,
    body: mixHex(hue, ink, 0.55),
    belly: mixHex(hue, ink, 0.3),
    dark: '#181b1f',
    back: mixHex(hue, ink, 0.32),
    light: mixHex(hue, '#ffffff', 0.55),
  };
}

/** MUNDI voxelizeTex: alpha silhouette, row runs merged while colours stay close. */
export function voxelize(source: PixelSource, grid = VOXEL_GRID): VoxelRun[] {
  if (source.width !== grid || source.height !== grid) throw new RangeError('Pixel grid mismatch');
  const d = source.data,
    runs: VoxelRun[] = [];
  for (let y = 0; y < grid; y++) {
    let x = 0;
    while (x < grid) {
      const i = (y * grid + x) * 4;
      if (d[i + 3] < ALPHA_CUT) {
        x++;
        continue;
      }
      const color = [d[i], d[i + 1], d[i + 2]];
      let end = x;
      while (end + 1 < grid) {
        const j = (y * grid + end + 1) * 4;
        if (d[j + 3] < ALPHA_CUT) break;
        if (
          Math.abs(d[j] - color[0]) +
            Math.abs(d[j + 1] - color[1]) +
            Math.abs(d[j + 2] - color[2]) >
          MERGE_DISTANCE
        )
          break;
        end++;
      }
      runs.push([x, y, end - x + 1, toHex(color[0], color[1], color[2])]);
      x = end + 1;
    }
  }
  return runs;
}

export function runBounds(runs: readonly VoxelRun[]): {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
} | null {
  if (!runs.length) return null;
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const [x, y, w] of runs) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x + w - 1);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return { x0, x1, y0, y1 };
}

/** MUNDI dominantHex: the most common saturated colour, quantised to 3 bits per channel. */
export function dominantHex(source: PixelSource): string | null {
  const d = source.data,
    counts = new Map<number, number>();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 120) continue;
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2],
      max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    if (max < 50 || max - min < 28) continue;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = -1,
    most = 0;
  for (const [key, count] of counts)
    if (count > most) {
      most = count;
      best = key;
    }
  if (best < 0) return null;
  return toHex(((best >> 6) & 7) * 36 + 18, ((best >> 3) & 7) * 36 + 18, (best & 7) * 36 + 18);
}

export const hashOf = (text: string): number =>
  [...text].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) | 0, 7) >>> 0;

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Optional creature traits; any field left out is rolled from the seed. */
export interface Traits {
  shape?: number;
  top?: number;
  mark?: number;
  eyes?: number;
  eye?: number;
  brow?: number;
  mouth?: number;
  acc?: number;
  hue?: number;
  dark?: boolean;
}

/** MUNDI traitsFrom: keywords in a short description bias the preset creatures. */
export function traitsFrom(text: string): Traits {
  const t = (text || '').toLowerCase(),
    tr: Traits = {};
  const has = (pattern: RegExp): boolean => pattern.test(t);
  if (has(/猛|攻|aggress|angry|愤怒|狠|凶|fierce/))
    Object.assign(tr, { brow: 1, eye: 1, mouth: 4 });
  if (has(/稳|耐心|patient|calm|冷静|沉/))
    Object.assign(tr, { eye: 0, brow: 0, mouth: 3, hue: 205 });
  if (has(/快|fast|quick|闪|急/)) Object.assign(tr, { top: 4, shape: 2 });
  if (has(/熊|bear/)) tr.top = 2;
  if (has(/猫|cat|狐|fox/)) Object.assign(tr, { top: 2, eye: 1 });
  if (has(/龙|dragon|恶魔|demon|魔/)) Object.assign(tr, { top: 1, mark: 1, eyes: 2 });
  if (has(/机器|robot|mech|机甲|bot/)) Object.assign(tr, { shape: 1, eye: 1, top: 4, mouth: 4 });
  if (has(/幽灵|ghost|鬼|魂/)) Object.assign(tr, { shape: 2, eye: 3, hue: 262, mouth: 5 });
  if (has(/王|king|冠|crown|皇/)) tr.top = 3;
  if (has(/独眼|一只眼|cyclops/)) tr.eyes = 1;
  if (has(/三只眼|三眼/)) tr.eyes = 3;
  if (has(/笑|happy|乐|开心/)) tr.mouth = 1;
  if (has(/哭|sad|丧|难过/)) Object.assign(tr, { mouth: 2, brow: 2 });
  if (has(/圆|round|胖|球/)) tr.shape = 0;
  if (has(/方|square|硬|块/)) tr.shape = 1;
  if (has(/尖|刺|spike/)) tr.shape = 3;
  const hues: [RegExp, number][] = [
    [/红|red/, 2],
    [/蓝|blue/, 212],
    [/绿|green/, 105],
    [/紫|purple|violet/, 272],
    [/黄|yellow|金|gold/, 48],
    [/粉|pink/, 332],
    [/橙|orange/, 28],
    [/青|cyan/, 185],
  ];
  for (const [pattern, hue] of hues) if (has(pattern)) tr.hue = hue;
  if (has(/黑|black|暗|dark/)) tr.dark = true;
  if (has(/条纹|stripe|斑马/)) tr.mark = 1;
  if (has(/斑点|spot|豹/)) tr.mark = 2;
  if (has(/面具|mask|蒙面/)) tr.mark = 3;
  if (has(/围巾|scarf/)) tr.acc = 1;
  if (has(/星|star/)) tr.acc = 2;
  if (has(/眼罩|海盗|pirate/)) tr.acc = 3;
  return tr;
}

const hsl = (h: number, s: number, l: number): string =>
  `hsl(${Math.round(((h % 360) + 360) % 360)} ${s}% ${l}%)`;
function hslHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12,
    a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex(f(0) * 255, f(8) * 255, f(4) * 255);
}
const FAMILIES = [0, 30, 48, 90, 140, 175, 200, 225, 260, 290, 320, 345];

/** MUNDI presetDraw: a hand-drawn creature from a seed and optional traits. Returns its main hex. */
export function presetDraw(
  x: CanvasRenderingContext2D,
  size: number,
  seed: number,
  traits: Traits | null = null,
): string {
  const t = traits ?? {},
    R = rng(seed),
    TAU = Math.PI * 2;
  const h = t.hue ?? FAMILIES[Math.floor(R() * FAMILIES.length)] + R() * 12,
    accentHue = (h + 130 + R() * 100) % 360,
    dark = !!t.dark;
  const pal = {
    base: dark ? hsl(h, 45, 28) : hsl(h, 70, 54),
    baseHex: dark ? hslHex(h, 45, 28) : hslHex(h, 70, 54),
    dark: dark ? hsl(h, 50, 12) : hsl(h, 55, 22),
    accent: hsl(accentHue, 88, 62),
    light: '#F3F5F2',
    ink: '#0B0D0F',
  };
  const cx = size / 2,
    cy = size * 0.55,
    r = size * 0.33;
  const shape = t.shape ?? Math.floor(R() * 7),
    top = t.top ?? Math.floor(R() * 5),
    mark = t.mark ?? Math.floor(R() * 6),
    eyes = t.eyes ?? (R() < 0.72 ? 2 : R() < 0.5 ? 1 : 3),
    eyeStyle = t.eye ?? Math.floor(R() * 5),
    brow = t.brow ?? Math.floor(R() * 3),
    mouth = t.mouth ?? Math.floor(R() * 6),
    acc = t.acc ?? Math.floor(R() * 4),
    jitter = size * 0.008;
  const wob = (px: number, py: number): [number, number] => [
    px + (R() - 0.5) * jitter * 2,
    py + (R() - 0.5) * jitter * 2,
  ];
  const outline = (): void => {
    const points: [number, number][] = [];
    const N = 56;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      let rr = r;
      if (shape === 1)
        rr = r * Math.min(1 / Math.abs(Math.cos(a) + 1e-6), 1 / Math.abs(Math.sin(a) + 1e-6), 1.32);
      else if (shape === 2) rr = r * (1 + 0.16 * Math.sin(a));
      else if (shape === 3) rr = (r * 1.12) / (Math.abs(Math.cos(a)) + Math.abs(Math.sin(a)));
      else if (shape === 4)
        rr = (r * 1.06) / Math.cos(((a + Math.PI / 6) % (Math.PI / 3)) - Math.PI / 6);
      else if (shape === 5)
        rr = r * (0.9 + 0.16 * Math.sin(a * 3 + (seed % 7)) + 0.06 * Math.sin(a * 5));
      else if (shape === 6) rr = r * (1 + (a > Math.PI ? 0.14 : 0));
      points.push(wob(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * (shape === 2 ? 1.08 : 1)));
    }
    x.beginPath();
    points.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])));
    x.closePath();
  };
  x.lineWidth = size * 0.032;
  x.lineJoin = 'round';
  x.lineCap = 'round';
  x.strokeStyle = pal.dark;
  x.fillStyle = pal.accent;
  if (top === 1)
    for (const d of [-1, 1]) {
      x.beginPath();
      x.moveTo(...wob(cx + d * r * 0.35, cy - r * 0.75));
      x.lineTo(...wob(cx + d * r * 0.95, cy - r * 1.4));
      x.lineTo(...wob(cx + d * r * 0.78, cy - r * 0.55));
      x.closePath();
      x.fill();
      x.stroke();
    }
  else if (top === 2) {
    x.fillStyle = pal.base;
    for (const d of [-1, 1]) {
      x.beginPath();
      x.arc(cx + d * r * 0.72, cy - r * 0.8, r * 0.3, 0, TAU);
      x.fill();
      x.stroke();
    }
  } else if (top === 3)
    for (let i = -1; i <= 1; i++) {
      x.beginPath();
      x.moveTo(...wob(cx + i * r * 0.38 - r * 0.17, cy - r * 0.85));
      x.lineTo(...wob(cx + i * r * 0.38, cy - r * (1.38 - Math.abs(i) * 0.15)));
      x.lineTo(...wob(cx + i * r * 0.38 + r * 0.17, cy - r * 0.85));
      x.closePath();
      x.fill();
      x.stroke();
    }
  else if (top === 4) {
    x.beginPath();
    x.moveTo(cx, cy - r * 0.9);
    x.lineTo(cx + r * 0.16, cy - r * 1.42);
    x.stroke();
    x.beginPath();
    x.arc(cx + r * 0.16, cy - r * 1.48, r * 0.13, 0, TAU);
    x.fill();
  }
  outline();
  x.fillStyle = pal.base;
  x.fill();
  x.save();
  x.clip();
  if (mark === 1) {
    x.fillStyle = pal.accent;
    for (let i = -1; i <= 1; i++)
      x.fillRect(cx - r * 1.3, cy + i * r * 0.5 - r * 0.09, r * 2.6, r * 0.18);
  } else if (mark === 2) {
    x.fillStyle = pal.accent;
    for (let i = 0; i < 7; i++) {
      x.beginPath();
      x.arc(cx + (R() - 0.5) * r * 1.7, cy + (R() - 0.5) * r * 1.7, r * (0.08 + R() * 0.1), 0, TAU);
      x.fill();
    }
  } else if (mark === 3) {
    x.fillStyle = pal.dark;
    x.fillRect(cx - r * 1.3, cy - r * 0.34, r * 2.6, r * 0.38);
  } else if (mark === 4) {
    x.fillStyle = 'rgba(255,255,255,.26)';
    x.beginPath();
    x.ellipse(cx, cy + r * 0.45, r * 0.62, r * 0.5, 0, 0, TAU);
    x.fill();
  } else if (mark === 5) {
    x.fillStyle = pal.accent;
    x.fillRect(cx, cy - r * 1.4, r * 1.6, r * 2.8);
  }
  x.restore();
  outline();
  x.stroke();
  const ey = cy - r * 0.12,
    er = r * (0.14 + R() * 0.08);
  const xs =
    eyes === 1
      ? [cx]
      : eyes === 2
        ? [cx - r * 0.36, cx + r * 0.36]
        : [cx - r * 0.44, cx, cx + r * 0.44];
  xs.forEach((ex, i) => {
    const eyy = eyes === 3 && i === 1 ? ey - r * 0.22 : ey;
    if (acc === 3 && i === 0) {
      x.fillStyle = pal.dark;
      x.beginPath();
      x.arc(ex, eyy, er * 1.25, 0, TAU);
      x.fill();
      return;
    }
    if (eyeStyle === 0 || eyeStyle === 4) {
      const wide = eyeStyle === 4;
      x.fillStyle = pal.light;
      x.beginPath();
      x.ellipse(ex, eyy, er * (wide ? 1.35 : 1), er * (wide ? 1.1 : 1), 0, 0, TAU);
      x.fill();
      x.fillStyle = pal.ink;
      x.beginPath();
      x.arc(ex + er * 0.2, eyy + er * 0.1, er * (wide ? 0.62 : 0.5), 0, TAU);
      x.fill();
    } else if (eyeStyle === 1) {
      x.fillStyle = pal.ink;
      x.beginPath();
      x.roundRect(ex - er * 1.1, eyy - er * 0.28, er * 2.2, er * 0.56, er * 0.28);
      x.fill();
    } else if (eyeStyle === 2) {
      x.strokeStyle = pal.ink;
      x.lineWidth = size * 0.036;
      x.beginPath();
      x.moveTo(ex - er * 0.7, eyy - er * 0.7);
      x.lineTo(ex + er * 0.7, eyy + er * 0.7);
      x.moveTo(ex + er * 0.7, eyy - er * 0.7);
      x.lineTo(ex - er * 0.7, eyy + er * 0.7);
      x.stroke();
      x.strokeStyle = pal.dark;
      x.lineWidth = size * 0.032;
    } else {
      x.fillStyle = pal.ink;
      x.beginPath();
      x.arc(ex, eyy, er * 0.55, 0, TAU);
      x.fill();
    }
    if (brow === 1 || brow === 2) {
      x.strokeStyle = pal.ink;
      x.lineWidth = size * 0.04;
      x.beginPath();
      const d = ex < cx ? 1 : -1,
        up = brow === 1;
      x.moveTo(ex - d * er * 1.1, eyy - er * (up ? 1.7 : 1.0));
      x.lineTo(ex + d * er * 0.9, eyy - er * (up ? 1.0 : 1.7));
      x.stroke();
      x.strokeStyle = pal.dark;
      x.lineWidth = size * 0.032;
    }
  });
  const my = cy + r * 0.42;
  x.strokeStyle = pal.ink;
  x.lineWidth = size * 0.04;
  x.beginPath();
  if (mouth === 1) {
    x.arc(cx, my - r * 0.15, r * 0.32, 0.25 * Math.PI, 0.75 * Math.PI);
    x.stroke();
  } else if (mouth === 2) {
    x.arc(cx, my + r * 0.3, r * 0.32, 1.25 * Math.PI, 1.75 * Math.PI);
    x.stroke();
  } else if (mouth === 3) {
    x.moveTo(cx - r * 0.3, my);
    x.lineTo(cx + r * 0.3, my);
    x.stroke();
  } else if (mouth === 4) {
    x.moveTo(cx - r * 0.4, my);
    for (let i = 1; i <= 4; i++)
      x.lineTo(cx - r * 0.4 + i * r * 0.2, my + (i % 2 ? r * 0.13 : -r * 0.13));
    x.stroke();
  } else if (mouth === 5) {
    x.fillStyle = pal.ink;
    x.beginPath();
    x.ellipse(cx, my, r * 0.16, r * 0.22, 0, 0, TAU);
    x.fill();
  }
  if (acc === 1) {
    x.fillStyle = pal.accent;
    x.save();
    outline();
    x.clip();
    x.fillRect(cx - r * 1.3, cy + r * 0.7, r * 2.6, r * 0.22);
    x.restore();
  } else if (acc === 2) {
    x.fillStyle = pal.light;
    x.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU - Math.PI / 2,
        rr = i % 2 ? r * 0.07 : r * 0.16;
      x.lineTo(cx + r * 0.62 + Math.cos(a) * rr, cy + r * 0.25 + Math.sin(a) * rr);
    }
    x.closePath();
    x.fill();
  }
  return pal.baseHex;
}

/* ------------------------------------------------------------- storage */

function validRun(run: unknown, grid: number): run is VoxelRun {
  return (
    Array.isArray(run) &&
    run.length === 4 &&
    Number.isInteger(run[0]) &&
    Number.isInteger(run[1]) &&
    Number.isInteger(run[2]) &&
    run[0] >= 0 &&
    run[1] >= 0 &&
    run[2] >= 1 &&
    run[0] + run[2] <= grid &&
    run[1] < grid &&
    typeof run[3] === 'string' &&
    HEX.test(run[3])
  );
}

/** Validates an untrusted record (localStorage is user-editable). */
export function parseLook(value: unknown): AgentLook | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const grid = o.grid;
  if (o.v !== 1 || typeof o.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(o.id)) return null;
  if (typeof o.name !== 'string' || typeof o.img !== 'string') return null;
  if (!/^data:image\/png;base64,/.test(o.img) || o.img.length > 1_200_000) return null;
  if (typeof o.bg !== 'string' || !HEX.test(o.bg) || typeof o.hue !== 'string' || !HEX.test(o.hue))
    return null;
  if (!Number.isInteger(grid) || (grid as number) < 8 || (grid as number) > 64) return null;
  if (!Array.isArray(o.runs) || o.runs.length > 4096) return null;
  if (!o.runs.every((run) => validRun(run, grid as number))) return null;
  return {
    v: 1,
    id: o.id,
    name: cleanName(o.name),
    img: o.img,
    bg: o.bg,
    hue: o.hue,
    grid: grid as number,
    runs: o.runs as VoxelRun[],
    updated: typeof o.updated === 'number' ? o.updated : 0,
  };
}

export const cleanName = (name: string): string =>
  name
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 12) || '我的 Agent';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const browserStorage = (): StorageLike | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function loadLibrary(storage: StorageLike | null = browserStorage()): AgentLibrary {
  const empty: AgentLibrary = { agents: [], slots: [null, null] };
  if (!storage) return empty;
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as Record<
      string,
      unknown
    > | null;
    if (!raw || typeof raw !== 'object') return empty;
    const agents = (Array.isArray(raw.agents) ? raw.agents : [])
      .map(parseLook)
      .filter((look): look is AgentLook => !!look)
      .slice(0, MAX_AGENTS);
    const ids = new Set(agents.map((agent) => agent.id));
    const slots = [0, 1].map((i) => {
      const slot = Array.isArray(raw.slots) ? raw.slots[i] : null;
      return typeof slot === 'string' && ids.has(slot) ? slot : null;
    });
    return { agents, slots };
  } catch {
    return empty;
  }
}

/** Returns false when storage is unavailable or full; callers keep the in-memory copy. */
export function saveLibrary(
  library: AgentLibrary,
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ agents: library.agents.slice(0, MAX_AGENTS), slots: library.slots }),
    );
    return true;
  } catch {
    return false;
  }
}

export function upsertLook(library: AgentLibrary, look: AgentLook): AgentLibrary {
  const agents = [look, ...library.agents.filter((agent) => agent.id !== look.id)].slice(
    0,
    MAX_AGENTS,
  );
  const ids = new Set(agents.map((agent) => agent.id));
  return { agents, slots: library.slots.map((slot) => (slot && ids.has(slot) ? slot : null)) };
}

export function removeLook(library: AgentLibrary, id: string): AgentLibrary {
  return {
    agents: library.agents.filter((agent) => agent.id !== id),
    slots: library.slots.map((slot) => (slot === id ? null : slot)),
  };
}

export const newLookId = (): string =>
  `agent-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
