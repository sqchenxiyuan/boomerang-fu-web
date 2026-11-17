import * as THREE from 'three';

/*
 * Mesh → voxel converter for the pixel-art style. Every triangle is scan-converted
 * onto a cubic grid (a conservative surface voxelisation); each cube face takes
 * the material of the source triangle best aligned with it, so walls keep their
 * cap colour on top and floors keep grass above earth. Hidden faces between
 * neighbours are culled. Groups keep the source material indices, so material
 * swaps, tints and visibility toggles made by the renderer keep working.
 */
/** Cells pack into 32 bits: x and z in ±1024, y in ±512. */
const OFFSET = 1024,
  OFFSET_Y = 512;
const keyOf = (x: number, y: number, z: number): number =>
  (((x + OFFSET) << 21) | ((y + OFFSET_Y) << 11) | (z + OFFSET)) >>> 0;

/** Sparse voxel grid with per-face material choice and averaged vertex colour. */
class VoxelGrid {
  // Open-addressing hash from packed key (+1, 0 = empty) to cell index.
  private slots = 1 << 16;
  private shift = 16;
  private keys = new Uint32Array(this.slots);
  private values = new Int32Array(this.slots);
  private capacity = 16384;
  count = 0;
  coords = new Int32Array(this.capacity * 3);
  materials = new Int16Array(this.capacity * 6);
  scores = new Float32Array(this.capacity * 6);
  colors = new Float32Array(this.capacity * 4);

  private find(key: number): number {
    const mask = this.slots - 1;
    // Multiplicative hashing keeps the high bits, which mix every coordinate.
    let slot = Math.imul(key, 0x9e3779b1) >>> this.shift;
    while (this.keys[slot] !== 0 && this.keys[slot] !== key + 1) slot = (slot + 1) & mask;
    return slot;
  }

  private rehash(): void {
    const keys = this.keys,
      values = this.values;
    this.slots *= 2;
    this.shift--;
    this.keys = new Uint32Array(this.slots);
    this.values = new Int32Array(this.slots);
    for (let i = 0; i < keys.length; i++)
      if (keys[i]) {
        const slot = this.find(keys[i] - 1);
        this.keys[slot] = keys[i];
        this.values[slot] = values[i];
      }
  }

  private grow(): void {
    this.capacity *= 2;
    const coords = new Int32Array(this.capacity * 3),
      materials = new Int16Array(this.capacity * 6),
      scores = new Float32Array(this.capacity * 6),
      colors = new Float32Array(this.capacity * 4);
    coords.set(this.coords);
    materials.set(this.materials);
    scores.set(this.scores);
    colors.set(this.colors);
    this.coords = coords;
    this.materials = materials;
    this.scores = scores;
    this.colors = colors;
  }

  add(
    x: number,
    y: number,
    z: number,
    dirs: readonly number[],
    material: number,
    color: THREE.Color | null,
  ): void {
    if (
      x <= -OFFSET ||
      x >= OFFSET ||
      z <= -OFFSET ||
      z >= OFFSET ||
      y <= -OFFSET_Y ||
      y >= OFFSET_Y
    )
      return;
    const key = keyOf(x, y, z);
    let slot = this.find(key);
    let cell: number;
    if (this.keys[slot]) cell = this.values[slot];
    else {
      if (this.count === this.capacity) this.grow();
      if (this.count * 2 >= this.slots) {
        this.rehash();
        slot = this.find(key);
      }
      cell = this.count++;
      this.keys[slot] = key + 1;
      this.values[slot] = cell;
      this.coords[cell * 3] = x;
      this.coords[cell * 3 + 1] = y;
      this.coords[cell * 3 + 2] = z;
      this.materials.fill(material, cell * 6, cell * 6 + 6);
      this.scores.fill(-Infinity, cell * 6, cell * 6 + 6);
    }
    for (let d = 0; d < 6; d++)
      if (dirs[d] > this.scores[cell * 6 + d]) {
        this.scores[cell * 6 + d] = dirs[d];
        this.materials[cell * 6 + d] = material;
      }
    if (color) {
      this.colors[cell * 4] += color.r;
      this.colors[cell * 4 + 1] += color.g;
      this.colors[cell * 4 + 2] += color.b;
      this.colors[cell * 4 + 3]++;
    }
  }
}

const va = new THREE.Vector3(),
  vb = new THREE.Vector3(),
  vc = new THREE.Vector3(),
  edge1 = new THREE.Vector3(),
  edge2 = new THREE.Vector3(),
  normal = new THREE.Vector3(),
  sampled = new THREE.Color(),
  ca = new THREE.Color(),
  cb = new THREE.Color(),
  cc = new THREE.Color();

/**
 * Conservative scan conversion of one triangle given in grid units. The triangle
 * is walked over its dominant plane; for each touched column the plane's depth
 * range picks the cells. Surfaces lying exactly on a cell boundary go to the
 * cell behind them (inside the solid), so a floor top at y = 0 stays at y = 0.
 */
function rasterize(
  grid: VoxelGrid,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  material: number,
  colors: [THREE.Color, THREE.Color, THREE.Color] | null,
  limits: readonly [number, number][] | null,
  skipDown: boolean,
  hole: readonly [number, number, number, number] | null,
): void {
  edge1.subVectors(b, a);
  edge2.subVectors(c, a);
  normal.crossVectors(edge1, edge2);
  const area = normal.length();
  if (area < 1e-9) return;
  normal.divideScalar(area);
  if (skipDown && normal.y < -0.7) return;
  const n = [normal.x, normal.y, normal.z];
  const dirs = [n[0], -n[0], n[1], -n[1], n[2], -n[2]];
  const k =
    Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2])
      ? 0
      : Math.abs(n[1]) >= Math.abs(n[2])
        ? 1
        : 2;
  const i = (k + 1) % 3,
    j = (k + 2) % 3;
  const P = [a.toArray(), b.toArray(), c.toArray()];
  const d = n[0] * P[0][0] + n[1] * P[0][1] + n[2] * P[0][2];
  const bias = Math.sign(n[k]) * 1e-3;
  let minI = Math.floor(Math.min(P[0][i], P[1][i], P[2][i]) - 1e-6),
    maxI = Math.floor(Math.max(P[0][i], P[1][i], P[2][i]) + 1e-6),
    minJ = Math.floor(Math.min(P[0][j], P[1][j], P[2][j]) - 1e-6),
    maxJ = Math.floor(Math.max(P[0][j], P[1][j], P[2][j]) + 1e-6);
  if (limits) {
    minI = Math.max(minI, limits[i][0]);
    maxI = Math.min(maxI, limits[i][1]);
    minJ = Math.max(minJ, limits[j][0]);
    maxJ = Math.min(maxJ, limits[j][1]);
    if (minI > maxI || minJ > maxJ) return;
  }
  const minK = Math.min(P[0][k], P[1][k], P[2][k]),
    maxK = Math.max(P[0][k], P[1][k], P[2][k]);
  // 2D edge functions in the (i, j) projection, oriented so the inside is positive.
  const orient =
    (P[1][i] - P[0][i]) * (P[2][j] - P[0][j]) - (P[1][j] - P[0][j]) * (P[2][i] - P[0][i]) >= 0
      ? 1
      : -1;
  const edges = [0, 1, 2].map((e) => {
    const p = P[e],
      q = P[(e + 1) % 3];
    const ex = (q[i] - p[i]) * orient,
      ey = (q[j] - p[j]) * orient;
    // E(x, y) = (x - p.i) * ey' ... written as A x + B y + C with inside ≥ 0.
    const A = -ey,
      B = ex,
      C = -(A * p[i] + B * p[j]);
    const reach = Math.abs(A) + Math.abs(B);
    // A column that only touches the edge (zero-area overlap) is outside.
    return { A, B, C, slack: 0.5 * reach - 1e-6 * reach };
  });
  const area2 = Math.abs(
    (P[1][i] - P[0][i]) * (P[2][j] - P[0][j]) - (P[1][j] - P[0][j]) * (P[2][i] - P[0][i]),
  );
  const flat = Math.abs(n[k]) < 1e-6;
  const cell = [0, 0, 0];
  for (let ci = minI; ci <= maxI; ci++)
    for (let cj = minJ; cj <= maxJ; cj++) {
      const x = ci + 0.5,
        y = cj + 0.5;
      let inside = true;
      for (const e of edges)
        if (e.A * x + e.B * y + e.C + e.slack <= 0) {
          inside = false;
          break;
        }
      if (!inside) continue;
      // Depth range of the plane over this column, clamped to the triangle.
      let low = minK,
        high = maxK;
      if (!flat) {
        // The plane is linear, so its extremes over the column are at two corners.
        const base = (d - n[i] * ci - n[j] * cj) / n[k],
          di = -n[i] / n[k],
          dj = -n[j] / n[k];
        low = Math.max(minK, base + Math.min(0, di) + Math.min(0, dj));
        high = Math.min(maxK, base + Math.max(0, di) + Math.max(0, dj));
        if (low > high) low = high = Math.min(maxK, Math.max(minK, (low + high) / 2));
      }
      let color: THREE.Color | null = null;
      if (colors) {
        // Barycentric weights of the column centre, clamped onto the triangle.
        const w0 = Math.max(0, edges[1].A * x + edges[1].B * y + edges[1].C) / (area2 || 1),
          w1 = Math.max(0, edges[2].A * x + edges[2].B * y + edges[2].C) / (area2 || 1),
          w2 = Math.max(0, edges[0].A * x + edges[0].B * y + edges[0].C) / (area2 || 1),
          sum = w0 + w1 + w2 || 1;
        sampled.setRGB(
          (colors[0].r * w0 + colors[1].r * w1 + colors[2].r * w2) / sum,
          (colors[0].g * w0 + colors[1].g * w1 + colors[2].g * w2) / sum,
          (colors[0].b * w0 + colors[1].b * w1 + colors[2].b * w2) / sum,
        );
        color = sampled;
      }
      let from = Math.floor(low - bias),
        to = Math.floor(high - bias);
      if (limits) {
        from = Math.max(from, limits[k][0]);
        to = Math.min(to, limits[k][1]);
      }
      for (let ck = from; ck <= to; ck++) {
        cell[i] = ci;
        cell[j] = cj;
        cell[k] = ck;
        if (
          hole &&
          cell[0] >= hole[0] &&
          cell[0] <= hole[1] &&
          cell[2] >= hole[2] &&
          cell[2] <= hole[3]
        )
          continue;
        grid.add(cell[0], cell[1], cell[2], dirs, material, color);
      }
    }
}

export interface VoxelSource {
  geometry: THREE.BufferGeometry;
  /** Source geometry → target frame (before division by the cell size). */
  matrix?: THREE.Matrix4;
  /** Target material index for each source group material index. */
  materialMap: (sourceIndex: number) => number;
  /** Sample the source vertex colours. */
  vertexColors: boolean;
}

export interface VoxelBuildOptions {
  /** Cell size per axis, in target-frame units. */
  cell: THREE.Vector3;
  /** Write a colour attribute from the sampled vertex colours. */
  colorAttribute?: boolean;
  /** Only cells inside this box (target frame) are produced. */
  bounds?: THREE.Box3;
  /** Drop downward faces, which a top-down camera never sees. */
  cullDown?: boolean;
  /** Skip cells whose x/z fall inside this box (another pass covers it). */
  hole?: THREE.Box3;
}

const hash01 = (x: number, y: number, z: number): number => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Voxelise sources into one geometry in the target frame; null when nothing is left. */
export function buildVoxelGeometry(
  sources: readonly VoxelSource[],
  options: VoxelBuildOptions,
): THREE.BufferGeometry | null {
  const grid = new VoxelGrid();
  const inverseCell = new THREE.Vector3(1 / options.cell.x, 1 / options.cell.y, 1 / options.cell.z);
  const limits = options.bounds
    ? ([0, 1, 2].map((axis) => [
        Math.floor(options.bounds!.min.getComponent(axis) * inverseCell.getComponent(axis)),
        Math.floor(options.bounds!.max.getComponent(axis) * inverseCell.getComponent(axis)),
      ]) as [number, number][])
    : null;
  const hole = options.hole
    ? ([
        Math.ceil(options.hole.min.x * inverseCell.x),
        Math.floor(options.hole.max.x * inverseCell.x) - 1,
        Math.ceil(options.hole.min.z * inverseCell.z),
        Math.floor(options.hole.max.z * inverseCell.z) - 1,
      ] as const)
    : null;
  for (const source of sources) {
    const geometry = source.geometry;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!position) continue;
    const color = source.vertexColors
      ? (geometry.getAttribute('color') as THREE.BufferAttribute | undefined)
      : undefined;
    const index = geometry.getIndex();
    const total = index ? index.count : position.count;
    const groups = geometry.groups.length
      ? geometry.groups
      : [{ start: 0, count: total, materialIndex: 0 }];
    const vertex = (target: THREE.Vector3, at: number) => {
      target.fromBufferAttribute(position, at);
      if (source.matrix) target.applyMatrix4(source.matrix);
      return target.multiply(inverseCell);
    };
    for (const group of groups) {
      const material = source.materialMap(group.materialIndex ?? 0);
      if (material < 0) continue;
      const end = Math.min(total, group.start + group.count);
      for (let t = group.start; t + 2 < end + 0; t += 3) {
        const ia = index ? index.getX(t) : t,
          ib = index ? index.getX(t + 1) : t + 1,
          ic = index ? index.getX(t + 2) : t + 2;
        vertex(va, ia);
        vertex(vb, ib);
        vertex(vc, ic);
        rasterize(
          grid,
          va,
          vb,
          vc,
          material,
          color
            ? [
                ca.fromBufferAttribute(color, ia),
                cb.fromBufferAttribute(color, ib),
                cc.fromBufferAttribute(color, ic),
              ]
            : null,
          limits,
          options.cullDown === true,
          hole,
        );
      }
    }
  }
  if (!grid.count) return null;
  return greedyMesh(grid, options);
}

const TRIANGLE_CORNERS = [0, 1, 2, 0, 2, 3];

/** Growable vertex stream: position(3) normal(3) uv(2) colour(3). */
class VertexBuffer {
  data = new Float32Array(11 * 6 * 256);
  length = 0;
  reserve(extra: number): void {
    if (this.length + extra <= this.data.length) return;
    const next = new Float32Array(Math.max(this.data.length * 2, this.length + extra));
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}

/** Quantised cell colour (5 bits per channel), or -1 without samples. */
function cellColor(grid: VoxelGrid, cell: number): number {
  const n = grid.colors[cell * 4 + 3];
  if (!n) return -1;
  const q = (value: number) => Math.max(0, Math.min(31, Math.round((value / n) * 31)));
  return (
    (q(grid.colors[cell * 4]) << 10) |
    (q(grid.colors[cell * 4 + 1]) << 5) |
    q(grid.colors[cell * 4 + 2])
  );
}

/**
 * Greedy meshing: per direction and slice, visible faces with the same material
 * and colour merge into rectangles. UVs are in cell units, so a 1-texel-per-cell
 * texture gives every cube its own shade without extra geometry.
 */
function greedyMesh(grid: VoxelGrid, options: VoxelBuildOptions): THREE.BufferGeometry {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let cell = 0; cell < grid.count; cell++)
    for (let axis = 0; axis < 3; axis++) {
      const value = grid.coords[cell * 3 + axis];
      if (value < lo[axis]) lo[axis] = value;
      if (value > hi[axis]) hi[axis] = value;
    }
  const dims = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  const occupancy = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const at = (x: number, y: number, z: number) => (x * dims[1] + y) * dims[2] + z;
  for (let cell = 0; cell < grid.count; cell++)
    occupancy[
      at(
        grid.coords[cell * 3] - lo[0],
        grid.coords[cell * 3 + 1] - lo[1],
        grid.coords[cell * 3 + 2] - lo[2],
      )
    ] = 1;
  const colored = options.colorAttribute === true;
  const colors = colored
    ? new Int32Array(grid.count).map((_, cell) => cellColor(grid, cell))
    : null;
  const buckets = new Map<number, VertexBuffer>();
  const visible = new Int32Array(grid.count);
  const flat = new Int32Array(grid.count * 3);
  const sliceCounts = new Int32Array(Math.max(dims[0], dims[1], dims[2]) + 1);
  const quad: number[] = new Array(12);
  let mask = new Float64Array(1024);
  for (let d = 0; d < 6; d++) {
    if (d === 3 && options.cullDown) continue;
    const a = d >> 1,
      sign = d % 2 === 0 ? 1 : -1,
      u = (a + 1) % 3,
      v = (a + 2) % 3;
    const step = a === 0 ? dims[1] * dims[2] : a === 1 ? dims[2] : 1;
    const nx = d === 0 ? 1 : d === 1 ? -1 : 0,
      ny = d === 2 ? 1 : d === 3 ? -1 : 0,
      nz = d === 4 ? 1 : d === 5 ? -1 : 0;
    const emit = (
      slice: number,
      cu: number,
      cv: number,
      columns: number,
      rows: number,
      key: number,
    ): void => {
      // Corners in (u, v) order, counter-clockwise from outside.
      const plane = slice + lo[a] + (sign > 0 ? 1 : 0);
      const u0 = cu + lo[u],
        v0 = cv + lo[v],
        u1 = u0 + columns,
        v1 = v0 + rows;
      for (let n = 0; n < 4; n++) quad[n * 3 + a] = plane;
      // (u0,v0) (u1,v0) (u1,v1) (u0,v1) seen from +a; mirrored order for −a.
      const second = sign > 0 ? 1 : 3,
        fourth = sign > 0 ? 3 : 1;
      quad[u] = u0;
      quad[v] = v0;
      quad[second * 3 + u] = u1;
      quad[second * 3 + v] = v0;
      quad[6 + u] = u1;
      quad[6 + v] = v1;
      quad[fourth * 3 + u] = u0;
      quad[fourth * 3 + v] = v1;
      const material = Math.floor(key / 65536) - 1;
      let bucket = buckets.get(material);
      if (!bucket) buckets.set(material, (bucket = new VertexBuffer()));
      bucket.reserve(66);
      // position(3) normal(3) uv(2) colour(3) per vertex, two triangles.
      const color = (key % 65536) - 1;
      const r = color < 0 ? 1 : ((color >> 10) & 31) / 31,
        g = color < 0 ? 1 : ((color >> 5) & 31) / 31,
        b = color < 0 ? 1 : (color & 31) / 31;
      const out = bucket.data;
      for (let corner = 0; corner < 6; corner++) {
        const n = TRIANGLE_CORNERS[corner],
          o = bucket.length;
        out[o] = quad[n * 3];
        out[o + 1] = quad[n * 3 + 1];
        out[o + 2] = quad[n * 3 + 2];
        out[o + 3] = nx;
        out[o + 4] = ny;
        out[o + 5] = nz;
        out[o + 6] = quad[n * 3 + u];
        out[o + 7] = quad[n * 3 + v];
        out[o + 8] = r;
        out[o + 9] = g;
        out[o + 10] = b;
        bucket.length += 11;
      }
    };
    // Visible faces, counting-sorted by slice into one flat [iu, iv, key] array.
    let visibleCount = 0;
    sliceCounts.fill(0, 0, dims[a] + 1);
    for (let cell = 0; cell < grid.count; cell++) {
      const x = grid.coords[cell * 3] - lo[0],
        y = grid.coords[cell * 3 + 1] - lo[1],
        z = grid.coords[cell * 3 + 2] - lo[2];
      const along = a === 0 ? x : a === 1 ? y : z;
      const next = along + sign;
      if (next >= 0 && next < dims[a] && occupancy[at(x, y, z) + sign * step] > 0) continue;
      visible[visibleCount++] = cell;
      sliceCounts[along + 1]++;
    }
    for (let i = 1; i <= dims[a]; i++) sliceCounts[i] += sliceCounts[i - 1];
    const cursor = sliceCounts.slice(0, dims[a]);
    for (let n = 0; n < visibleCount; n++) {
      const cell = visible[n];
      const x = grid.coords[cell * 3] - lo[0],
        y = grid.coords[cell * 3 + 1] - lo[1],
        z = grid.coords[cell * 3 + 2] - lo[2];
      const along = a === 0 ? x : a === 1 ? y : z;
      const color = colors ? colors[cell] : -1;
      const o = cursor[along]++ * 3;
      flat[o] = u === 0 ? x : u === 1 ? y : z;
      flat[o + 1] = v === 0 ? x : v === 1 ? y : z;
      flat[o + 2] = (grid.materials[cell * 6 + d] + 1) * 65536 + (color + 1);
    }
    for (let slice = 0; slice < dims[a]; slice++) {
      const begin = sliceCounts[slice] * 3,
        end = sliceCounts[slice + 1] * 3;
      if (begin === end) continue;
      const faces = flat.subarray(begin, end);
      let minU = Infinity,
        maxU = -Infinity,
        minV = Infinity,
        maxV = -Infinity;
      for (let f = 0; f < faces.length; f += 3) {
        if (faces[f] < minU) minU = faces[f];
        if (faces[f] > maxU) maxU = faces[f];
        if (faces[f + 1] < minV) minV = faces[f + 1];
        if (faces[f + 1] > maxV) maxV = faces[f + 1];
      }
      const width = maxU - minU + 1,
        height = maxV - minV + 1,
        count = faces.length / 3;
      // Sparse slices (thin walls, scattered props) merge through a hash map;
      // dense ones (floors) through a flat mask over their bounding rectangle.
      if (width * height > count * 6) {
        const open = new Map<number, number>();
        for (let f = 0; f < faces.length; f += 3)
          open.set((faces[f] - minU) * height + faces[f + 1] - minV, faces[f + 2]);
        const order = Int32Array.from(open.keys()).sort();
        for (const start of order) {
          const key = open.get(start);
          if (key === undefined) continue;
          const iu = Math.floor(start / height),
            iv = start - iu * height;
          let rows = 1;
          while (iv + rows < height && open.get(start + rows) === key) rows++;
          let columns = 1;
          grow: while (iu + columns < width) {
            for (let k = 0; k < rows; k++)
              if (open.get(start + columns * height + k) !== key) break grow;
            columns++;
          }
          for (let w = 0; w < columns; w++)
            for (let k = 0; k < rows; k++) open.delete(start + w * height + k);
          emit(slice, iu + minU, iv + minV, columns, rows, key);
        }
        continue;
      }
      if (mask.length < width * height) mask = new Float64Array(width * height * 2);
      mask.fill(0, 0, width * height);
      for (let f = 0; f < faces.length; f += 3)
        mask[(faces[f] - minU) * height + faces[f + 1] - minV] = faces[f + 2];
      for (let iu = 0; iu < width; iu++)
        for (let iv = 0; iv < height; ) {
          const key = mask[iu * height + iv];
          if (!key) {
            iv++;
            continue;
          }
          let rows = 1;
          while (iv + rows < height && mask[iu * height + iv + rows] === key) rows++;
          let columns = 1;
          grow: while (iu + columns < width) {
            for (let k = 0; k < rows; k++)
              if (mask[(iu + columns) * height + iv + k] !== key) break grow;
            columns++;
          }
          for (let w = 0; w < columns; w++)
            for (let k = 0; k < rows; k++) mask[(iu + w) * height + iv + k] = 0;
          emit(slice, iu + minU, iv + minV, columns, rows, key);
          iv += rows;
        }
    }
  }
  const STRIDE = 11;
  let vertices = 0;
  for (const bucket of buckets.values()) vertices += bucket.length / STRIDE;
  const positions = new Float32Array(vertices * 3),
    normals = new Float32Array(vertices * 3),
    uvs = new Float32Array(vertices * 2),
    colorData = colored ? new Float32Array(vertices * 3) : null;
  const geometry = new THREE.BufferGeometry();
  let offset = 0;
  for (const [material, bucket] of [...buckets].sort((p, q) => p[0] - q[0])) {
    const count = bucket.length / STRIDE,
      data = bucket.data;
    for (let n = 0; n < count; n++) {
      const src = n * STRIDE,
        vertex = offset + n;
      positions[vertex * 3] = data[src] * options.cell.x;
      positions[vertex * 3 + 1] = data[src + 1] * options.cell.y;
      positions[vertex * 3 + 2] = data[src + 2] * options.cell.z;
      normals[vertex * 3] = data[src + 3];
      normals[vertex * 3 + 1] = data[src + 4];
      normals[vertex * 3 + 2] = data[src + 5];
      uvs[vertex * 2] = data[src + 6];
      uvs[vertex * 2 + 1] = data[src + 7];
      if (colorData) {
        colorData[vertex * 3] = data[src + 8];
        colorData[vertex * 3 + 1] = data[src + 9];
        colorData[vertex * 3 + 2] = data[src + 10];
      }
    }
    geometry.addGroup(offset, count, material);
    offset += count;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (colorData) geometry.setAttribute('color', new THREE.BufferAttribute(colorData, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/* ------------------------------------------------------------------ helpers */

const materialsOf = (mesh: THREE.Mesh): THREE.Material[] =>
  Array.isArray(mesh.material) ? mesh.material : [mesh.material];

/** Concatenate two voxel geometries, regrouping by material index. */
function mergeVoxelGeometries(
  a: THREE.BufferGeometry | null,
  b: THREE.BufferGeometry | null,
  materials: number,
): THREE.BufferGeometry | null {
  if (!a || !b) return a ?? b;
  const names = Object.keys(a.attributes).filter((name) => b.getAttribute(name));
  const out = new THREE.BufferGeometry();
  const total = a.getAttribute('position').count + b.getAttribute('position').count;
  const arrays = names.map((name) => new Float32Array(total * a.getAttribute(name).itemSize));
  let offset = 0;
  for (let material = 0; material < materials; material++) {
    const start = offset;
    for (const source of [a, b])
      for (const group of source.groups) {
        if (group.materialIndex !== material) continue;
        names.forEach((name, n) => {
          const attribute = source.getAttribute(name) as THREE.BufferAttribute;
          const size = attribute.itemSize;
          arrays[n].set(
            (attribute.array as Float32Array).subarray(
              group.start * size,
              (group.start + group.count) * size,
            ),
            offset * size,
          );
        });
        offset += group.count;
      }
    if (offset > start) out.addGroup(start, offset - start, material);
  }
  names.forEach((name, n) =>
    out.setAttribute(name, new THREE.BufferAttribute(arrays[n], a.getAttribute(name).itemSize)),
  );
  a.dispose();
  b.dispose();
  out.computeBoundingSphere();
  return out;
}

/** Opaque, standard-lit meshes are converted; glass, glows, shaders and sprites are kept. */
export function voxelEligible(object: THREE.Object3D): object is THREE.Mesh {
  if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh) return false;
  if (object.userData.voxel === 'keep' || object.userData.voxelized) return false;
  const geometry = object.geometry as THREE.BufferGeometry;
  if (!geometry?.getAttribute('position')) return false;
  return materialsOf(object).every(
    (material) =>
      !material.transparent &&
      !(material instanceof THREE.ShaderMaterial) &&
      !(material instanceof THREE.MeshBasicMaterial),
  );
}

const usesVertexColors = (material: THREE.Material): boolean =>
  (material as THREE.MeshStandardMaterial).vertexColors === true;

const shared = new Map<string, THREE.BufferGeometry>();
const worldScale = new THREE.Vector3();

/** Primitive parameters plus bounds: a translated or rotated primitive is a different shape. */
function signature(geometry: THREE.BufferGeometry): string {
  const params = (geometry as { parameters?: unknown }).parameters;
  if (!params || geometry.type === 'BufferGeometry' || /Extrude|Shape/.test(geometry.type))
    return geometry.uuid;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const bounds = [...box.min.toArray(), ...box.max.toArray()].map((v) => v.toFixed(4)).join(',');
  return `${geometry.type}:${JSON.stringify(params)}:${bounds}`;
}

/**
 * Replace a mesh's geometry with voxels in its own local frame, keeping the mesh
 * object, transform, children and materials. Cell size is `size` in world units
 * (the current world scale is compensated per axis). Primitive geometries are
 * cached and shared; shared voxel geometries are never disposed with a view.
 */
export function voxelizeMesh(mesh: THREE.Mesh, size: number): boolean {
  if (!voxelEligible(mesh)) return false;
  mesh.updateWorldMatrix(true, false);
  mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);
  const cell = new THREE.Vector3(
    size / Math.max(1e-6, Math.abs(worldScale.x)),
    size / Math.max(1e-6, Math.abs(worldScale.y)),
    size / Math.max(1e-6, Math.abs(worldScale.z)),
  );
  const materials = materialsOf(mesh);
  const vertexColors = materials.some(usesVertexColors);
  const source = mesh.geometry as THREE.BufferGeometry;
  const key = `${signature(source)}|${cell.toArray().map((v) => v.toFixed(4))}|${vertexColors}|${source.groups.map((g) => g.materialIndex).join(',')}`;
  let geometry = shared.get(key);
  if (!geometry) {
    const built = buildVoxelGeometry(
      [
        {
          geometry: source,
          materialMap: (index) => (Array.isArray(mesh.material) ? index : 0),
          vertexColors,
        },
      ],
      { cell, colorAttribute: vertexColors },
    );
    if (!built) return false;
    geometry = built;
    if (!Array.isArray(mesh.material)) geometry.clearGroups();
    geometry.userData.shared = true;
    shared.set(key, geometry);
  }
  if (!source.userData.shared) source.dispose();
  mesh.geometry = geometry;
  mesh.userData.voxelized = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return true;
}

/** Convert every eligible mesh under `root` in place (see voxelizeMesh). */
export function voxelizeTree(
  root: THREE.Object3D,
  size: number,
  skip: (object: THREE.Object3D) => boolean = () => false,
): number {
  const meshes: THREE.Mesh[] = [];
  const visit = (object: THREE.Object3D) => {
    if (skip(object)) return;
    if (voxelEligible(object)) meshes.push(object);
    for (const child of object.children) visit(child);
  };
  visit(root);
  let converted = 0;
  for (const mesh of meshes) if (voxelizeMesh(mesh, size)) converted++;
  return converted;
}

/**
 * Merge every eligible static mesh under `root` (outside `exclude`) into one
 * voxel mesh on a grid aligned with `root`, so neighbouring pieces share cubes and
 * faces pick the best-matching material across pieces. Materials gain
 * a per-cube shade texture. Returns the new mesh, if any.
 */
export function voxelizeStatic(
  root: THREE.Object3D,
  size: number,
  exclude: ReadonlySet<THREE.Object3D> = new Set(),
  { bounds, detail }: { bounds?: THREE.Box3; detail?: THREE.Box3 } = {},
): THREE.Mesh | null {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  root.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);
  const meshes: THREE.Mesh[] = [];
  const visit = (object: THREE.Object3D) => {
    if (exclude.has(object)) return;
    if (object !== root && voxelEligible(object) && !(object instanceof THREE.InstancedMesh))
      meshes.push(object);
    for (const child of object.children) visit(child);
  };
  visit(root);
  if (!meshes.length) return null;
  const palette: THREE.Material[] = [],
    lookup = new Map<THREE.Material, number>();
  const sources: VoxelSource[] = meshes.map((mesh) => {
    const own = materialsOf(mesh).map((material) => {
      let at = lookup.get(material);
      if (at === undefined) {
        at = palette.length;
        palette.push(material);
        lookup.set(material, at);
      }
      return at;
    });
    return {
      geometry: mesh.geometry as THREE.BufferGeometry,
      matrix: new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld),
      materialMap: (index) => own[Array.isArray(mesh.material) ? index : 0] ?? -1,
      vertexColors: materialsOf(mesh).some(usesVertexColors),
    };
  });
  const cell = new THREE.Vector3(
    size / Math.abs(worldScale.x),
    size / Math.abs(worldScale.y),
    size / Math.abs(worldScale.z),
  );
  const colored = sources.some((source) => source.vertexColors);
  // Level of detail: full resolution inside `detail`, double-size cubes around it.
  // The detail box is snapped to the coarse grid so the two grids meet cleanly.
  let geometry: THREE.BufferGeometry | null;
  if (detail && bounds) {
    const coarse = cell.clone().multiplyScalar(2);
    const snapped = new THREE.Box3(
      new THREE.Vector3(
        Math.floor(detail.min.x / coarse.x) * coarse.x,
        bounds.min.y,
        Math.floor(detail.min.z / coarse.z) * coarse.z,
      ),
      new THREE.Vector3(
        Math.ceil(detail.max.x / coarse.x) * coarse.x,
        bounds.max.y,
        Math.ceil(detail.max.z / coarse.z) * coarse.z,
      ),
    );
    const near = buildVoxelGeometry(sources, {
      cell,
      colorAttribute: colored,
      bounds: snapped.clone().intersect(bounds),
      cullDown: true,
    });
    const far = buildVoxelGeometry(sources, {
      cell: coarse,
      colorAttribute: colored,
      bounds,
      cullDown: true,
      hole: snapped,
    });
    geometry = mergeVoxelGeometries(near, far, palette.length);
  } else
    geometry = buildVoxelGeometry(sources, {
      cell,
      colorAttribute: colored,
      bounds,
      cullDown: true,
    });
  for (const mesh of meshes) {
    mesh.removeFromParent();
    const source = mesh.geometry as THREE.BufferGeometry;
    if (!source.userData.shared) source.dispose();
  }
  if (!geometry) return null;
  // Each material gets a twin with the per-cube shade texture.
  const materials = palette.map((material) => {
    const twin = material.clone() as THREE.MeshStandardMaterial;
    if (!twin.map) twin.map = voxelShadeTexture();
    // Downward faces are culled, so the shadow pass must see the upper faces too.
    twin.shadowSide = THREE.DoubleSide;
    twin.userData.shared = false;
    return twin;
  });
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.name = 'voxel-static';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.voxelized = true;
  root.add(mesh);
  return mesh;
}

let shade: THREE.DataTexture | null = null;
/** One texel per cube: a soft per-voxel lightness variation, repeating every 16 cells. */
export function voxelShadeTexture(): THREE.DataTexture {
  if (shade) return shade;
  const size = 16,
    data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      // Mostly flat, with lighter and darker specks like hand-placed pixels.
      const roll = hash01(x, y, 7);
      const value = Math.round(
        255 * (roll < 0.1 ? 0.8 : roll < 0.3 ? 0.89 : roll > 0.9 ? 1 : 0.95),
      );
      data.set([value, value, value, 255], (y * size + x) * 4);
    }
  shade = new THREE.DataTexture(data, size, size);
  shade.magFilter = shade.minFilter = THREE.NearestFilter;
  shade.wrapS = shade.wrapT = THREE.RepeatWrapping;
  shade.repeat.set(1 / size, 1 / size);
  shade.colorSpace = THREE.SRGBColorSpace;
  shade.needsUpdate = true;
  return shade;
}

let water: THREE.CanvasTexture | null = null;
/** A tiny repeating texture that makes flat water read as pixel art. */
export function pixelWaterTexture(): THREE.CanvasTexture {
  if (water) return water;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  const context = canvas.getContext('2d')!;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const wave = (x + y * 3) % 8 === 0 || (x * 5 + y) % 11 === 0;
      const shade = wave ? 255 : 214 + Math.floor(hash01(x, y, 3) * 26);
      context.fillStyle = `rgb(${shade},${shade},${shade})`;
      context.fillRect(x, y, 1, 1);
    }
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(120, 120);
  water = texture;
  return texture;
}
