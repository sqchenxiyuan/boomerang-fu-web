import './styles.css';
import { defaultOptions } from './simulation/state';
import type { MatchOptions } from './core/types';
import { createBrowserGame } from './sdk/browser';
import type { BrowserGame } from './sdk/browser';
import { View } from './ui/view';
import { PlayTools } from './ui/play-tools';
import { ReplayStudio } from './ui/replay-studio';
import './ui/replay-studio.css';
import { assignAgents, clearAgents } from './agents/registry';

/** The playable site is a client of the same SDK shipped to external callers. */
class Application {
  private readonly view: View;
  private readonly runtime: BrowserGame;
  private readonly tools: PlayTools;
  private readonly replayStudio: ReplayStudio;
  private screen: 'menu' | 'playing' | 'paused' = 'menu';
  private options: MatchOptions = { ...defaultOptions(), mapId: 'original-enclosed' };

  constructor(root: HTMLElement) {
    this.view = new View(root);
    try {
      this.runtime = createBrowserGame(this.view.stage, {
        autoStart: false,
        inputTarget: root,
        hud: false,
        onFrame: (frame) => {
          const { state, status, elapsed, events, muted, replay } = frame;
          if (this.screen === 'menu' && status === 'running') {
            this.screen = 'playing';
            this.options = state.options;
            this.view.setMode('playing');
          }
          if (this.view.isMuted !== muted) this.view.setSound(muted);
          this.view.events(events, elapsed, !!replay || state.options.mode === 'bots');
          this.view.update(state, elapsed, !!replay);
          this.tools?.update(frame, this.screen === 'menu');
          this.replayStudio?.update(frame);
        },
      });
    } catch (error) {
      this.view.renderError(String(error));
      throw error;
    }
    this.tools = new PlayTools(root, this.runtime);
    this.replayStudio = new ReplayStudio(root, {
      toggle: () =>
        this.runtime.playback?.status === 'playing' ? this.runtime.pause() : this.runtime.resume(),
      seek: (tick) => this.runtime.seekReplay(tick),
      stepFrames: (delta) => this.runtime.stepReplayFrames(delta),
      setSpeed: (speed) => this.runtime.setSpeed(speed),
      setLoop: (range) => this.runtime.setReplayLoop(range),
      beginScrub: () => this.runtime.beginReplayScrub(),
      endScrub: (cancel) => this.runtime.endReplayScrub(cancel),
      exit: () => {
        this.view.onMenu();
        this.tools.openHistory();
      },
    });
    this.tools.onReplay = (data) => {
      // Recordings carry no appearance; replays use the default roster.
      clearAgents();
      this.runtime.loadReplay(data);
      this.replayStudio.reset();
      this.screen = 'playing';
      this.view.setMode('playing');
    };
    root.addEventListener('pointerdown', () => this.runtime.unlockAudio(), { once: true });
    this.showPreview(this.options);
    this.runtime.session.onEvent((event) => {
      if (event.type === 'lifecycle' && event.action === 'destroy') this.replayStudio.destroy();
      if (event.type !== 'lifecycle' || event.action === 'destroy' || this.screen === 'menu')
        return;
      if (this.runtime.session.getState().phase === 'matchEnd') return;
      if (event.action === 'pause') {
        this.screen = 'paused';
        this.view.setMode('paused');
      } else if (event.action === 'resume' || event.action === 'start') {
        this.screen = 'playing';
        this.view.setMode('playing');
      }
    });
    this.view.onStart = (options) => this.start(options);
    this.view.onPreviewMap = (mapId) => {
      if (this.screen === 'menu') this.showPreview({ ...defaultOptions(), mapId });
    };
    // Links from the map gallery: index.html?map=<id>.
    this.view.selectMap(new URLSearchParams(location.search).get('map'));
    const STYLE_KEY = 'boomerang-garden.visual-style.v1';
    const storedStyle = (() => {
      try {
        return localStorage.getItem(STYLE_KEY) === 'pixel' ? 'pixel' : 'standard';
      } catch {
        return 'standard';
      }
    })();
    this.runtime.setVisualStyle(storedStyle);
    this.view.setVisualStyle(storedStyle);
    this.view.onVisualStyle = (style) => {
      this.runtime.setVisualStyle(style);
      try {
        localStorage.setItem(STYLE_KEY, style);
      } catch {
        // Per-viewer convenience only.
      }
    };
    this.view.onAgentsChanged = () => {
      if (this.screen === 'menu') this.showPreview(this.options);
    };
    this.view.onPause = () => this.runtime.pause();
    this.view.onResume = () => this.runtime.resume();
    this.view.onMenu = () => {
      this.screen = 'menu';
      this.showPreview(this.options);
      this.view.setMode('menu');
    };
    this.view.onRestart = () =>
      this.start({ ...this.options, seed: crypto.getRandomValues(new Uint32Array(1))[0] });
    this.view.onSound = () => {
      this.view.setSound(this.runtime.toggleSound());
      this.tools.saveAudio();
    };
    this.view.onFullscreen = () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else void root.requestFullscreen().catch(() => {});
    };
    // Supported public control API. The package itself creates no window globals.
    Object.defineProperty(window, 'boomerangGarden', { configurable: true, value: this.runtime });
    if (import.meta.env.DEV) {
      Object.defineProperty(window, '__garden', {
        configurable: true,
        value: {
          snapshot: () => {
            const state = this.runtime.session.getState();
            if (this.screen === 'menu') state.phase = 'menu';
            return state;
          },
          status: () => ({ screen: this.screen, ...this.runtime.stats() }),
        },
      });
    }
    window.addEventListener('pagehide', () => this.runtime.destroy(), { once: true });
  }

  /** The menu backdrop shows the chosen agents too. */
  private showPreview(options: MatchOptions): void {
    assignAgents(this.view.agentAssignments());
    this.runtime.showPreview(options);
  }

  private start(options: MatchOptions): void {
    assignAgents(this.view.agentAssignments(options.mode));
    this.options = options;
    this.screen = 'playing';
    this.view.setMode('playing');
    this.runtime.start(options);
    this.tools.matchStarted();
  }
}

new Application(document.querySelector<HTMLElement>('#app')!);
