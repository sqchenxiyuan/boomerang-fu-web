import { RULES } from '../src/core/config';
import type { GameEvent } from '../src/core/types';
import { createScenarioGame, FX_SCENARIOS, stepScenario } from '../src/devtools/fx-scenarios';
import type { FxScenario } from '../src/devtools/fx-scenarios';
import { AudioEngine } from '../src/platform/audio';
import { GameRenderer } from '../src/rendering/renderer';
import type { Game } from '../src/simulation/game';

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
const SPEEDS = [0.25, 0.5, 1];

let scenario: FxScenario = FX_SCENARIOS[0];
let game: Game = createScenarioGame(scenario);
let renderer: GameRenderer | null = null;
const audio = new AudioEngine();
let tick = 0,
  run = 0,
  speed = 1,
  paused = false,
  accumulator = 0,
  previous = performance.now(),
  elapsed = 0;
let pending: GameEvent[] = [];
let log: { t: number; text: string; hit: boolean }[] = [];

const params = new URLSearchParams(location.search);
const initial = FX_SCENARIOS.find((s) => s.id === params.get('s'));
if (initial) scenario = initial;

function start(next = scenario): void {
  scenario = next;
  game = createScenarioGame(scenario);
  // A different round number makes the renderer rebuild the arena (hazard may differ).
  game.state.round = (run++ % 2) + 1;
  tick = 0;
  accumulator = 0;
  pending = [];
  log = [];
  if (!renderer) renderer = new GameRenderer($('stage'), game.state);
  else renderer.reset(game.state);
  renderer.dynamicCamera = $<HTMLInputElement>('follow').checked;
  renderer.setVisualStyle($<HTMLInputElement>('pixel').checked ? 'pixel' : 'standard');
  audio.reset();
  history.replaceState(null, '', `?s=${scenario.id}`);
  renderScenarios();
  renderInfo();
  renderLog();
}

function describe(event: GameEvent): string {
  const extra = [
    event.feedback,
    event.variant,
    event.power,
    event.charged ? 'charged' : '',
    event.value !== undefined ? `value=${Number(event.value.toFixed(2))}` : '',
  ].filter(Boolean);
  return `${event.type}${extra.length ? ` (${extra.join(', ')})` : ''} · P${event.actorId + 1}`;
}

function frame(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - previous) / 1000));
  previous = now;
  elapsed += dt;
  if (!paused) {
    accumulator += dt * speed;
    while (accumulator >= RULES.dt) {
      accumulator -= RULES.dt;
      const t = tick * RULES.dt;
      if (t >= scenario.duration) {
        if ($<HTMLInputElement>('auto').checked) {
          const index = FX_SCENARIOS.indexOf(scenario);
          start(FX_SCENARIOS[(index + 1) % FX_SCENARIOS.length]);
        } else if ($<HTMLInputElement>('loop').checked) start();
        else {
          paused = true;
          $('pause').textContent = '继续';
        }
        break;
      }
      const events = stepScenario(game, scenario, t);
      tick++;
      for (const event of events) {
        if (event.type === 'round') continue;
        log.push({ t, text: describe(event), hit: scenario.expect(event) });
      }
      pending.push(...events);
      if (events.length) renderLog();
    }
  }
  if (renderer) {
    const events = pending.splice(0);
    renderer.events(events);
    if ($<HTMLInputElement>('sound').checked) {
      audio.update(game.state, paused, false);
      audio.play(events);
    }
    renderer.draw(
      game.state,
      paused ? 1 : Math.min(1, accumulator / RULES.dt),
      elapsed,
      paused ? 0 : dt,
      false,
      speed,
    );
    const rig = renderer.cameraRig;
    $('camera').textContent = renderer.dynamicCamera
      ? `zoom ${(rig.ratio * 100).toFixed(0)}% · 焦点 (${rig.focus.x.toFixed(1)}, ${rig.focus.y.toFixed(1)})`
      : '固定全景';
  }
  $('progress').style.width = `${Math.min(100, ((tick * RULES.dt) / scenario.duration) * 100)}%`;
  requestAnimationFrame(frame);
}

function renderScenarios(): void {
  const aside = $('scenarios');
  aside.replaceChildren();
  let group = '';
  for (const item of FX_SCENARIOS) {
    if (item.group !== group) {
      group = item.group;
      aside.append(el('h3', {}, group));
    }
    const button = el('button', {
      className: `scenario${item === scenario ? ' active' : ''}`,
      textContent: item.title,
      title: item.description,
    });
    button.onclick = () => {
      paused = false;
      $('pause').textContent = '暂停';
      start(item);
    };
    aside.append(button);
  }
}

function renderInfo(): void {
  $('info').replaceChildren(
    el('h2', {}, scenario.title),
    el('p', {}, scenario.description),
    el(
      'div',
      { className: 'expect' },
      '应出现事件：',
      el('span', { className: 'badge godot' }, scenario.expectLabel),
    ),
    ...(scenario.godot ? [el('p', { className: 'godot' }, `Godot / 原版：${scenario.godot}`)] : []),
  );
}

function renderLog(): void {
  $('log').replaceChildren(
    ...(log.length ? log : [{ t: 0, text: '（暂无事件）', hit: false }])
      .slice(-60)
      .map((item) =>
        el(
          'div',
          { className: item.hit ? 'hit' : '' },
          el('span', { className: 't' }, `${item.t.toFixed(2)}s`),
          el('span', {}, item.text),
        ),
      ),
  );
}

$('speeds').replaceChildren(
  ...SPEEDS.map((value) => {
    const button = el('button', {
      textContent: `${value}×`,
      className: value === speed ? 'active' : '',
    });
    button.onclick = () => {
      speed = value;
      for (const b of $('speeds').children) b.classList.toggle('active', b === button);
    };
    return button;
  }),
);
$('replay').onclick = () => {
  paused = false;
  $('pause').textContent = '暂停';
  start();
};
$('pause').onclick = () => {
  paused = !paused;
  $('pause').textContent = paused ? '继续' : '暂停';
};
$('pixel').onchange = () =>
  renderer?.setVisualStyle($<HTMLInputElement>('pixel').checked ? 'pixel' : 'standard');
$('follow').onchange = () => {
  if (renderer) renderer.dynamicCamera = $<HTMLInputElement>('follow').checked;
};
$('sound').onchange = () => {
  if ($<HTMLInputElement>('sound').checked) audio.unlock();
};
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  const index = FX_SCENARIOS.indexOf(scenario);
  if (event.key === 'ArrowDown' || event.key === 'j')
    start(FX_SCENARIOS[(index + 1) % FX_SCENARIOS.length]);
  else if (event.key === 'ArrowUp' || event.key === 'k')
    start(FX_SCENARIOS[(index - 1 + FX_SCENARIOS.length) % FX_SCENARIOS.length]);
  else if (event.key === ' ') {
    event.preventDefault();
    $('replay').click();
  } else return;
});

start();
requestAnimationFrame(frame);
