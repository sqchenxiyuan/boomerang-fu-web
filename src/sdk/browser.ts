import { GameSession } from './session';
import type { GameEvent, GameState, MatchOptions } from '../core/types';
import type { SessionSnapshot } from './types';
import { GameRenderer } from '../rendering/renderer';
import { Input } from '../platform/input';
import { AudioEngine } from '../platform/audio';
import type { AudioSettings } from '../platform/audio';
import type { ReplayPlayer } from './recording';
import type { ReplayData, RecordingStatus } from './recording';
import { ReplayTransport } from './replay-transport';
import type { ReplayLoop, ReplayTransportSnapshot } from './replay-transport';
import { ReplayTimeline } from './replay-timeline';
import type { ReplayTimelineSnapshot } from './replay-timeline';
import { FixedLoop } from '../platform/loop';
import { transitionPresentation } from '../core/presentation';
import { boundaryNotice, eliminationLabel } from '../core/feedback';
import { mapInfo } from '../core/arena';
import { ROSTER } from '../core/config';

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function setHidden(element: HTMLElement, hidden: boolean): void {
  if (element.hidden !== hidden) element.hidden = hidden;
}

export interface BrowserFrame {
  state: GameState;
  status: SessionSnapshot['status'];
  alpha: number;
  elapsed: number;
  dt: number;
  events: GameEvent[];
  muted: boolean;
  audio: AudioSettings;
  speed: number;
  recording: RecordingStatus | null;
  replay: ReplayTransportSnapshot | null;
  replayTimeline: ReplayTimelineSnapshot | null;
  replayError: string | null;
}
export interface BrowserGameOptions {
  match?: Partial<MatchOptions>;
  autoStart?: boolean;
  keyboard?: boolean;
  inputTarget?: HTMLElement;
  hud?: boolean;
  pauseOnBlur?: boolean;
  onFrame?: (frame: BrowserFrame) => void;
  audio?: Partial<AudioSettings>;
  speed?: number;
}

/** Browser-only adapter. The session owns state; this adapter owns exactly one RAF and input device. */
export class BrowserGame {
  readonly session: GameSession;
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: GameRenderer;
  private readonly input: Input;
  private readonly audio = new AudioEngine();
  private readonly loop = new FixedLoop();
  private readonly unsubscribe: () => void;
  private readonly originalPosition: string;
  private readonly overlay: HTMLDivElement;
  private readonly wipe: HTMLDivElement;
  private readonly center: HTMLDivElement;
  private readonly score: HTMLDivElement;
  private readonly notice: HTMLDivElement;
  private events: GameEvent[] = [];
  private disposed = false;
  private preview = false;
  private frames = 0;
  private elapsed = 0;
  private frameErrors = 0;
  private player: ReplayPlayer | null = null;
  private transport: ReplayTransport | null = null;
  private timeline: ReplayTimeline | null = null;
  private replayRevision = -1;
  private liveSpeed: number | null = null;
  private replayError: string | null = null;
  onFrame: (frame: BrowserFrame) => void;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: BrowserGameOptions = {},
  ) {
    if (!(container instanceof HTMLElement))
      throw new TypeError('A browser HTMLElement container is required');
    this.session = new GameSession(options.match);
    if (options.audio) this.audio.configure(options.audio);
    if (options.speed !== undefined) this.loop.timeScale = options.speed;
    this.originalPosition = container.style.position;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    this.input = new Input(options.inputTarget ?? container);
    this.onFrame = options.onFrame ?? (() => {});
    try {
      this.renderer = new GameRenderer(container, this.session.getState());
    } catch (error) {
      this.input.dispose();
      this.session.destroy();
      container.style.position = this.originalPosition;
      throw error;
    }
    this.canvas = this.renderer.canvas;
    Object.assign(this.canvas.style, {
      display: 'block',
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      outline: 'none',
    });
    this.canvas.addEventListener('pointerdown', this.focus);
    this.overlay = document.createElement('div');
    this.overlay.className = 'garden-sdk-hud';
    Object.assign(this.overlay.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      overflow: 'hidden',
      fontFamily: 'system-ui, Microsoft YaHei, sans-serif',
      color: '#244e3b',
    });
    this.wipe = document.createElement('div');
    Object.assign(this.wipe.style, { position: 'absolute', inset: '0', background: '#203e32' });
    this.center = document.createElement('div');
    Object.assign(this.center.style, {
      position: 'absolute',
      left: '50%',
      top: '45%',
      transform: 'translate(-50%,-50%)',
      color: '#fff8e5',
      fontSize: 'clamp(22px,3vw,48px)',
      fontWeight: '800',
      textAlign: 'center',
      textShadow: '0 3px 18px #203e32',
    });
    this.score = document.createElement('div');
    Object.assign(this.score.style, {
      position: 'absolute',
      left: '50%',
      top: '16px',
      transform: 'translateX(-50%)',
      whiteSpace: 'pre',
      textAlign: 'center',
      background: '#f7f4e7ed',
      borderRadius: '14px',
      padding: '10px 18px',
      fontSize: '13px',
      lineHeight: '1.8',
    });
    this.notice = document.createElement('div');
    this.notice.className = 'garden-sdk-notice';
    this.notice.setAttribute('role', 'status');
    Object.assign(this.notice.style, {
      position: 'absolute',
      left: '50%',
      top: '98px',
      transform: 'translateX(-50%)',
      maxWidth: '90%',
      textAlign: 'center',
      color: '#fff7e4',
      background: '#a74c3ce8',
      borderRadius: '12px',
      padding: '7px 14px',
      fontSize: '12px',
    });
    this.overlay.append(this.wipe, this.score, this.notice, this.center);
    this.overlay.hidden = options.hud === false;
    container.append(this.overlay);
    this.input.onPause = () => {
      if (options.keyboard !== false)
        (this.player ? this.player.status !== 'playing' : this.session.status === 'paused')
          ? this.resume()
          : this.pause();
    };
    this.input.onSound = () => {
      if (options.keyboard !== false) this.toggleSound();
    };
    this.unsubscribe = this.session.onEvent((event) => {
      if (this.disposed) return;
      if (event.type === 'game') this.events.push(event.event);
      if (event.type === 'control' || event.type === 'lifecycle') this.input.clear();
      if (event.type === 'game' && event.event.type === 'round') this.input.clear();
      if (event.type === 'lifecycle') {
        if (event.action === 'start') {
          this.player = null;
          this.transport = null;
          this.timeline = null;
          if (this.liveSpeed !== null) this.loop.timeScale = this.liveSpeed;
          this.liveSpeed = null;
          this.replayError = null;
          this.preview = false;
          this.events = [];
          this.renderer.reset(this.session.getState());
          this.loop.reset();
          this.loop.paused = false;
          this.audio.reset();
        }
        if (event.action === 'pause') {
          this.loop.paused = true;
          this.input.setEnabled(false);
          // Hidden tabs may stop RAF entirely; silence the audio clock immediately.
          this.audio.update(this.session.getState(), true, false);
        }
        if (event.action === 'resume') {
          this.preview = false;
          this.loop.paused = false;
          this.loop.reset();
          this.input.setEnabled(options.keyboard !== false);
        }
        if (event.action === 'destroy') this.destroy();
      }
    });
    this.loop.onStep = () => {
      if (this.disposed || this.preview) return false;
      if (this.player) {
        if (this.player.status !== 'playing') return false;
        const before = this.player.tick;
        try {
          this.transport!.advance();
          this.events.push(...this.player.drainEvents());
        } catch (error) {
          this.replayError = String(error);
          this.player.pause();
          this.frameErrors++;
        }
        return this.player.tick !== before || this.transport!.snapshot().loop !== null;
      }
      if (this.session.status !== 'running') return false;
      if (options.keyboard !== false) {
        for (const [index, command] of this.input.read(2)) this.session.submitHuman(index, command);
      }
      const before = this.session.tick;
      this.session.step();
      return this.session.tick > before;
    };
    this.loop.onFrame = (alpha, elapsed, dt) => {
      if (this.disposed) return;
      this.synchronizeReplay();
      // Build a separate event index cooperatively; never advance the visible replay for indexing.
      if (this.timeline?.snapshot().status === 'indexing') {
        const deadline = performance.now() + 3;
        do {
          this.timeline.advance(8);
        } while (this.timeline.snapshot().status === 'indexing' && performance.now() < deadline);
      }
      if (options.keyboard !== false) this.input.pollSystemButtons();
      // The public frame gets its own detached world, without allocating the
      // controls metadata needed only by an explicit Session.snapshot() caller.
      const state = this.player ? this.player.getState() : this.session.getState();
      const status = this.player
        ? this.player.status === 'playing'
          ? 'running'
          : 'paused'
        : this.session.status;
      const paused = status !== 'running';
      this.loop.paused = paused && !this.preview;
      this.input.setEnabled(
        !this.player &&
          !paused &&
          !this.preview &&
          state.phase !== 'matchEnd' &&
          options.keyboard !== false,
      );
      const events = this.events.splice(0);
      this.renderer.events(events);
      this.audio.update(state, paused, this.preview);
      this.audio.play(events);
      this.renderer.draw(
        state,
        paused ? 1 : alpha,
        elapsed,
        paused && !this.preview ? 0 : dt,
        this.preview,
      );
      if (options.hud !== false) {
        const presentation = transitionPresentation(state);
        setHidden(this.wipe, presentation.wipeRadius >= 1 || this.preview);
        if (!this.wipe.hidden) {
          const radius =
            (presentation.wipeRadius * Math.hypot(container.clientWidth, container.clientHeight)) /
            2;
          const mask = `radial-gradient(circle at center, transparent ${Math.max(0, radius - 1)}px, black ${radius}px)`;
          if (this.wipe.style.maskImage !== mask) this.wipe.style.maskImage = mask;
        }
        setText(
          this.score,
          `${state.actors.map((a) => `${ROSTER[a.id].name}  ${a.score}${a.alive ? '' : ` (${eliminationLabel(a)})`}`).join('    ·    ')}\n${mapInfo(state.arena.id).name} · 第 ${state.round} 回合`,
        );
        const notice = this.preview ? '' : boundaryNotice(state);
        setHidden(this.notice, !notice);
        setText(this.notice, notice);
        setText(
          this.center,
          paused && !this.preview
            ? '已暂停'
            : state.phase === 'matchEnd'
              ? `${ROSTER[state.matchWinnerId ?? 0].name}获胜！`
              : presentation.label,
        );
      }
      this.frames++;
      this.elapsed = elapsed;
      try {
        this.onFrame({
          state,
          status,
          alpha,
          elapsed,
          dt,
          events,
          muted: this.audio.muted,
          audio: this.audio.getSettings(),
          speed: this.loop.timeScale,
          recording: this.session.recording,
          replay: this.transport?.snapshot() ?? null,
          replayTimeline: this.timeline?.snapshot() ?? null,
          replayError: this.replayError,
        });
      } catch {
        this.frameErrors++;
      }
    };
    if (options.pauseOnBlur !== false) {
      window.addEventListener('blur', this.blur);
      document.addEventListener('visibilitychange', this.visibility);
    }
    if (options.autoStart === false) this.session.pause();
    this.loop.start();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('BrowserGame has been destroyed');
  }
  private focus = (): void => {
    if (this.disposed) return;
    this.canvas.focus();
    this.audio.unlock();
  };
  private blur = (): void => {
    if (!this.disposed && !this.preview) {
      this.transport?.endScrub(true);
      this.pause();
    }
  };
  private visibility = (): void => {
    if (document.hidden) this.blur();
  };

  start(options?: Partial<MatchOptions>): void {
    this.assertLive();
    this.preview = false;
    this.session.start(options);
    this.loop.paused = false;
    this.loop.reset();
    this.input.setEnabled(this.options.keyboard !== false);
    this.focus();
  }
  pause(): void {
    this.assertLive();
    if (this.transport) this.transport.pause();
    else this.session.pause();
    this.loop.paused = true;
    this.input.setEnabled(false);
    if (this.player) this.audio.update(this.player.getState(), true, false);
  }
  resume(): void {
    this.assertLive();
    this.preview = false;
    if (this.player) {
      this.transport!.resume();
      this.synchronizeReplay();
    } else this.session.resume();
    this.loop.paused = false;
    this.loop.reset();
    this.input.setEnabled(this.options.keyboard !== false);
    this.focus();
  }
  /** A paused world rendered as a menu diorama; no hidden match runs in the background. */
  showPreview(options?: Partial<MatchOptions>): void {
    this.assertLive();
    this.session.start(options);
    this.session.pause();
    this.preview = true;
    this.events = [];
    this.input.setEnabled(false);
    this.loop.paused = false;
    this.loop.reset();
  }
  toggleSound(): boolean {
    this.assertLive();
    this.audio.unlock();
    return this.audio.toggle();
  }
  get playback(): ReplayPlayer | null {
    return this.player;
  }
  get speed(): number {
    return this.loop.timeScale;
  }
  setSpeed(value: number): void {
    this.assertLive();
    this.loop.timeScale = value;
  }
  unlockAudio(): void {
    this.assertLive();
    this.audio.unlock();
  }
  configureAudio(settings: Partial<AudioSettings>): void {
    this.assertLive();
    this.audio.configure(settings);
  }
  audioSettings(): AudioSettings {
    return this.audio.getSettings();
  }
  loadReplay(data: ReplayData | string): void {
    this.assertLive();
    const transport = new ReplayTransport(data);
    const timeline = new ReplayTimeline(data);
    const player = transport.player;
    if (this.session.recording) this.session.stopRecording();
    this.session.pause();
    this.player = player;
    this.transport = transport;
    this.timeline = timeline;
    this.replayRevision = transport.snapshot().revision;
    this.liveSpeed ??= this.loop.timeScale;
    this.loop.timeScale = 1;
    this.preview = false;
    this.replayError = null;
    this.events = [];
    this.renderer.reset(player.getState());
    this.input.setEnabled(false);
    this.loop.reset();
    this.loop.paused = false;
    this.audio.reset();
    this.audio.unlock();
  }
  seekReplay(tick: number): void {
    this.assertLive();
    this.requireReplay().seek(tick);
    this.synchronizeReplay();
  }
  stepReplayFrames(delta: number): void {
    this.assertLive();
    this.requireReplay().stepFrames(delta);
    this.synchronizeReplay();
  }
  setReplayLoop(range: ReplayLoop | null): void {
    this.assertLive();
    this.requireReplay().setLoop(range);
  }
  beginReplayScrub(): void {
    this.assertLive();
    this.requireReplay().beginScrub();
    this.loop.paused = true;
    this.audio.reset();
  }
  endReplayScrub(cancel = false): void {
    this.assertLive();
    this.requireReplay().endScrub(cancel);
    this.synchronizeReplay();
    this.loop.paused = this.player!.status !== 'playing';
    this.loop.reset();
  }
  get replayTimeline(): ReplayTimelineSnapshot | null {
    return this.timeline?.snapshot() ?? null;
  }
  private requireReplay(): ReplayTransport {
    if (!this.transport) throw new Error('No replay is loaded');
    return this.transport;
  }
  private synchronizeReplay(): void {
    if (!this.transport || this.replayRevision === this.transport.snapshot().revision) return;
    this.replayRevision = this.transport.snapshot().revision;
    this.events = [];
    this.renderer.seek(this.transport.player.getState());
    this.loop.reset();
    this.loop.paused = this.transport.player.status !== 'playing';
    this.audio.reset();
  }
  stats(): {
    frames: number;
    elapsed: number;
    frameErrors: number;
    render: { calls: number; triangles: number; geometries: number; textures: number };
    audio: ReturnType<AudioEngine['stats']>;
    clock: ReturnType<FixedLoop['stats']>;
    replayError: string | null;
  } {
    return {
      frames: this.frames,
      elapsed: this.elapsed,
      frameErrors: this.frameErrors,
      render: this.renderer.stats(),
      audio: this.audio.stats(),
      clock: this.loop.stats(),
      replayError: this.replayError,
    };
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.stop();
    this.unsubscribe();
    this.input.dispose();
    window.removeEventListener('blur', this.blur);
    document.removeEventListener('visibilitychange', this.visibility);
    this.canvas.removeEventListener('pointerdown', this.focus);
    this.renderer.dispose();
    this.overlay.remove();
    this.audio.destroy();
    this.session.destroy();
    this.container.style.position = this.originalPosition;
    this.events = [];
    this.player = null;
    this.transport = null;
    this.timeline = null;
  }
}

export function createBrowserGame(
  container: HTMLElement,
  options?: BrowserGameOptions,
): BrowserGame {
  return new BrowserGame(container, options);
}
export type {
  Action,
  ScriptController,
  SessionSnapshot,
  SessionEvent,
  ControlHandle,
  ExternalController,
} from './types';
