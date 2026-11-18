import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dacos, datan, datan2, dcos, dsin } from '../src/core/dmath';

const bits = new DataView(new ArrayBuffer(8));
/** Distance in units in the last place between two finite doubles. */
function ulps(a: number, b: number): number {
  if (Object.is(a, b)) return 0;
  const ordered = (x: number) => {
    bits.setFloat64(0, x);
    const n = bits.getBigInt64(0);
    return n < 0n ? -(n & 0x7fffffffffffffffn) : n;
  };
  const d = ordered(a) - ordered(b);
  return Number(d < 0n ? -d : d);
}
/** Deterministic inputs: game-scale angles, tiny values and quadrant edges. */
function samples(count: number, scale: number): number[] {
  let seed = 0x9e3779b9;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    out.push(((seed / 2 ** 32) * 2 - 1) * scale);
  }
  return out;
}
const SPECIAL = [
  0,
  -0,
  1e-300,
  -1e-300,
  2 ** -30,
  Math.PI / 4,
  Math.PI / 2,
  Math.PI,
  -Math.PI,
  2 * Math.PI,
  100,
  -1000.5,
  1e6,
];

describe('deterministic trigonometry', () => {
  it('stays within 1 ulp of the engine on game-scale inputs', () => {
    for (const x of [...samples(100000, 40), ...samples(20000, 1e5), ...SPECIAL]) {
      expect(ulps(dsin(x), Math.sin(x)), `sin ${x}`).toBeLessThanOrEqual(1);
      expect(ulps(dcos(x), Math.cos(x)), `cos ${x}`).toBeLessThanOrEqual(1);
      expect(ulps(datan(x), Math.atan(x)), `atan ${x}`).toBeLessThanOrEqual(1);
    }
    const ys = samples(50000, 30),
      xs = samples(50001, 30).slice(1);
    ys.forEach((y, i) =>
      expect(
        ulps(datan2(y, xs[i]), Math.atan2(y, xs[i])),
        `atan2 ${y},${xs[i]}`,
      ).toBeLessThanOrEqual(1),
    );
    for (const x of [...samples(50000, 1), -1, 1, 0.5, -0.5, 0.49999999, 1e-20])
      expect(ulps(dacos(x), Math.acos(x)), `acos ${x}`).toBeLessThanOrEqual(1);
  });

  it('handles IEEE edge cases like the platform libm', () => {
    expect(Object.is(dsin(-0), -0)).toBe(true);
    expect(dcos(0)).toBe(1);
    expect(dsin(NaN)).toBeNaN();
    expect(dcos(Infinity)).toBeNaN();
    expect(Object.is(datan2(-0, 1), -0)).toBe(true);
    expect(datan2(0, -1)).toBe(Math.PI);
    expect(datan2(-0, -1)).toBe(-Math.PI);
    expect(datan2(1, 0)).toBe(Math.PI / 2);
    expect(datan2(Infinity, -Infinity)).toBe((3 * Math.PI) / 4);
    expect(datan2(NaN, 1)).toBeNaN();
    expect(dacos(1)).toBe(0);
    expect(dacos(-1)).toBe(Math.PI);
    expect(dacos(1.0000001)).toBeNaN();
  });

  it('produces exactly these bits in every engine', () => {
    const hash = createHash('sha256');
    const out = new Float64Array(5);
    for (const x of samples(20000, 50)) {
      out.set([dsin(x), dcos(x), datan(x), datan2(x, x * 0.37 - 1.5), dacos(x / 50)]);
      hash.update(new Uint8Array(out.buffer));
    }
    // Changing any of these functions changes the simulation: bump SIMULATION_VERSION too.
    expect(hash.digest('hex')).toBe(
      'a5bb1a0030a117feefccca32ceef15fa44b34804aabd4ed960a3092344570a58',
    );
  });
});
