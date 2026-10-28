import './sdk-demo.css';
import { createBrowserGame } from './sdk/browser';
import type {
  Action,
  ControlHandle,
  ControlInfo,
  ExternalController,
  ScriptController,
} from './sdk/types';
import type { MapId } from './core/types';
import { MAPS } from './core/arena';
// The sample is deliberately plain JavaScript so an external caller can use it unchanged.
// @ts-expect-error plain JS example consumed as a typed controller factory
import { createDuelController } from '../examples/duel-controller.js';

const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
get<HTMLSelectElement>('demo-map').innerHTML = MAPS.map(
  (map) => `<option value="${map.id}">${map.name}</option>`,
).join('');
get<HTMLSelectElement>('demo-map').value = 'original-enclosed';
function setText(id: string, value: string): void {
  const element = get(id);
  if (element.textContent !== value) element.textContent = value;
}
let takeover: ControlHandle | undefined;
let external: ExternalController | undefined;
let sample: Action = {};
const logs: string[] = [];
const labels = {
  human: '人工',
  bot: '机器人',
  script: 'JavaScript 脚本',
  external: '外部动作',
  idle: '等待控制',
};
function showControl(source: ControlInfo): void {
  setText('control-status', `${labels[source.kind]} · ${source.label}`);
}
const runtime = createBrowserGame(get('sdk-stage'), {
  match: { mode: 'local', bots: 0, seed: 295, mapId: 'original-enclosed' },
  inputTarget: get('sdk-demo'),
  autoStart: false,
  onFrame: ({ state, status }) => {
    setText(
      'session-status',
      `tick ${runtime.session.tick} · ${status}\n${state.arena.id} · round ${state.round}\n${state.phase} · ${state.roundTime.toFixed(2)}s`,
    );
    setText('demo-pause', status === 'paused' ? '继续' : '暂停');
  },
});
showControl(runtime.session.snapshot().controls.find((item) => item.actorId === 0)!);
runtime.session.onEvent((event) => {
  if (event.type === 'control' && event.control.actorId === 0) showControl(event.control);
  if (event.type === 'lifecycle' && event.action === 'start')
    showControl(runtime.session.snapshot().controls.find((item) => item.actorId === 0)!);
  if (event.type === 'control' || event.type === 'lifecycle' || event.type === 'error') {
    sample = {};
    logs.unshift(
      event.type === 'control'
        ? `角色 ${event.control.actorId + 1} → ${labels[event.control.kind]}`
        : event.type === 'lifecycle'
          ? event.action
          : event.message,
    );
    logs.splice(6);
    get('sdk-log').textContent = logs.join('\n');
  }
});
function start(): void {
  runtime.start({
    mode: 'local',
    bots: 0,
    mapId: get<HTMLSelectElement>('demo-map').value as MapId,
    seed: 295,
  });
  runtime.session.useBot(1);
  takeover = undefined;
  external = undefined;
  sample = {};
}
get('demo-start').addEventListener('click', start);
get('demo-pause').addEventListener('click', () =>
  runtime.session.status === 'paused' ? runtime.resume() : runtime.pause(),
);
get('demo-script').addEventListener('click', () => {
  takeover = undefined;
  external = undefined;
  runtime.session.useScript(0, createDuelController() as ScriptController, '示例对战脚本');
  runtime.canvas.focus();
});
get('demo-external').addEventListener('click', () => {
  takeover = undefined;
  external = runtime.session.acquire(0, '按钮动作源');
  sample = {};
});
get('demo-human').addEventListener('click', () => {
  if (!takeover?.active) takeover = runtime.session.takeover(0, 0);
  runtime.canvas.focus();
});
get('demo-release').addEventListener('click', () => {
  takeover?.release();
  takeover = undefined;
  runtime.canvas.focus();
});
const directions = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-move], [data-action]')) {
  button.addEventListener('pointerdown', (event) => {
    if (!external?.active) return;
    button.setPointerCapture(event.pointerId);
    button.classList.add('active');
    if (button.dataset.move)
      sample.move = directions[button.dataset.move as keyof typeof directions];
    else sample[button.dataset.action as 'attack' | 'throw' | 'dash'] = true;
    external.submit(sample, 6);
  });
  const release = () => {
    button.classList.remove('active');
    if (button.dataset.move) sample.move = { x: 0, y: 0 };
    else sample[button.dataset.action as 'attack' | 'throw' | 'dash'] = false;
    if (external?.active && runtime.session.status === 'running') external.submit(sample, 6);
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
}
const sendTimer = window.setInterval(() => {
  if (external?.active && runtime.session.status === 'running') external.submit(sample, 6);
}, 50);
window.addEventListener(
  'pagehide',
  () => {
    clearInterval(sendTimer);
    runtime.destroy();
  },
  { once: true },
);
// This explicit demo handle is the public SDK, not the development-only snapshot interface.
Object.defineProperty(window, 'sdkDemo', { value: runtime, configurable: true });
start();
