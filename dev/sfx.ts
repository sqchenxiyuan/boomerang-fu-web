import * as Tone from 'tone';
import type { GameEvent } from '../src/core/types';
import { SFX_CATALOG, WEB_ONLY } from '../src/devtools/sfx-catalog';
import type { SfxEntry, SfxGroup, WebSound } from '../src/devtools/sfx-catalog';
import { GardenAudioGraph } from '../src/platform/audio-score';
import type { MusicScene } from '../src/platform/audio-types';
import { RECIPES, type Recipe } from '../src/platform/sfx/recipes';
import { FmodPlayer } from './fmod-player';

const GROUPS: [SfxGroup | 'all', string][] = [
  ['all', '全部'],
  ['combat', '战斗'],
  ['death', '死亡'],
  ['environment', '环境'],
  ['powerups', '道具'],
  ['ui', '界面'],
  ['music', '音乐'],
  ['atmos', '氛围'],
];
const STATUS_LABEL = { godot: 'Godot 已接入', original: '仅原版', open: '开源皮肤' } as const;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// ── Web side: the real game graph on a private context ──
let webGraph: GardenAudioGraph | null = null;
let webContext: Tone.Context | null = null;
let webScene: MusicScene | null = null;
let webMusicTimer = 0;
function web(): GardenAudioGraph {
  if (!webGraph) {
    webContext = new Tone.Context({ latencyHint: 'interactive', lookAhead: 0.02 });
    webGraph = new GardenAudioGraph(webContext);
    configureWeb();
    webGraph.setScene('play', true);
  }
  void webContext!.resume();
  return webGraph;
}
function configureWeb(): void {
  const sfx = Number($<HTMLInputElement>('web-volume').value);
  webGraph?.configure({ music: webScene ? sfx * 0.8 : 0, sfx, muted: false });
}
function playWeb(sound: WebSound): void {
  const graph = web();
  if (sound.scene) {
    webScene = sound.scene;
    graph.setScene(sound.scene, true);
    configureWeb();
    window.clearTimeout(webMusicTimer);
    webMusicTimer = window.setTimeout(stopWebMusic, 12000);
    return;
  }
  graph.reset();
  if (sound.sound) {
    const name = sound.sound;
    if ((RECIPES[name] as Recipe).loop) {
      // Loops are auditioned for three seconds.
      graph.effects.loop('audition', name, { gain: 1 });
      window.clearTimeout(loopTimer);
      loopTimer = window.setTimeout(() => graph.effects.silenceLoops(), 3000);
    } else graph.effects.play(name, { jitter: false });
    return;
  }
  const events = (sound.events ?? []).map(
    (event) => ({ position: { x: 0, y: 0 }, actorId: 0, ...event }) as GameEvent,
  );
  graph.play(events);
}
let loopTimer = 0;
function stopWebMusic(): void {
  webScene = null;
  configureWeb();
  webGraph?.setScene('play', true);
}

// ── Original side ──
const fmod = new FmodPlayer();
const live = new Map<string, { stop: () => void }>();
const paramValues = new Map<string, Record<string, number>>();
function setFmodStatus(): void {
  const status = $('fmod-status');
  status.textContent =
    fmod.phase === 'idle'
      ? '原版音频未加载'
      : fmod.phase === 'loading'
        ? '加载中…（约 37 MB）'
        : fmod.message;
  status.className = `fmod-status ${fmod.phase === 'ready' ? '' : 'muted'}`;
  $<HTMLButtonElement>('load-fmod').disabled = fmod.phase === 'loading' || fmod.phase === 'ready';
}

// ── Rendering ──
let group: SfxGroup | 'all' = 'all';
function filtered(): SfxEntry[] {
  const status = $<HTMLSelectElement>('status-filter').value,
    webFilter = $<HTMLSelectElement>('web-filter').value,
    query = $<HTMLInputElement>('search').value.trim().toLowerCase();
  return SFX_CATALOG.filter(
    (entry) =>
      (group === 'all' || entry.group === group) &&
      (status === 'all' || entry.status === status) &&
      (webFilter === 'all' || (webFilter === 'has') === entry.web.length > 0) &&
      (!query || `${entry.path} ${entry.zh} ${entry.note ?? ''}`.toLowerCase().includes(query)),
  );
}

function renderStats(): void {
  const count = (fn: (e: SfxEntry) => boolean): number => SFX_CATALOG.filter(fn).length;
  const extra = fmod.bankEvents.filter((path) => !SFX_CATALOG.some((entry) => entry.path === path));
  const items: [number | string, string][] = [
    [SFX_CATALOG.length, '个事件'],
    [count((e) => e.status === 'godot'), 'Godot 已接入'],
    [count((e) => e.status === 'original'), '仅原版'],
    [count((e) => e.status === 'open'), '开源皮肤'],
    [count((e) => e.web.length > 0), 'Web 有对应'],
    [count((e) => e.web.length === 0), 'Web 无对应'],
  ];
  if (fmod.phase === 'ready' && fmod.bankEvents.length)
    items.push([extra.length, 'bank 中但代码未引用']);
  $('stats').replaceChildren(
    ...items.map(([n, label]) => el('span', {}, el('b', {}, String(n)), label)),
  );
}

function originalCell(entry: SfxEntry): HTMLTableCellElement {
  const cell = el('td', { className: 'orig' });
  const info = fmod.phase === 'ready' ? fmod.info(entry.path) : null;
  const values = paramValues.get(entry.path) ?? { ...(entry.params ?? {}) };
  paramValues.set(entry.path, values);
  const button = el('button', {
    textContent: entry.loop || info?.oneShot === false ? '▶ 播放（循环）' : '▶ 原版',
  });
  const stop = el('button', { textContent: '■ 停止', disabled: true });
  button.disabled = fmod.phase !== 'ready' || !info;
  if (fmod.phase === 'ready' && !info) button.title = 'bank 中没有这个事件';
  button.onclick = () => {
    live.get(entry.path)?.stop();
    try {
      const handle = fmod.play(entry.path, values);
      live.set(entry.path, handle);
      stop.disabled = false;
      cell.parentElement?.classList.add('playing');
      if (info?.oneShot !== false && !entry.loop)
        window.setTimeout(
          () => cell.parentElement?.classList.remove('playing'),
          Math.max(600, info?.lengthMs ?? 0),
        );
    } catch (error) {
      button.title = String(error);
      console.error(error);
    }
  };
  stop.onclick = () => {
    live.get(entry.path)?.stop();
    live.delete(entry.path);
    stop.disabled = true;
    cell.parentElement?.classList.remove('playing');
  };
  cell.append(el('div', { className: 'buttons' }, button, stop));
  const parameters =
    info?.parameters ??
    Object.entries(entry.params ?? {}).map(([name, value]) => ({ name, min: 0, max: 1, value }));
  if (parameters.length) {
    const grid = el('div', { className: 'params' });
    for (const p of parameters) {
      values[p.name] ??= p.value;
      const output = el('span', { className: 'mono', textContent: values[p.name].toFixed(2) });
      const range = el('input', {
        type: 'range',
        min: String(p.min),
        max: String(p.max),
        step: String((p.max - p.min) / 100 || 0.01),
        value: String(values[p.name]),
        disabled: fmod.phase !== 'ready',
      });
      range.oninput = () => {
        values[p.name] = Number(range.value);
        output.textContent = values[p.name].toFixed(2);
      };
      grid.append(el('span', { className: 'mono', textContent: p.name }), range, output);
    }
    cell.append(grid);
  }
  if (info?.lengthMs)
    cell.append(el('div', { className: 'note' }, `时长 ${(info.lengthMs / 1000).toFixed(2)} s`));
  return cell;
}

function webCell(entry: SfxEntry): HTMLTableCellElement {
  const cell = el('td', { className: 'web' });
  if (entry.web.length) {
    const buttons = el('div', { className: 'buttons' });
    for (const sound of entry.web) {
      const button = el('button', { textContent: `▶ ${sound.label}` });
      button.onclick = () => playWeb(sound);
      buttons.append(button);
    }
    cell.append(buttons);
  } else cell.append(el('span', { className: 'badge none' }, '无对应'));
  if (entry.note) cell.append(el('div', { className: 'note' }, entry.note));
  return cell;
}

function renderList(): void {
  const entries = filtered();
  const list = $('list');
  list.replaceChildren();
  for (const [key, label] of GROUPS.slice(1)) {
    const rows = entries.filter((entry) => entry.group === key);
    if (!rows.length) continue;
    const table = el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}, '事件 / 触发'),
          el('th', {}, '原版（FMOD）'),
          el('th', {}, 'Web 合成'),
        ),
      ),
    );
    const body = el('tbody');
    for (const entry of rows) {
      const tags = el(
        'div',
        { className: 'chips' },
        el('span', { className: `badge ${entry.status}` }, STATUS_LABEL[entry.status]),
      );
      if (entry.loop) tags.append(el('span', { className: 'badge none' }, '循环'));
      if (entry.web.length) tags.append(el('span', { className: 'badge web' }, 'Web 有对应'));
      body.append(
        el(
          'tr',
          {},
          el(
            'td',
            { className: 'event' },
            el('div', { className: 'zh' }, entry.zh),
            el('div', { className: 'mono' }, entry.path),
            tags,
            el('div', { className: 'src mono' }, entry.source),
          ),
          originalCell(entry),
          webCell(entry),
        ),
      );
    }
    table.append(body);
    list.append(
      el('h2', {}, label, el('span', { className: 'muted' }, `${rows.length} 个`)),
      table,
    );
  }
  if (group === 'all' && $<HTMLSelectElement>('web-filter').value !== 'none') {
    const body = el('tbody');
    for (const item of WEB_ONLY) {
      const button = el('button', { textContent: `▶ ${item.label}` });
      button.onclick = () => playWeb({ label: item.label, events: [item.event] });
      body.append(
        el(
          'tr',
          {},
          el('td', { className: 'event' }, item.note),
          el('td', { className: 'web' }, button),
        ),
      );
    }
    list.append(
      el('h2', {}, 'Web 独有', el('span', { className: 'muted' }, '原版没有对应的事件')),
      el('table', {}, body),
    );
  }
  const extra = fmod.bankEvents.filter((path) => !SFX_CATALOG.some((entry) => entry.path === path));
  if (extra.length) {
    const body = el('tbody');
    for (const path of extra) {
      const button = el('button', { textContent: '▶ 原版' });
      button.onclick = () => fmod.play(path);
      body.append(
        el(
          'tr',
          {},
          el('td', { className: 'event mono' }, path),
          el('td', { className: 'orig' }, button),
        ),
      );
    }
    list.append(
      el(
        'h2',
        {},
        'bank 中但代码未引用',
        el('span', { className: 'muted' }, `${extra.length} 个（FMOD 枚举）`),
      ),
      el('table', {}, body),
    );
  }
  renderStats();
}

function renderGroups(): void {
  $('groups').replaceChildren(
    ...GROUPS.map(([key, label]) => {
      const count =
        key === 'all' ? SFX_CATALOG.length : SFX_CATALOG.filter((e) => e.group === key).length;
      const button = el('button', {
        textContent: `${label} ${count}`,
        className: key === group ? 'active' : '',
      });
      button.onclick = () => {
        group = key;
        renderGroups();
        renderList();
      };
      return button;
    }),
  );
}

$('load-fmod').onclick = async () => {
  const pending = fmod.load();
  setFmodStatus();
  await pending;
  fmod.setVolume(Number($<HTMLInputElement>('fmod-volume').value));
  setFmodStatus();
  renderList();
};
$('fmod-volume').oninput = () => fmod.setVolume(Number($<HTMLInputElement>('fmod-volume').value));
$('web-volume').oninput = configureWeb;
$('stop-all').onclick = () => {
  fmod.stopAll();
  live.clear();
  stopWebMusic();
  renderList();
};
for (const id of ['status-filter', 'web-filter']) $(id).onchange = renderList;
$('search').oninput = renderList;

renderGroups();
renderList();
setFmodStatus();
// Tell early whether the dev server can see the Godot checkout.
fmod
  .status()
  .then((status) => {
    if (!status.available && fmod.phase === 'idle') {
      $('fmod-status').textContent =
        `未找到原版 FMOD 文件（${status.dir}）；可用 GODOT_AUDIO_DIR 指定目录`;
      $<HTMLButtonElement>('load-fmod').disabled = true;
    }
  })
  .catch(() => {
    $('fmod-status').textContent = '当前不是 dev server，无法加载原版音频（仍可试听 Web 合成音效）';
    $<HTMLButtonElement>('load-fmod').disabled = true;
  });
