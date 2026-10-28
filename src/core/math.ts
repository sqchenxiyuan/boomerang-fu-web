export interface Vec2 {
  x: number;
  y: number;
}
export const v = (x = 0, y = 0): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => v(a.x + b.x, a.y + b.y);
export const sub = (a: Vec2, b: Vec2): Vec2 => v(a.x - b.x, a.y - b.y);
export const mul = (a: Vec2, n: number): Vec2 => v(a.x * n, a.y * n);
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec2, b: Vec2): number => length(sub(a, b));
export const normalize = (a: Vec2): Vec2 => (length(a) > 0.00001 ? mul(a, 1 / length(a)) : v());
export const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpV = (a: Vec2, b: Vec2, t: number): Vec2 => v(lerp(a.x, b.x, t), lerp(a.y, b.y, t));
export const rotate = (p: Vec2, angle: number): Vec2 =>
  v(p.x * Math.cos(angle) - p.y * Math.sin(angle), p.x * Math.sin(angle) + p.y * Math.cos(angle));
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const reflect = (dir: Vec2, normal: Vec2): Vec2 =>
  sub(dir, mul(normal, 2 * dot(dir, normal)));
export const clampLength = (a: Vec2, max: number): Vec2 =>
  length(a) > max ? mul(normalize(a), max) : a;
export const angleBetween = (a: Vec2, b: Vec2): number => Math.atan2(cross(a, b), dot(a, b));

export class Random {
  constructor(public seed: number) {
    this.seed = seed >>> 0;
  }
  next(): number {
    this.seed += 0x6d2b79f5;
    let t = Math.imul(this.seed ^ (this.seed >>> 15), 1 | this.seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return lerp(min, max, this.next());
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}
