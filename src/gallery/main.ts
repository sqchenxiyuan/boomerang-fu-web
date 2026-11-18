import { MAPS, createArena } from '../core/arena';
import { adjustmentsFor } from '../core/map-adjustments';
import type { MapId } from '../core/types';
import auditData from '../devtools/map-audit-data.json';
import type { BotAudit, StaticAudit } from '../devtools/map-audit';
import { mapFeatures } from '../devtools/map-audit';
import { SCHEMATIC_COLORS, drawSchematic } from '../devtools/map-schematic';
import { GameRenderer, type VisualStyle } from '../rendering/renderer';
import { BotDriver } from '../sdk/control';
import { MAP_DATA_VERSION, SIMULATION_VERSION } from '../sdk/recording';
import { RULES } from '../core/config';
import type { Command } from '../core/types';
import { Game } from '../simulation/game';
import { defaultOptions } from '../simulation/state';
import './gallery.css';

/*
 * Map gallery: every map as a top-down schematic with its features and the
 * audit results (npm run audit:maps), plus a live 3D preview on demand.
 */
type MapInfo = (typeof MAPS)[number];
interface AuditEntry {
  static: StaticAudit;
  bots: BotAudit | null;
}
const audits = (auditData as { maps: Record<string, AuditEntry> }).maps;
const auditFresh =
  (auditData as { simulationVersion: string }).simulationVersion === SIMULATION_VERSION &&
  (auditData as { mapDataVersion: string }).mapDataVersion === MAP_DATA_VERSION;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string | null)[]
) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c): c is Node | string => c !== null));
  return node;
};

const GROUPS: { id: string; label: string; test: (map: MapInfo) => boolean }[] = [
  { id: 'all', label: '全部', test: () => true },
  {
    id: 'base',
    label: '原版基础',
    test: (m) => m.source === 'original' && !m.tutorial && !m.requiredDLC,
  },
  {
    id: 'dlc',
    label: '原版扩展',
    test: (m) => m.source === 'original' && !m.tutorial && !!m.requiredDLC,
  },
  { id: 'tutorial', label: '教程', test: (m) => !!m.tutorial },
  { id: 'custom', label: 'Web 原创', test: (m) => m.source === 'custom' },
];
const groupOf = (map: MapInfo) => GROUPS.slice(1).find((g) => g.test(map))?.label ?? '';

/** Feature tags read from the map data. */
function tagsOf(map: MapInfo): string[] {
  const f = audits[map.id]?.static.features ?? mapFeatures(createArena(map.id));
  const tags: string[] = [];
  if (f.hazard === 'water') tags.push('水域');
  if (f.hazard === 'cliff') tags.push('悬崖');
  if (f.pits) tags.push('坑洞');
  if (f.portals) tags.push('传送门');
  const m = new Set(f.mechanisms);
  if (m.has('movingFloor') || m.has('movingObstacle') || f.floorKinds.includes('moving'))
    tags.push('移动机关');
  if (m.has('fallingFloor') || f.floorKinds.includes('falling')) tags.push('坍塌地板');
  if (m.has('trap') || m.has('trapFloor')) tags.push('陷阱');
  if (m.has('switch')) tags.push('开关');
  if (m.has('door')) tags.push('门');
  if (m.has('destructible') || m.has('destroyer')) tags.push('可破坏');
  if (f.plants) tags.push('植物');
  if (f.floorKinds.includes('ice')) tags.push('冰面');
  return tags;
}
const frameArea = (map: MapInfo) => {
  const frame = audits[map.id]?.static.frame;
  return frame ? frame.width * frame.height : 0;
};
// Small / medium / large are the thirds of the current catalogue by framed area.
const areas = MAPS.map(frameArea)
  .filter((area) => area > 0)
  .sort((a, b) => a - b);
const [smallBelow, mediumBelow] = [
  areas[Math.floor(areas.length / 3)],
  areas[Math.floor((areas.length * 2) / 3)],
];
function sizeOf(map: MapInfo): { label: string; area: number } {
  const area = frameArea(map);
  return { label: !area ? '' : area < smallBelow ? '小' : area < mediumBelow ? '中' : '大', area };
}
const COMPLEXITY: Record<string, string> = { Simple: '入门', Advanced: '进阶', Tutorial: '教程' };
const issuesOf = (map: MapInfo) =>
  (audits[map.id]?.static.findings ?? []).filter((f) => f.level !== 'info').length;

// ── Filters ──
let group = 'all',
  query = '',
  sort = 'default';
const activeTags = new Set<string>();
const allTags = [...new Set(MAPS.flatMap(tagsOf))];

function chip(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const button = el('button', {
    type: 'button',
    textContent: label,
    className: active ? 'chip active' : 'chip',
  });
  button.setAttribute('aria-pressed', String(active));
  button.onclick = onClick;
  return button;
}
function renderToolbar(): void {
  $('groups').replaceChildren(
    ...GROUPS.map((g) =>
      chip(`${g.label} ${MAPS.filter(g.test).length}`, group === g.id, () => {
        group = g.id;
        renderToolbar();
        renderGrid();
      }),
    ),
  );
  $('tags').replaceChildren(
    ...allTags.map((tag) =>
      chip(tag, activeTags.has(tag), () => {
        if (activeTags.has(tag)) activeTags.delete(tag);
        else activeTags.add(tag);
        renderToolbar();
        renderGrid();
      }),
    ),
  );
}
$<HTMLInputElement>('search').oninput = (event) => {
  query = (event.target as HTMLInputElement).value.trim().toLowerCase();
  renderGrid();
};
$<HTMLSelectElement>('sort').onchange = (event) => {
  sort = (event.target as HTMLSelectElement).value;
  renderGrid();
};

function legend(): void {
  const item = (color: string, label: string, shape = 'swatch') =>
    el(
      'span',
      { className: 'legend-item' },
      el('i', { className: shape, style: `--c:${color}` } as never),
      label,
    );
  $('legend').replaceChildren(
    item(SCHEMATIC_COLORS.ground, '地面'),
    item(SCHEMATIC_COLORS.water, '水'),
    item(SCHEMATIC_COLORS.pit, '坑/悬崖'),
    item(SCHEMATIC_COLORS.stone, '墙/石'),
    item(SCHEMATIC_COLORS.crate, '木箱/木'),
    item(SCHEMATIC_COLORS.tree, '树/植物'),
    item(SCHEMATIC_COLORS.ice, '冰面'),
    item(SCHEMATIC_COLORS.moving, '移动地板'),
    item(SCHEMATIC_COLORS.spawn, '出生点', 'dot'),
    item(SCHEMATIC_COLORS.pickup, '道具点', 'diamond'),
    item(SCHEMATIC_COLORS.boundary, '边界', 'dash'),
  );
}

// ── Grid ──
function visibleMaps(): MapInfo[] {
  const filter = GROUPS.find((g) => g.id === group)!.test;
  const list = MAPS.filter(
    (map) =>
      filter(map) &&
      (!query ||
        map.name.toLowerCase().includes(query) ||
        map.subtitle.toLowerCase().includes(query)) &&
      [...activeTags].every((tag) => tagsOf(map).includes(tag)),
  );
  if (sort === 'size') list.sort((a, b) => sizeOf(b).area - sizeOf(a).area);
  if (sort === 'round')
    list.sort(
      (a, b) => (audits[b.id]?.bots?.meanSeconds ?? 0) - (audits[a.id]?.bots?.meanSeconds ?? 0),
    );
  if (sort === 'issues') list.sort((a, b) => issuesOf(b) - issuesOf(a));
  return list;
}
const thumbnails = new Map<string, HTMLCanvasElement>();
function thumbnail(map: MapInfo): HTMLCanvasElement {
  let canvas = thumbnails.get(map.id);
  if (canvas) return canvas;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas = el('canvas', { width: 320 * ratio, height: 200 * ratio, className: 'thumb' });
  canvas.setAttribute('aria-label', `${map.name} 俯视示意图`);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(ratio, ratio);
  drawSchematic(ctx, createArena(map.id), 320, 200, { markers: true });
  thumbnails.set(map.id, canvas);
  return canvas;
}
function renderGrid(): void {
  const list = visibleMaps();
  $('summary').textContent =
    `${MAPS.length} 张地图 · 当前显示 ${list.length} 张${auditFresh ? '' : ' · 体检数据与当前版本不符，请运行 npm run audit:maps'}`;
  $('grid').replaceChildren(
    ...list.map((map) => {
      const bots = audits[map.id]?.bots;
      const issues = issuesOf(map),
        size = sizeOf(map);
      const card = el(
        'button',
        { type: 'button', className: 'card' },
        thumbnail(map),
        el(
          'div',
          { className: 'card-body' },
          el(
            'div',
            { className: 'card-title' },
            el('b', { textContent: map.name }),
            el('small', { textContent: map.subtitle }),
          ),
          el(
            'div',
            { className: 'card-meta' },
            el('span', { textContent: groupOf(map) }),
            size.label ? el('span', { textContent: `${size.label}型` }) : null,
            bots ? el('span', { textContent: `回合约 ${Math.round(bots.meanSeconds)} 秒` }) : null,
            issues
              ? el('span', { className: 'warn', textContent: `⚠ ${issues}` })
              : el('span', { className: 'ok', textContent: '✓ 体检通过' }),
          ),
          el(
            'div',
            { className: 'chips small' },
            ...tagsOf(map).map((tag) => el('span', { className: 'tag', textContent: tag })),
          ),
        ),
      );
      card.onclick = () => openDetail(map);
      return card;
    }),
  );
}

// ── Detail with a live 3D preview ──
let renderer: GameRenderer | null = null,
  style: VisualStyle = 'standard',
  frame = 0,
  live = false,
  current: { game: Game; driver: BotDriver; map: MapInfo } | null = null;
function openDetail(map: MapInfo): void {
  const dialog = $<HTMLDialogElement>('detail');
  const entry = audits[map.id];
  $('detail-title').textContent = map.name;
  $('detail-subtitle').textContent =
    `${map.subtitle} · ${groupOf(map)}${map.complexity ? ` · ${COMPLEXITY[map.complexity] ?? map.complexity}` : ''}`;
  $('detail-description').textContent = map.description;
  $('detail-tags').replaceChildren(
    ...tagsOf(map).map((tag) => el('span', { className: 'tag', textContent: tag })),
  );
  $<HTMLAnchorElement>('play').href = `./index.html?map=${encodeURIComponent(map.id)}`;
  const schematic = $<HTMLCanvasElement>('detail-schematic');
  const ctx = schematic.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawSchematic(ctx, createArena(map.id), schematic.width, schematic.height);
  const s = entry?.static,
    b = entry?.bots;
  const fact = (term: string, value: string) => [
    el('dt', { textContent: term }),
    el('dd', { textContent: value }),
  ];
  $('detail-facts').replaceChildren(
    ...(s
      ? [
          ...fact('取景范围', `${s.frame.width.toFixed(0)} × ${s.frame.height.toFixed(0)}`),
          ...fact('出生点 / 道具点', `${s.spawns} / ${s.pickupSpawns}`),
          ...fact('出生点最近距离', s.minSpawnDistance.toFixed(1)),
          ...fact('障碍数', String(s.features.obstacles)),
        ]
      : []),
    ...(b
      ? [
          ...fact('机器人平均回合', `${b.meanSeconds.toFixed(0)} 秒（${b.rounds} 回合）`),
          ...fact('击杀 / 自杀 / 无人得分', `${b.kills} / ${b.selfKills} / ${b.draws}`),
          ...fact('进入缩圈的回合', `${b.suddenDeath} / ${b.rounds}`),
          ...fact('每回合卡住时长', `${b.stuckSeconds.toFixed(1)} 秒`),
          ...fact(
            '死因',
            Object.entries(b.causes)
              .map(([k, v]) => `${CAUSES[k] ?? k} ${v}`)
              .join('、') || '—',
          ),
        ]
      : []),
  );
  const findings = s?.findings ?? [];
  // Spawn and pickup fixes at the same index share one line.
  const fixes = new Map<string, string>();
  for (const a of adjustmentsFor(map.id as MapId)) {
    const key = `${a.index}:${a.reason}`;
    const moved = Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y).toFixed(2);
    const label = fixes.has(key) ? '出生点/道具点' : a.target === 'spawn' ? '出生点' : '道具点';
    fixes.set(key, `已微调${label} ${a.index + 1}：${a.reason}，挪动 ${moved}`);
  }
  $('detail-findings').replaceChildren(
    ...[...fixes.values()].map((text) =>
      el('li', { className: 'fixed', textContent: `✓ ${text}` }),
    ),
    ...(findings.length
      ? findings.map((f) => el('li', { className: f.level, textContent: f.message }))
      : [
          el('li', {
            className: 'ok',
            textContent: entry ? '没有发现问题' : '尚未体检（运行 npm run audit:maps）',
          }),
        ]),
  );
  if (!dialog.open) dialog.showModal();
  show3d(map);
}
const CAUSES: Record<string, string> = {
  weapon: '回旋镖/近战',
  explosion: '爆炸',
  fall: '坠落',
  boundary: '出界',
  fire: '火',
  telefrag: '传送挤压',
  crush: '机关挤压',
};
/** Static preview by default; "watch bots" steps the real simulation so mechanisms move. */
function show3d(map: MapInfo): void {
  const seed = 1 + Math.floor(Math.random() * 1e6);
  const game = new Game({
    ...defaultOptions(),
    mode: 'bots',
    bots: 4,
    difficulty: 'hard',
    seed,
    mapId: map.id as MapId,
    mapRotation: 'fixed',
    scoring: 'kills',
    scoreGoal: 99,
  });
  current = { game, driver: new BotDriver(seed), map };
  if (!renderer) {
    renderer = new GameRenderer($('stage'), game.state);
    renderer.setVisualStyle(style);
  } else renderer.reset(game.state);
  cancelAnimationFrame(frame);
  let last = performance.now(),
    elapsed = 0,
    accumulator = 0;
  const loop = (now: number) => {
    if (!$<HTMLDialogElement>('detail').open || !current) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    elapsed += dt;
    const { game, driver } = current;
    if (live) {
      accumulator += dt;
      while (accumulator >= RULES.dt) {
        accumulator -= RULES.dt;
        const commands = new Map<number, Command>();
        for (const actor of game.state.actors)
          commands.set(actor.id, driver.command(game.state, actor));
        game.step(commands);
        const events = game.drainEvents();
        driver.observe(events);
        renderer!.events(events);
      }
    }
    renderer!.draw(game.state, live ? accumulator / RULES.dt : 1, elapsed, dt, !live, 1);
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);
}
$('watch').onclick = () => {
  live = !live;
  $('watch').classList.toggle('active', live);
  $('watch').textContent = live ? '暂停对战' : '观看机器人对战';
  if (current && !live) show3d(current.map);
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-style]'))
  button.onclick = () => {
    style = button.dataset.style as VisualStyle;
    for (const b of document.querySelectorAll('[data-style]'))
      b.classList.toggle('active', b === button);
    renderer?.setVisualStyle(style);
  };
$('close').onclick = () => $<HTMLDialogElement>('detail').close();
$('detail').addEventListener('click', (event) => {
  if (event.target === $('detail')) $<HTMLDialogElement>('detail').close();
});
$<HTMLDialogElement>('detail').addEventListener('close', () => cancelAnimationFrame(frame));

legend();
renderToolbar();
renderGrid();
const requested = new URLSearchParams(location.search).get('map');
const initial = MAPS.find((map) => map.id === requested);
if (initial) openDetail(initial);
