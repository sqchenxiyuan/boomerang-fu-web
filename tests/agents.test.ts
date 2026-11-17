import { afterEach, describe, expect, it } from 'vitest';
import {
  VOXEL_GRID,
  cleanName,
  dominantHex,
  loadLibrary,
  parseLook,
  removeLook,
  runBounds,
  saveLibrary,
  traitsFrom,
  upsertLook,
  voxelize,
  type AgentLook,
  type StorageLike,
} from '../src/agents/look';
import {
  actorColor,
  actorName,
  actorToken,
  agentRevision,
  assignAgents,
  clearAgents,
} from '../src/agents/registry';
import {
  AGENT_LAYOUT,
  agentBlocks,
  blocksGeometry,
  createAgentHalves,
} from '../src/rendering/agent-model';
import { ROSTER } from '../src/core/config';

/** A 30 × 30 RGBA image with a red block and a blue row inside it. */
function pixels(paint: (x: number, y: number) => [number, number, number, number] | null) {
  const data = new Uint8ClampedArray(VOXEL_GRID * VOXEL_GRID * 4);
  for (let y = 0; y < VOXEL_GRID; y++)
    for (let x = 0; x < VOXEL_GRID; x++) {
      const p = paint(x, y);
      if (p) data.set(p, (y * VOXEL_GRID + x) * 4);
    }
  return { width: VOXEL_GRID, height: VOXEL_GRID, data };
}
const square = pixels((x, y) =>
  x >= 8 && x <= 19 && y >= 5 && y <= 14
    ? y === 9
      ? [40, 80, 230, 255]
      : [230, 40, 40, 255]
    : null,
);

function look(overrides: Partial<AgentLook> = {}): AgentLook {
  return {
    v: 1,
    id: 'agent-test',
    name: '小方',
    img: 'data:image/png;base64,AAAA',
    bg: '#0b0d0f',
    hue: '#e62828',
    grid: VOXEL_GRID,
    runs: voxelize(square),
    updated: 1,
    ...overrides,
  };
}

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

afterEach(() => clearAgents());

describe('agent voxelisation (MUNDI voxelizeTex)', () => {
  it('turns each opaque row into run-length merged voxels, splitting on colour change', () => {
    const runs = voxelize(square);
    expect(runs).toHaveLength(10);
    expect(runs.every(([x, , w]) => x === 8 && w === 12)).toBe(true);
    expect(runs.find(([, y]) => y === 9)?.[3]).toBe('#2850e6');
    expect(runBounds(runs)).toEqual({ x0: 8, x1: 19, y0: 5, y1: 14 });
  });
  it('ignores translucent pixels and keeps distinct colours apart', () => {
    const stripes = pixels((x, y) =>
      y === 3 ? (x < 10 ? [200, 0, 0, 255] : x < 20 ? [0, 0, 200, 255] : [0, 0, 200, 60]) : null,
    );
    expect(voxelize(stripes)).toEqual([
      [0, 3, 10, '#c80000'],
      [10, 3, 10, '#0000c8'],
    ]);
  });
  it('picks the dominant saturated colour as the body hue', () => {
    // Quantised to 3 bits per channel and re-centred, as in MUNDI: 230 → bin 7 → 255.
    expect(dominantHex(square)).toBe('#ff3636');
    expect(dominantHex(pixels(() => [128, 128, 128, 255]))).toBeNull();
  });
});

describe('agent library storage', () => {
  it('round-trips agents and slots, and drops slots that point at removed agents', () => {
    const storage = new MemoryStorage();
    const library = upsertLook({ agents: [], slots: [null, null] }, look());
    library.slots[0] = 'agent-test';
    expect(saveLibrary(library, storage)).toBe(true);
    const loaded = loadLibrary(storage);
    expect(loaded.agents).toHaveLength(1);
    expect(loaded.slots).toEqual(['agent-test', null]);
    expect(removeLook(loaded, 'agent-test')).toEqual({ agents: [], slots: [null, null] });
  });
  it('rejects tampered records and strips markup from names', () => {
    expect(parseLook(look({ img: 'javascript:alert(1)' }))).toBeNull();
    expect(parseLook(look({ hue: 'red' }))).toBeNull();
    expect(parseLook({ ...look(), runs: [[29, 0, 5, '#ffffff']] })).toBeNull();
    expect(parseLook(look({ name: '<img src=x>坏蛋' }))?.name).toBe('img src=x坏蛋');
    expect(cleanName('   ')).toBe('我的 Agent');
    const storage = new MemoryStorage();
    storage.setItem('boomerang-garden.agents.v1', '{"agents":[{"v":2}],"slots":["ghost"]}');
    expect(loadLibrary(storage)).toEqual({ agents: [], slots: [null, null] });
    storage.setItem('boomerang-garden.agents.v1', 'not json');
    expect(loadLibrary(storage).agents).toEqual([]);
  });
});

describe('preset traits (MUNDI traitsFrom)', () => {
  it('reads colour, species and feature keywords', () => {
    expect(traitsFrom('红色的龙，三只眼')).toMatchObject({ top: 1, mark: 1, eyes: 3, hue: 2 });
    expect(traitsFrom('a calm blue robot')).toMatchObject({ shape: 1, top: 4, hue: 212 });
    expect(traitsFrom('')).toEqual({});
  });
});

describe('presentation registry', () => {
  it('overrides names, colours and score tokens only for assigned actors', () => {
    const before = agentRevision();
    assignAgents(new Map([[0, look()]]));
    expect(agentRevision()).toBeGreaterThan(before);
    expect(actorName(0)).toBe('小方');
    expect(actorColor(0)).toBe('#e62828');
    expect(actorToken(0)).toBe('小');
    expect(actorName(1)).toBe(ROSTER[1].name);
    clearAgents();
    expect(actorName(0)).toBe(ROSTER[0].name);
    expect(actorColor(0)).toBe(ROSTER[0].color);
  });
});

describe('voxel agent model', () => {
  it('fits the head into the layout and stacks it on the torso', () => {
    const { blocks, headTop } = agentBlocks(look());
    expect(blocks).toHaveLength(look().runs.length + 2);
    const head = blocks.slice(0, -2);
    const width =
      Math.max(...head.map((b) => b.x + b.w / 2)) - Math.min(...head.map((b) => b.x - b.w / 2));
    expect(width).toBeCloseTo(AGENT_LAYOUT.headSize, 1);
    expect(Math.min(...head.map((b) => b.y - b.h / 2))).toBeCloseTo(AGENT_LAYOUT.headBase, 2);
    expect(headTop).toBeCloseTo(AGENT_LAYOUT.headBase + (AGENT_LAYOUT.headSize * 10) / 12, 6);
    // Faces forward (+z) carry the drawn colours; the back uses the hue's dark shade.
    expect(head[0].front).toBe('#e62828');
    expect(head[0].back).not.toBe(head[0].front);
  });
  it('builds one flat-shaded vertex-coloured geometry and splits it for the slice death', () => {
    const { blocks } = agentBlocks(look());
    const geometry = blocksGeometry(blocks);
    expect(geometry.getAttribute('position').count).toBe(blocks.length * 36);
    expect(geometry.getAttribute('color').count).toBe(blocks.length * 36);
    const halves = createAgentHalves(look());
    const count = (mesh: { geometry: { getAttribute(name: string): { count: number } } }) =>
      mesh.geometry.getAttribute('position').count / 36;
    expect(count(halves.stump) + count(halves.piece)).toBe(blocks.length + 2);
    expect(count(halves.piece)).toBeGreaterThan(1);
    expect(count(halves.stump)).toBeGreaterThan(2);
  });
  it('still builds a torso for an empty drawing', () => {
    expect(agentBlocks(look({ runs: [] })).blocks).toHaveLength(2);
  });
});
