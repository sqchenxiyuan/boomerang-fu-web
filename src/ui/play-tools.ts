import type { BrowserFrame, BrowserGame } from '../sdk/browser';
import type { ReplayData } from '../sdk/recording';
import { decodeReplay, downloadReplay } from '../platform/replay-file';
import { ReplayHistory, replayEntry } from '../platform/replay-history';
import type { ReplayEntry } from '../platform/replay-history';
import { mapInfo } from '../core/arena';

const clock = (ticks: number): string =>
  `${Math.floor(ticks / 3600)}:${String(Math.floor(ticks / 60) % 60).padStart(2, '0')}`;
const date = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const mode = { solo: '单人挑战', local: '同屏对战', bots: 'AI 对战' };

/** Site-owned replay library. The SDK remains independent of browser persistence. */
export class PlayTools {
  private root: HTMLDetailsElement;
  private history = new ReplayHistory();
  private entries: ReplayEntry[] = [];
  private pending = new Map<string, ReplayData>();
  private saving = new Set<string>();
  private archived = new Set<string>();
  private selected = '';
  private refreshVersion = 0;
  private busy = false;
  private wasRecording = false;
  private seeking = false;
  private disposed = false;
  private channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('garden-replay-history');
  onReplay = (_data: ReplayData): void => {};
  onExitReplay = (): void => {};
  constructor(
    host: HTMLElement,
    private game: BrowserGame,
  ) {
    this.root = document.createElement('details');
    this.root.className = 'play-tools';
    this.root.innerHTML = `<summary>音乐 · 历史回放 · 倍速 <span id="record-dot"></span></summary>
      <div class="tools-body">
        <div class="volume-row"><label>音乐<input id="music-volume" aria-label="音乐音量" type="range" min="0" max="100" value="55"></label><label>音效<input id="sfx-volume" aria-label="音效音量" type="range" min="0" max="100" value="75"></label></div>
        <label class="speed-row">游戏 / 回放速度<select id="simulation-speed" aria-label="模拟与回放速度">${[0.25, 0.5, 1, 2, 4, 8].map((n) => `<option value="${n}"${n === 1 ? ' selected' : ''}>${n}×</option>`).join('')}</select></label>
        <label class="auto-record"><input id="auto-record" type="checkbox" checked> 自动录制并保存每局</label>
        <div class="tools-buttons"><button id="record-toggle" disabled>开始录制</button><button id="import-recording">导入录像</button><input id="replay-file" type="file" accept=".gz,.json,.bgr" hidden></div>
        <p id="recording-info">默认自动录制，结束后加入历史对局。</p>
        <section class="replay-library" aria-label="历史对局">
          <div class="history-heading"><b>历史对局</b><span id="history-count">读取中…</span></div>
          <div id="replay-history" role="group" aria-label="选择历史对局"></div>
          <p id="history-empty">还没有录像。开始一局，结束后会自动出现在这里。</p>
          <div class="tools-buttons"><button id="watch-recording" disabled>回放选中对局</button><button id="export-recording" disabled>下载</button><button id="delete-recording" disabled>删除</button></div>
          <p class="history-note">保存在当前浏览器，刷新后仍可查看。</p>
          <p id="history-warning" role="status" hidden></p>
        </section>
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
      /* Optional audio preference. Auto recording defaults on each visit. */
    }
    this.get('simulation-speed').addEventListener('change', () =>
      game.setSpeed(Number(this.get<HTMLSelectElement>('simulation-speed').value)),
    );
    this.get('record-toggle').addEventListener('click', () => {
      if (game.session.recording) this.captureRecording();
      else {
        game.session.startRecording();
        this.wasRecording = true;
        this.message('正在录制，停止或结束对局后自动保存。');
      }
    });
    this.get('watch-recording').addEventListener(
      'click',
      () => void this.useSelected(async (data) => this.play(data)),
    );
    this.get('export-recording').addEventListener(
      'click',
      () =>
        void this.useSelected(async (data) => {
          await downloadReplay(data);
          this.message('选中的录像已下载。');
        }),
    );
    this.get('delete-recording').addEventListener('click', () => void this.deleteSelected());
    const file = this.get<HTMLInputElement>('replay-file');
    this.get('import-recording').addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen || this.busy) return;
      this.busy = true;
      this.renderHistory();
      this.message('正在读取录像…');
      void decodeReplay(chosen)
        .then((data) => {
          this.play(data);
          this.archive(data, true, true);
          this.selected = replayEntry(data).id;
          this.message('录像已载入，可在历史对局中选择。');
        })
        .catch((error) => this.message(`无法载入录像：${this.error(error)}`))
        .finally(() => {
          this.busy = false;
          this.renderHistory();
        });
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
      } catch (error) {
        this.message(this.error(error));
      }
      this.seeking = false;
    });
    seek.addEventListener('pointercancel', () => {
      this.seeking = false;
    });
    this.channel?.addEventListener('message', () => void this.refreshHistory());
    // start() finalizes the preceding recording before it emits its lifecycle event.
    game.session.onEvent((event) => {
      if (event.type === 'lifecycle' && (event.action === 'start' || event.action === 'destroy')) {
        this.archive(game.session.getRecording());
        this.wasRecording = false;
        if (event.action === 'destroy') {
          this.disposed = true;
          this.channel?.close();
        }
      }
    });
    void this.refreshHistory();
  }
  private get<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.root.querySelector<T>(`#${id}`)!;
  }
  private error(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
  /** Synchronous finalization, followed by an asynchronous local archive. */
  captureRecording(): void {
    if (this.game.session.recording) this.archive(this.game.session.stopRecording());
    else this.archive(this.game.session.getRecording());
    this.wasRecording = false;
    this.message('录制已停止，可在历史对局中选择回放。');
  }
  matchStarted(): void {
    this.archive(this.game.session.getRecording());
    if (this.get<HTMLInputElement>('auto-record').checked) this.game.session.startRecording();
    this.wasRecording = !!this.game.session.recording;
    this.message('');
  }
  private play(data: ReplayData): void {
    const recording = !!this.game.session.recording;
    // BrowserGame validates before replacing the current match or stopping its recording.
    this.onReplay(data);
    if (recording) this.archive(this.game.session.getRecording(), false);
    this.wasRecording = false;
  }
  private archive(data: ReplayData | null, select = true, imported = false): void {
    if (!data || (data.durationTicks === 0 && !imported)) return;
    const entry = replayEntry(data);
    // Deleted clips stay suppressed for automatic captures, but can be explicitly reimported.
    if (
      this.archived.has(entry.id) &&
      (!imported || this.entries.some((item) => item.id === entry.id))
    ) {
      return;
    }
    this.archived.add(entry.id);
    this.pending.set(entry.id, data);
    this.saving.add(entry.id);
    this.entries = [entry, ...this.entries.filter((item) => item.id !== entry.id)].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    if (select || !this.selected) this.selected = entry.id;
    this.renderHistory();
    void this.history
      .save(data)
      .then((saved) => {
        this.refreshVersion++;
        this.pending.delete(saved.id);
        this.saving.delete(saved.id);
        this.entries = this.entries.map((item) => (item.id === saved.id ? saved : item));
        this.renderHistory();
        if (saved.persistent && !this.disposed) this.channel?.postMessage('changed');
      })
      .catch((error) => {
        // Retain the data in pending so a failed compression/storage operation never loses the clip.
        this.saving.delete(entry.id);
        this.history.warning = `本地保存失败，录像暂存于本页：${this.error(error)}`;
        this.renderHistory();
      });
  }
  private async refreshHistory(): Promise<void> {
    const version = ++this.refreshVersion;
    const entries = await this.history.list();
    if (version !== this.refreshVersion) return;
    const merged = new Map(entries.map((item) => [item.id, item]));
    for (const data of this.pending.values()) {
      const entry = replayEntry(data);
      merged.set(entry.id, entry);
    }
    this.entries = [...merged.values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.ticks - a.ticks,
    );
    this.entries.forEach((entry) => this.archived.add(entry.id));
    if (!this.entries.some((entry) => entry.id === this.selected))
      this.selected = this.entries[0]?.id ?? '';
    this.renderHistory();
  }
  private renderHistory(): void {
    const list = this.get('replay-history');
    const scroll = list.scrollTop;
    const focused = (document.activeElement as HTMLElement | null)?.dataset.replayId;
    list.replaceChildren();
    for (const entry of this.entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'history-entry';
      button.dataset.replayId = entry.id;
      button.setAttribute('aria-pressed', String(entry.id === this.selected));
      button.disabled = this.busy;
      const title = document.createElement('strong');
      title.textContent = `${mapInfo(entry.mapId).name} · ${clock(entry.ticks)}`;
      const detail = document.createElement('span');
      detail.textContent = `${date.format(new Date(entry.createdAt))} · ${mode[entry.mode]} · ${entry.players} 人`;
      const status = document.createElement('small');
      status.textContent = `${entry.complete ? '完整对局' : '对局片段'} · ${this.saving.has(entry.id) ? '保存中…' : entry.persistent ? '已存本地' : '仅本页'}`;
      button.append(title, detail, status);
      button.title = entry.label;
      button.addEventListener('click', () => {
        this.selected = entry.id;
        this.renderHistory();
      });
      list.append(button);
      if (focused === entry.id) button.focus({ preventScroll: true });
    }
    list.scrollTop = scroll;
    this.get('history-count').textContent = `${this.entries.length} 局`;
    this.get('history-empty').hidden = this.entries.length > 0;
    for (const id of ['watch-recording', 'export-recording', 'delete-recording'])
      this.get<HTMLButtonElement>(id).disabled =
        !this.selected ||
        this.busy ||
        (id === 'delete-recording' && this.saving.has(this.selected));
    this.get<HTMLButtonElement>('import-recording').disabled = this.busy;
    this.get('history-warning').textContent = this.history.warning;
    this.get('history-warning').hidden = !this.history.warning;
  }
  private async useSelected(action: (data: ReplayData) => Promise<void>): Promise<void> {
    if (!this.selected || this.busy) return;
    const id = this.selected;
    this.busy = true;
    this.renderHistory();
    try {
      await action(this.pending.get(id) ?? (await this.history.read(id)));
    } catch (error) {
      this.message(`无法读取录像：${this.error(error)}`);
    } finally {
      this.busy = false;
      this.renderHistory();
    }
  }
  private async deleteSelected(): Promise<void> {
    if (!this.selected || this.busy || this.saving.has(this.selected)) return;
    const id = this.selected;
    this.busy = true;
    this.renderHistory();
    try {
      if (this.pending.has(id)) this.pending.delete(id);
      else await this.history.remove(id);
      await this.refreshHistory();
      this.channel?.postMessage('changed');
      this.message('选中的历史录像已删除。');
    } catch (error) {
      this.message(`无法删除录像：${this.error(error)}`);
    } finally {
      this.busy = false;
      this.renderHistory();
    }
  }
  update(frame: BrowserFrame, menu: boolean): void {
    if (this.wasRecording && !frame.recording) {
      const data = this.game.session.getRecording();
      this.archive(data);
      this.message(
        data?.stopReason === 'size-limit' || data?.stopReason === 'limit'
          ? '已达到录制容量或时长上限，片段已加入历史；可手动开始录制下一片段。'
          : '录制已结束，可在历史对局中选择回放。',
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
    record.textContent = frame.recording ? '停止并保存' : '开始录制';
    record.disabled = menu || !!frame.replay || frame.state.phase === 'matchEnd';
    this.get('recording-info').textContent = frame.recording
      ? `录制中 · ${clock(frame.recording.ticks)} · 结束后自动加入历史对局`
      : this.get<HTMLInputElement>('auto-record').checked
        ? '自动录制已开启，开局无需手动操作。'
        : '自动录制已关闭，也可手动开始录制。';
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
