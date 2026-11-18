import { ENGINE_ID } from '../agent/contract';
import { AgentRuntime } from '../agent/runtime';
import { assignAgents, actorIdentity } from '../agents/registry';
import { VOXEL_GRID, cleanName, dominantHex, voxelize, type AgentLook } from '../agents/look';
import { boundaryNotice } from '../core/feedback';
import { transitionPresentation } from '../core/presentation';
import type { GameState } from '../core/types';
import { AudioEngine } from '../platform/audio';
import { GameRenderer, type VisualStyle } from '../rendering/renderer';
import { MundiHost, type AudioStatus, type HostView, type Playback } from './host';
import { mundiFaceLook } from './identity';
import { FramePacer } from './pacer';
import './mundi.css';

/*
 * MUNDI embed page: the web engine inside the platform's same-origin iframe.
 * No menus. The platform drives everything over `arkena.game.v1`; this page
 * renders the shared runtime's state, plays its sound, shows a small HUD and
 * exposes the two hooks the platform's video recorder reads (`#canvas` and
 * `BFAudio.capture`).
 */
const query = new URLSearchParams(location.search);
const style: VisualStyle = query.get('style') === 'standard' ? 'standard' : 'pixel';
const notify = (type: string, extra: Record<string, unknown> = {}) =>
  parent.postMessage({ type, engineId: ENGINE_ID, ...extra }, location.origin);

const root = document.getElementById('game')!;
const status = document.getElementById('status')!;
const runtime = new AgentRuntime({ events: true });
// A neutral first scene so the renderer can build before the platform's reset.
runtime.reset({ seed: 1, mode: 'round' });
const renderer = new GameRenderer(root, runtime.state);
renderer.canvas.id = 'canvas';
renderer.setVisualStyle(style);
const pacer = new FramePacer();
const audio = new AudioEngine();
audio.configure({ muted: true });

// ── Sound: off until the platform's sound button asks (browser autoplay rules). ──
let audioEnabled = false;
let playback: Playback = 'idle';
function audioStatus(): AudioStatus {
  const stats = audio.stats();
  return { phase: stats.error ? 'error' : 'ready', enabled: audioEnabled };
}
function reportAudio(): AudioStatus {
  const value = audioStatus();
  notify('arkena:audio', { ...value });
  return value;
}
function setSound(enabled: boolean): void {
  if (enabled) audio.unlock();
  audioEnabled = enabled;
  audio.configure({ muted: !enabled });
}
let capture: { stream: MediaStream; release(): void } | null = null;
// The platform's recorder takes this stream's audio track next to `#canvas`.
const BFAudio = {
  toggle(): AudioStatus {
    setSound(!audioEnabled);
    return reportAudio();
  },
  async capture({
    signal,
  }: { signal?: AbortSignal; waitForReady?: boolean; monitor?: boolean } = {}) {
    if (capture) throw new Error('已有音频录制正在进行');
    if (signal?.aborted) throw new Error('声音准备已取消');
    setSound(true);
    reportAudio();
    const tap = audio.capture();
    if (!tap) throw new Error('游戏声音未就绪，无法录制有声视频');
    const output = {
      stream: tap.stream,
      release: () => {
        if (capture !== output) return;
        capture = null;
        tap.release();
      },
    };
    capture = output;
    return output;
  },
  playback(state: Playback): void {
    playback = state;
  },
  status: () => JSON.stringify({ ...audio.stats(), enabled: audioEnabled, playback }),
  shutdown(): void {
    capture?.release();
    audio.destroy();
  },
};
Object.assign(window, { BFAudio });

// ── Appearance: each player's MUNDI agent, display only. Either their drawing
// (`img`) or MUNDI's seeded default face (`seed`), with their name and colour. ──
const HEX = /^#[0-9a-f]{6}$/i;
async function lookFrom(entry: unknown, index: number): Promise<AgentLook | null> {
  if (!entry || typeof entry !== 'object') return null;
  const { name, hue, img, seed } = entry as Record<string, unknown>;
  const label = cleanName(typeof name === 'string' ? name : '') || actorIdentity(index).name;
  if (img === undefined) {
    if (!Number.isSafeInteger(seed) || (seed as number) < 0 || (seed as number) > 0xffffffff)
      throw new Error('Invalid appearance seed');
    return mundiFaceLook(
      seed as number,
      typeof hue === 'string' && HEX.test(hue) ? hue : '#c6f24e',
      label,
      index,
    );
  }
  if (typeof img !== 'string' || !/^data:image\/(png|webp);base64,/.test(img) || img.length > 3e6)
    throw new Error('Invalid appearance image');
  const image = new Image();
  image.src = img;
  await image.decode();
  const small = document.createElement('canvas');
  small.width = small.height = VOXEL_GRID;
  const context = small.getContext('2d', { willReadFrequently: true })!;
  context.imageSmoothingEnabled = true;
  context.drawImage(image, 0, 0, VOXEL_GRID, VOXEL_GRID);
  const pixels = context.getImageData(0, 0, VOXEL_GRID, VOXEL_GRID);
  const runs = voxelize(pixels, VOXEL_GRID);
  if (!runs.length) return null;
  const color = typeof hue === 'string' && HEX.test(hue) ? hue : (dominantHex(pixels) ?? '#c6f24e');
  return {
    v: 1,
    id: `mundi-${index}`,
    name: label,
    img: '',
    bg: '#e9efe6',
    hue: color,
    grid: VOXEL_GRID,
    runs,
    updated: 0,
  };
}
let appearanceRevision = 0;
function setAppearance(players: unknown): void {
  if (!Array.isArray(players) || players.length !== 2) throw new Error('Invalid appearance');
  const revision = ++appearanceRevision;
  void Promise.all(players.map((entry, index) => lookFrom(entry, index).catch(() => null))).then(
    (looks) => {
      if (revision !== appearanceRevision) return;
      assignAgents(new Map(looks.map((look, index) => [index, look])));
      renderer.refreshAgents();
    },
  );
}

// ── HUD ──
const hud = {
  left: document.getElementById('score-0')!,
  right: document.getElementById('score-1')!,
  round: document.getElementById('round')!,
  center: document.getElementById('center')!,
  notice: document.getElementById('notice')!,
  wipe: document.getElementById('wipe')!,
};
const setText = (element: HTMLElement, text: string) => {
  if (element.textContent !== text) element.textContent = text;
};
function drawHud(state: GameState): void {
  [hud.left, hud.right].forEach((element, index) => {
    const actor = state.actors[index];
    const identity = actorIdentity(index);
    setText(element, `${identity.name}  ${actor?.score ?? 0}`);
    element.style.setProperty('--player', identity.color);
    element.classList.toggle('out', !!actor && !actor.alive);
  });
  setText(hud.round, `第 ${state.round} 回合`);
  const presentation = transitionPresentation(state);
  const center =
    state.phase === 'matchEnd' && state.matchWinnerId != null
      ? `${actorIdentity(state.matchWinnerId).name}获胜！`
      : presentation.label;
  setText(hud.center, center);
  hud.center.hidden = !center;
  const notice = boundaryNotice(state);
  setText(hud.notice, notice);
  hud.notice.hidden = !notice;
  const wipe = presentation.wipeRadius < 1;
  hud.wipe.hidden = !wipe;
  if (wipe) {
    const radius = (presentation.wipeRadius * Math.hypot(innerWidth, innerHeight)) / 2;
    hud.wipe.style.maskImage = `radial-gradient(circle at center, transparent ${Math.max(0, radius - 1)}px, black ${radius}px)`;
  }
}

// ── Frame loop: presentation follows whatever the platform advanced. ──
let previous = performance.now(),
  elapsed = 0,
  disposed = false;
/** Frame counters and the last render error, for diagnosis from the platform. */
const diagnostics = { frames: 0, errors: 0, lastError: '' };
Object.assign(window, { mundiEmbedDiagnostics: diagnostics });
function frame(now: number): void {
  if (disposed) return;
  // Schedule first: one failing frame must never stop presentation.
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - previous) / 1000));
  previous = now;
  elapsed += dt;
  diagnostics.frames++;
  try {
    const state = runtime.state;
    const running = playback === 'playing' && !pacer.paused;
    const events = runtime.drainEvents();
    renderer.events(events);
    audio.update(state, !running, false);
    if (audioEnabled) audio.play(events);
    renderer.draw(
      state,
      running ? pacer.alpha() : 1,
      elapsed,
      running ? dt : 0,
      false,
      pacer.speed,
    );
    drawHud(state);
  } catch (error) {
    diagnostics.errors++;
    diagnostics.lastError = String(
      error instanceof Error ? (error.stack ?? error.message) : error,
    ).slice(0, 600);
    if (diagnostics.errors <= 3) console.error('MUNDI embed frame failed', error);
  }
}

const view: HostView = {
  reset() {
    renderer.reset(runtime.state);
    audio.reset();
    runtime.drainEvents();
  },
  advanced() {},
  playback(state) {
    playback = state;
  },
  audio: () => BFAudio.toggle(),
  appearance: setAppearance,
  async settle() {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 750));
  },
  dispose() {
    disposed = true;
    BFAudio.shutdown();
    renderer.dispose();
  },
};
const host = new MundiHost(runtime, pacer, view, ENGINE_ID);

window.addEventListener('message', (event) => {
  const data = event.data as { type?: string; protocol?: string; engineId?: string } | null;
  if (
    event.source !== parent ||
    event.origin !== location.origin ||
    data?.type !== 'arkena:connect' ||
    data.protocol !== host.manifest.protocol ||
    data.engineId !== ENGINE_ID ||
    host.connected ||
    event.ports.length !== 1
  )
    return;
  host.connect(event.ports[0]);
});
addEventListener('pagehide', () => host.dispose(), { once: true });
window.addEventListener('error', (event) =>
  notify('arkena:error', { message: String(event.message).slice(0, 200) }),
);

status.hidden = true;
requestAnimationFrame(frame);
notify('arkena:ready');
