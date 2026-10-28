import type { BrowserFrame, BrowserGame } from '../sdk/browser';
import type { ReplayData } from '../sdk/recording';
import { decodeReplay, downloadReplay } from '../platform/replay-file';

const clock = (ticks: number): string =>
  `${Math.floor(ticks / 3600)}:${String(Math.floor(ticks / 60) % 60).padStart(2, '0')}`;

/** Site controls; recordings stay local and never upload themselves. */
export class PlayTools {
  private root: HTMLDetailsElement;
  private last: ReplayData | null = null;
  private wasRecording = false;
  private seeking = false;
  onReplay = (_data: ReplayData): void => {};
  onExitReplay = (): void => {};
  constructor(
    host: HTMLElement,
    private game: BrowserGame,
  ) {
    this.root = document.createElement('details');
    this.root.className = 'play-tools';
    this.root.innerHTML = `<summary>音乐 · 录像 · 倍速 <span id="record-dot"></span></summary>
      <div class="tools-body">
        <div class="volume-row"><label>音乐<input id="music-volume" aria-label="音乐音量" type="range" min="0" max="100" value="55"></label><label>音效<input id="sfx-volume" aria-label="音效音量" type="range" min="0" max="100" value="75"></label></div>
        <label class="speed-row">游戏 / 回放速度<select id="simulation-speed" aria-label="模拟与回放速度">${[0.25, 0.5, 1, 2, 4, 8].map((n) => `<option value="${n}"${n === 1 ? ' selected' : ''}>${n}×</option>`).join('')}</select></label>
        <label class="auto-record"><input id="auto-record" type="checkbox" checked> 开局自动录制</label>
        <div class="tools-buttons"><button id="record-toggle" disabled>开始录制</button><button id="watch-recording" disabled>回放最近一局</button></div>
        <div class="tools-buttons"><button id="export-recording" disabled>下载录像</button><button id="import-recording">导入录像</button><input id="replay-file" type="file" accept=".gz,.json,.bgr" hidden></div>
        <p id="recording-info">还没有录像。可录制自己的操作或 AI 对战。</p>
        <div id="playback-controls" hidden><label>回放进度 <span id="playback-time"></span><input id="playback-seek" aria-label="回放进度" type="range" min="0" max="1" value="0" step="1"></label><div class="tools-buttons"><button id="playback-toggle">暂停回放</button><button id="playback-exit">退出回放</button></div></div>
        <p id="tools-status" role="status"></p>
      </div>`;
    host.append(this.root);
    for (const [id, key] of [
      ['music-volume', 'music'],
      ['sfx-volume', 'sfx'],
    ] as const) {
      const slider = this.get<HTMLInputElement>(id);
      slider.addEventListener('input', () => {
        game.configureAudio({ [key]: Number(slider.value) / 100 });
        game.unlockAudio();
        this.saveAudio();
      });
    }
    try {
      const stored = localStorage.getItem('garden-audio-v1');
      if (stored) game.configureAudio(JSON.parse(stored));
    } catch {
      /* Storage can be disabled; defaults still work. */
    }
    this.get('simulation-speed').addEventListener('change', () =>
      game.setSpeed(Number(this.get<HTMLSelectElement>('simulation-speed').value)),
    );
    this.get('record-toggle').addEventListener('click', () => {
      if (game.session.recording) {
        this.last = game.session.stopRecording();
        this.message('录像已保存到本次页面，可回放或下载。');
      } else {
        game.session.startRecording();
        this.message('正在录制。');
      }
    });
    this.get('watch-recording').addEventListener('click', () => {
      if (this.last) this.onReplay(this.last);
    });
    this.get('export-recording').addEventListener('click', () => {
      if (this.last)
        void downloadReplay(this.last)
          .then(() => this.message('录像已下载。'))
          .catch((e) => this.message(String(e)));
    });
    const file = this.get<HTMLInputElement>('replay-file');
    this.get('import-recording').addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      this.message('正在读取录像…');
      void decodeReplay(chosen)
        .then((data) => {
          this.onReplay(data);
          this.last = data;
          this.wasRecording = false;
          this.message('录像已载入。');
        })
        .catch((error) =>
          this.message(`无法载入录像：${error instanceof Error ? error.message : String(error)}`),
        );
    });
    this.get('playback-toggle').addEventListener('click', () =>
      game.playback?.status === 'playing' ? game.pause() : game.resume(),
    );
    this.get('playback-exit').addEventListener('click', () => this.onExitReplay());
    const seek = this.get<HTMLInputElement>('playback-seek');
    seek.addEventListener('pointerdown', () => {
      this.seeking = true;
    });
    seek.addEventListener('input', () => {
      this.seeking = true;
      this.get('playback-time').textContent = clock(Number(seek.value));
    });
    seek.addEventListener('change', () => {
      try {
        game.seekReplay(Number(seek.value));
      } catch (e) {
        this.message(String(e));
      }
      this.seeking = false;
    });
    seek.addEventListener('pointercancel', () => {
      this.seeking = false;
    });
  }
  private get<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.root.querySelector<T>(`#${id}`)!;
  }
  private message(text: string): void {
    this.get('tools-status').textContent = text;
  }
  saveAudio(): void {
    try {
      localStorage.setItem('garden-audio-v1', JSON.stringify(this.game.audioSettings()));
    } catch {
      /* Optional preference. */
    }
  }
  matchStarted(): void {
    const previous = this.game.session.getRecording();
    if (previous) this.last = previous;
    if (this.get<HTMLInputElement>('auto-record').checked) this.game.session.startRecording();
    this.message('');
  }
  update(frame: BrowserFrame, menu: boolean): void {
    if (this.wasRecording && !frame.recording) {
      this.last = this.game.session.getRecording();
      this.message(
        this.last?.stopReason === 'size-limit'
          ? '录像达到容量上限，已自动保存；可继续录制新片段。'
          : this.last?.stopReason === 'limit'
            ? '已到录制时长上限，录像已保留。'
            : '录像已保存，可回放或下载。',
      );
    }
    this.wasRecording = !!frame.recording;
    this.get('record-dot').textContent = frame.recording
      ? `● ${clock(frame.recording.ticks)}`
      : frame.replay
        ? frame.replay.status === 'ended'
          ? '回放结束'
          : frame.replay.status === 'paused'
            ? '回放暂停'
            : '回放中'
        : '';
    const record = this.get<HTMLButtonElement>('record-toggle');
    record.textContent = frame.recording ? '停止录制' : '开始录制';
    record.disabled = menu || !!frame.replay || frame.state.phase === 'matchEnd';
    this.get<HTMLButtonElement>('watch-recording').disabled = !this.last;
    this.get<HTMLButtonElement>('export-recording').disabled = !this.last;
    this.get('recording-info').textContent = frame.recording
      ? `录制中 · ${clock(frame.recording.ticks)}`
      : this.last
        ? `最近录像 · ${clock(this.last.durationTicks)} · ${this.last.label}`
        : '还没有录像。可录制自己的操作或 AI 对战。';
    for (const [id, key] of [
      ['music-volume', 'music'],
      ['sfx-volume', 'sfx'],
    ] as const) {
      const slider = this.get<HTMLInputElement>(id);
      if (document.activeElement !== slider)
        slider.value = String(Math.round(frame.audio[key] * 100));
    }
    this.get<HTMLSelectElement>('simulation-speed').value = String(frame.speed);
    this.get('playback-controls').hidden = !frame.replay;
    if (frame.replay) {
      const seek = this.get<HTMLInputElement>('playback-seek');
      seek.max = String(frame.replay.durationTicks);
      if (!this.seeking) {
        seek.value = String(frame.replay.tick);
        this.get('playback-time').textContent =
          `${clock(frame.replay.tick)} / ${clock(frame.replay.durationTicks)}`;
      }
      this.get('playback-toggle').textContent =
        frame.replay.status === 'playing'
          ? '暂停回放'
          : frame.replay.status === 'ended'
            ? '重新播放'
            : '继续回放';
    }
    if (frame.replayError) this.message(`回放已停止：${frame.replayError}`);
  }
}
