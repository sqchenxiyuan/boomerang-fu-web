import type { GameState } from '../core/types';
import { POWERUPS, ROSTER } from '../core/config';
import { mapInfo } from '../core/arena';
import type { ReplayLoop, ReplayTransportSnapshot } from '../sdk/replay-transport';
import type { ReplayMarker, ReplayTimelineSnapshot } from '../sdk/replay-timeline';

/** UI consumes a read model and sends commands through this port. It never owns a player or clock. */
export interface ReplayStudioPort {
  toggle(): void;
  seek(tick: number): void;
  stepFrames(delta: number): void;
  setSpeed(speed: number): void;
  setLoop(range: ReplayLoop | null): void;
  beginScrub(): void;
  endScrub(cancel?: boolean): void;
  exit(): void;
}
export interface ReplayStudioFrame {
  replay: ReplayTransportSnapshot | null;
  replayTimeline: ReplayTimelineSnapshot | null;
  state: GameState;
  speed: number;
  replayError: string | null;
}
const timecode = (tick: number): string => {
  const seconds = Math.floor(tick / 60);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}:${String(tick % 60).padStart(2, '0')}`;
};
const actorName = (id: number): string => ROSTER[id]?.name ?? '环境';
function markerLabel(marker: Readonly<ReplayMarker>): string {
  switch (marker.kind) {
    case 'round':
      return `第 ${marker.round} 回合 · ${mapInfo(marker.mapId).name}`;
    case 'win':
      return `${actorName(marker.actorId)}赢得对局`;
    case 'pickup':
      return `${actorName(marker.actorId)}获得${marker.power ? POWERUPS[marker.power].name : '道具'}`;
    case 'deflect':
      return `${actorName(marker.actorId)}格挡 / 反弹`;
    case 'death':
      return marker.sourceId !== undefined &&
        marker.sourceId >= 0 &&
        marker.sourceId !== marker.actorId
        ? `${actorName(marker.sourceId)} 淘汰 ${actorName(marker.actorId)}`
        : `${actorName(marker.actorId)}出局`;
  }
}

export class ReplayStudio {
  private root: HTMLElement;
  private frame: ReplayStudioFrame | null = null;
  private markerKey = '';
  private rosterKey = '';
  private dragging = false;
  private pendingSeek: number | null = null;
  private previewFrame = 0;
  private loopA = 0;
  private loopB = 0;
  private active = false;
  private replayId = 0;
  private lastRevision = -1;
  private message = '';
  constructor(
    private host: HTMLElement,
    private port: ReplayStudioPort,
  ) {
    this.root = document.createElement('section');
    this.root.id = 'replay-studio';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', '回放工作台');
    this.root.innerHTML = `
      <header class="replay-header"><button id="playback-exit" title="退出回放，返回历史对局">← 返回</button><div><span class="replay-eyebrow">REPLAY STUDIO</span><h1 id="replay-title">对局回放</h1></div><span id="replay-state" class="replay-state"></span></header>
      <aside class="replay-inspector"><section class="replay-roster"><div class="replay-section-heading"><b>场上选手</b><span id="replay-round"></span></div><div id="replay-players"></div></section>
        <section class="replay-events-panel"><div class="replay-section-heading"><b>对局事件</b><select id="replay-filter" aria-label="筛选回放事件"><option value="all">全部事件</option><option value="round">回合</option><option value="death">淘汰</option><option value="pickup">道具</option><option value="deflect">格挡</option></select></div><p id="replay-index-status" role="status"></p><div id="replay-events" aria-label="跳转到事件"></div></section>
      </aside>
      <section id="playback-controls" class="replay-transport" aria-label="回放播放控制">
        <div class="replay-time-row"><div><span id="playback-time" class="replay-timecode"></span><span id="replay-frame-number"></span></div><label class="replay-round-jump">跳转回合 <select id="replay-round-select" aria-label="跳转回合"></select></label></div>
        <div class="replay-timeline"><div id="replay-loop-band" hidden></div><input id="playback-seek" aria-label="回放进度" type="range" min="0" max="1" step="1" value="0"><div id="replay-markers" aria-label="时间轴事件标记"></div></div>
        <div id="replay-ruler" class="replay-ruler"></div>
        <div class="replay-control-row"><div class="replay-play-buttons">
          <button id="replay-start" title="回到开头（Home）" aria-label="回到开头">↤</button><button id="replay-back" title="后退 5 秒（←）">−5s</button><button id="replay-frame-back" title="上一帧（,）" aria-label="上一帧">Ⅰ‹</button>
          <button id="playback-toggle" class="replay-primary" title="播放 / 暂停（空格）">暂停</button><button id="replay-frame-next" title="下一帧（.）" aria-label="下一帧">›Ⅰ</button><button id="replay-forward" title="前进 5 秒（→）">+5s</button><button id="replay-end" title="跳到结尾（End）" aria-label="跳到结尾">↦</button>
          <select id="playback-speed" aria-label="回放速度">${[0.25, 0.5, 1, 2, 4, 8].map((value) => `<option value="${value}"${value === 1 ? ' selected' : ''}>${value}×</option>`).join('')}</select></div>
          <div class="replay-loop-controls"><button id="replay-set-a" title="设定循环起点（[）">A 入点</button><button id="replay-set-b" title="设定循环终点（]）">B 出点</button><button id="replay-loop-toggle" aria-pressed="false">循环片段</button><button id="replay-loop-clear" title="清除循环">清除</button></div>
        </div>
        <div class="replay-footer"><span id="replay-hint">空格 播放 / 暂停 · ← → 跳转 · , . 逐帧 · [ ] 设定片段</span><span id="replay-loop-label">选择 A、B 点可循环复盘</span></div><p id="replay-error" role="status" hidden></p>
      </section>`;
    host.append(this.root);
    const bind = (id: string, fn: () => void): void => {
      this.get(id).addEventListener('click', () => this.run(fn));
    };
    bind('playback-exit', () => this.port.exit());
    bind('playback-toggle', () => this.port.toggle());
    bind('replay-start', () => this.jump(0));
    bind('replay-end', () => this.jump(this.frame?.replay?.durationTicks ?? 0));
    bind('replay-back', () => this.offset(-300));
    bind('replay-forward', () => this.offset(300));
    bind('replay-frame-back', () => this.port.stepFrames(-1));
    bind('replay-frame-next', () => this.port.stepFrames(1));
    bind('replay-set-a', () => this.setPoint('a'));
    bind('replay-set-b', () => this.setPoint('b'));
    bind('replay-loop-toggle', () => this.toggleLoop());
    bind('replay-loop-clear', () => {
      this.port.setLoop(null);
      this.loopA = 0;
      this.loopB = this.frame?.replay?.durationTicks ?? 0;
    });
    this.get('playback-speed').addEventListener('change', () =>
      this.run(() =>
        this.port.setSpeed(Number(this.get<HTMLSelectElement>('playback-speed').value)),
      ),
    );
    this.get('replay-filter').addEventListener('change', () => {
      this.markerKey = '';
      this.renderMarkers();
    });
    this.get('replay-round-select').addEventListener('change', () =>
      this.run(() => this.jump(Number(this.get<HTMLSelectElement>('replay-round-select').value))),
    );
    const seek = this.get<HTMLInputElement>('playback-seek');
    seek.addEventListener('pointerdown', () =>
      this.run(() => {
        this.dragging = true;
        this.port.beginScrub();
      }),
    );
    seek.addEventListener('input', () =>
      this.run(() => {
        if (!this.dragging) {
          this.dragging = true;
          this.port.beginScrub();
        }
        this.pendingSeek = Number(seek.value);
        this.showTime(this.pendingSeek);
        // Coalesce pointer events to one seek per paint; do not rebuild the simulation on every pixel.
        if (!this.previewFrame)
          this.previewFrame = requestAnimationFrame(() => this.run(() => this.flushSeek()));
      }),
    );
    seek.addEventListener('change', () => this.finishScrub());
    seek.addEventListener('pointerup', () => this.finishScrub());
    seek.addEventListener('pointercancel', () => this.finishScrub(true));
    seek.addEventListener('blur', () => this.finishScrub());
    host.addEventListener('keydown', this.keyDown, true);
    window.addEventListener('blur', this.cancelScrub);
  }
  private get<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.root.querySelector<T>(`#${id}`)!;
  }
  private text(id: string, text: string): void {
    const el = this.get(id);
    if (el.textContent !== text) el.textContent = text;
  }
  private run(action: () => void): void {
    try {
      action();
      this.message = '';
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    }
  }
  private flushSeek(): void {
    cancelAnimationFrame(this.previewFrame);
    this.previewFrame = 0;
    if (this.pendingSeek !== null) {
      const tick = this.pendingSeek;
      this.pendingSeek = null;
      this.port.seek(tick);
    }
  }
  private finishScrub(cancel = false): void {
    if (!this.dragging) return;
    this.run(() => {
      if (cancel) {
        cancelAnimationFrame(this.previewFrame);
        this.previewFrame = 0;
        this.pendingSeek = null;
      } else this.flushSeek();
      this.dragging = false;
      this.port.endScrub(cancel);
    });
  }
  private cancelScrub = (): void => this.finishScrub(true);
  private jump(tick: number): void {
    this.port.seek(tick);
  }
  private offset(delta: number): void {
    const replay = this.frame?.replay;
    if (replay) this.jump(Math.max(0, Math.min(replay.durationTicks, replay.tick + delta)));
  }
  private setPoint(point: 'a' | 'b'): void {
    const replay = this.frame?.replay;
    if (!replay) return;
    if (point === 'a') {
      if (replay.tick >= this.loopB) throw new Error('A 入点需要早于 B 出点。');
      this.loopA = replay.tick;
    } else {
      if (replay.tick <= this.loopA) throw new Error('B 出点需要晚于 A 入点。');
      this.loopB = replay.tick;
    }
    if (replay.loop) this.port.setLoop({ start: this.loopA, end: this.loopB });
  }
  private toggleLoop(): void {
    if (this.loopB <= this.loopA) throw new Error('这段录像没有可循环的区间。');
    this.port.setLoop(this.frame?.replay?.loop ? null : { start: this.loopA, end: this.loopB });
  }
  private keyDown = (event: KeyboardEvent): void => {
    if (!this.active || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, select, textarea, [contenteditable="true"]')) return;
    // Let focused buttons retain native Enter/Space activation.
    if (event.code === 'Space' && target.closest('button, summary')) return;
    const actions: Record<string, () => void> = {
      Space: () => this.port.toggle(),
      KeyK: () => this.port.toggle(),
      ArrowLeft: () => this.offset(-300),
      ArrowRight: () => this.offset(300),
      Comma: () => this.port.stepFrames(-1),
      Period: () => this.port.stepFrames(1),
      Home: () => this.jump(0),
      End: () => this.jump(this.frame!.replay!.durationTicks),
      BracketLeft: () => this.setPoint('a'),
      BracketRight: () => this.setPoint('b'),
    };
    const action = actions[event.code];
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat || ['ArrowLeft', 'ArrowRight', 'Comma', 'Period'].includes(event.code))
      this.run(action);
  };
  private showTime(tick: number): void {
    this.text(
      'playback-time',
      `${timecode(tick)} / ${timecode(this.frame?.replay?.durationTicks ?? 0)}`,
    );
    this.text('replay-frame-number', `帧 ${tick.toLocaleString()} · 60 fps`);
    this.get<HTMLInputElement>('playback-seek').setAttribute('aria-valuetext', timecode(tick));
  }
  private renderMarkers(): void {
    const replay = this.frame?.replay,
      timeline = this.frame?.replayTimeline;
    if (!replay || !timeline) return;
    const filter = this.get<HTMLSelectElement>('replay-filter').value;
    const key = `${timeline.markers.length}:${filter}`;
    if (key === this.markerKey) return;
    this.markerKey = key;
    const events = this.get('replay-events'),
      markers = this.get('replay-markers');
    const scroll = events.scrollTop;
    const focusId = (document.activeElement as HTMLElement)?.dataset.markerId;
    events.replaceChildren();
    markers.replaceChildren();
    const visible = timeline.markers.filter((marker) => filter === 'all' || marker.kind === filter);
    for (const marker of visible) {
      const label = markerLabel(marker);
      const button = document.createElement('button');
      button.className = `replay-event event-${marker.kind}`;
      button.dataset.markerId = marker.id;
      button.dataset.tick = String(marker.tick);
      const time = document.createElement('time'),
        title = document.createElement('span');
      time.textContent = timecode(marker.tick);
      title.textContent = label;
      button.append(time, title);
      button.addEventListener('click', () =>
        this.run(() => {
          this.port.stepFrames(0);
          this.jump(marker.tick);
        }),
      );
      events.append(button);
      if (focusId === marker.id) button.focus({ preventScroll: true });
    }
    // Timeline ticks are a compact overview; the event list keeps every indexed event accessible.
    for (const marker of visible
      .filter((m) => m.kind === 'round' || m.kind === 'death' || m.kind === 'win')
      .slice(0, 400)) {
      const button = document.createElement('button');
      button.className = `replay-marker event-${marker.kind}`;
      button.style.left = `${(marker.tick / Math.max(1, replay.durationTicks)) * 100}%`;
      button.title = `${timecode(marker.tick)} ${markerLabel(marker)}`;
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', () =>
        this.run(() => {
          this.port.stepFrames(0);
          this.jump(marker.tick);
        }),
      );
      markers.append(button);
    }
    events.scrollTop = scroll;
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'replay-empty';
      empty.textContent =
        timeline.status === 'indexing' ? '正在寻找事件…' : '这段录像中没有此类事件。';
      events.append(empty);
    }
    const select = this.get<HTMLSelectElement>('replay-round-select');
    select.replaceChildren(
      ...timeline.markers
        .filter((m) => m.kind === 'round')
        .map((marker) => {
          const option = document.createElement('option');
          option.value = String(marker.tick);
          option.textContent = `第 ${marker.round} 回合`;
          return option;
        }),
    );
  }
  update(frame: ReplayStudioFrame): void {
    this.frame = frame;
    const replay = frame.replay;
    this.root.hidden = !replay;
    this.host.classList.toggle('is-replay', !!replay);
    if (!replay) {
      this.active = false;
      this.dragging = false;
      this.pendingSeek = null;
      cancelAnimationFrame(this.previewFrame);
      this.previewFrame = 0;
      return;
    }
    if (!this.active || replay.id !== this.replayId) {
      this.replayId = replay.id;
      this.loopA = 0;
      this.loopB = replay.durationTicks;
      this.markerKey = '';
      this.rosterKey = '';
      this.message = '';
      this.lastRevision = -1;
    }
    this.active = true;
    this.text('replay-title', `${mapInfo(frame.state.arena.id).name} · ${replay.label}`);
    this.text(
      'replay-state',
      replay.scrubbing
        ? '定位中'
        : replay.status === 'playing'
          ? '正在回放'
          : replay.status === 'ended'
            ? '回放结束'
            : '已暂停',
    );
    this.text('replay-round', `回合 ${String(frame.state.round).padStart(2, '0')}`);
    const slider = this.get<HTMLInputElement>('playback-seek');
    if (slider.max !== String(replay.durationTicks)) {
      slider.max = String(replay.durationTicks);
      this.get('replay-ruler').replaceChildren(
        ...[0, 1, 2, 3, 4].map((part) => {
          const label = document.createElement('span');
          label.textContent = timecode(Math.floor((replay.durationTicks * part) / 4)).slice(0, 5);
          return label;
        }),
      );
    }
    if (!this.dragging) {
      slider.value = String(replay.tick);
      this.showTime(replay.tick);
    }
    slider.style.setProperty(
      '--progress',
      `${(Number(slider.value) / Math.max(1, replay.durationTicks)) * 100}%`,
    );
    slider.disabled = replay.durationTicks === 0;
    this.text(
      'playback-toggle',
      replay.status === 'playing' ? 'Ⅱ 暂停' : replay.status === 'ended' ? '↺ 重播' : '▶ 播放',
    );
    this.get<HTMLSelectElement>('playback-speed').value = String(frame.speed);
    this.get('replay-loop-toggle').setAttribute('aria-pressed', String(!!replay.loop));
    this.text(
      'replay-loop-label',
      `${replay.loop ? '循环中' : '片段'}  ${timecode(this.loopA)} → ${timecode(this.loopB)}`,
    );
    const band = this.get('replay-loop-band');
    band.hidden = !replay.loop;
    if (replay.loop) {
      band.style.left = `${(replay.loop.start / replay.durationTicks) * 100}%`;
      band.style.width = `${((replay.loop.end - replay.loop.start) / replay.durationTicks) * 100}%`;
    }
    const timeline = frame.replayTimeline;
    this.text(
      'replay-index-status',
      timeline?.status === 'indexing'
        ? `正在分析对局 ${Math.floor(timeline.progress * 100)}%`
        : timeline?.status === 'error'
          ? '事件分析失败，仍可使用时间轴定位'
          : `${timeline?.markers.length ?? 0} 个事件 · 点击可暂停定位${timeline?.omitted ? ' · 部分密集事件已省略' : ''}`,
    );
    this.renderMarkers();
    const round = timeline?.markers
      .filter((m) => m.kind === 'round' && m.tick <= replay.tick)
      .at(-1);
    if (round && document.activeElement !== this.get('replay-round-select'))
      this.get<HTMLSelectElement>('replay-round-select').value = String(round.tick);
    if (this.lastRevision !== replay.revision) {
      this.lastRevision = replay.revision;
      for (const event of this.root.querySelectorAll<HTMLElement>('.replay-event'))
        event.classList.toggle('at-playhead', Number(event.dataset.tick) === replay.tick);
    }
    const roster = frame.state.actors
      .map((a) => `${a.id}:${a.alive}:${a.score}:${a.kills}:${a.armed}:${a.powers.join(',')}`)
      .join('|');
    if (roster !== this.rosterKey) {
      this.rosterKey = roster;
      this.get('replay-players').replaceChildren(
        ...frame.state.actors.map((actor) => {
          const card = document.createElement('div');
          card.className = `replay-player${actor.alive ? '' : ' is-out'}`;
          card.style.setProperty('--actor-color', ROSTER[actor.id].color);
          const top = document.createElement('div'),
            name = document.createElement('b'),
            score = document.createElement('strong'),
            detail = document.createElement('small');
          name.textContent = actorName(actor.id);
          score.textContent = `${actor.score} 分`;
          detail.textContent = `${actor.alive ? (actor.armed ? '持镖' : '空手') : '已出局'} · ${actor.kills} 淘汰${actor.powers.length ? ` · ${actor.powers.map((p) => POWERUPS[p].name).join(' / ')}` : ''}`;
          top.append(name, score);
          card.append(top, detail);
          return card;
        }),
      );
    }
    const error = frame.replayError || this.message || timeline?.error || '';
    this.text('replay-error', error);
    this.get('replay-error').hidden = !error;
  }
  /** Called for each newly loaded file, including replacement during an active replay. */
  reset(): void {
    this.active = false;
    this.dragging = false;
    this.pendingSeek = null;
    cancelAnimationFrame(this.previewFrame);
    this.previewFrame = 0;
  }
  destroy(): void {
    this.reset();
    this.host.removeEventListener('keydown', this.keyDown, true);
    window.removeEventListener('blur', this.cancelScrub);
    this.host.classList.remove('is-replay');
    this.root.remove();
  }
}
