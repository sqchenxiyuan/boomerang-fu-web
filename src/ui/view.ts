import { POWERUPS, ROSTER, RULES } from '../core/config';
import { MAPS, mapInfo } from '../core/arena';
import { PRESENTATION, transitionPresentation } from '../core/presentation';
import { boundaryNotice, eliminationLabel } from '../core/feedback';
import { clamp } from '../core/math';
import type {
  Difficulty,
  GameEvent,
  GameState,
  MatchOptions,
  MapId,
  MapRotation,
  PowerupKind,
} from '../core/types';

const boomerang =
  '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="m8 10 9-2 9 16 15-1 3 10-24 3Z" fill="currentColor"/><path d="m14 12 10 18 14-1" stroke="white" stroke-opacity=".5" stroke-width="2" stroke-linecap="round"/></svg>';
const soundIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4Z" stroke-linejoin="round"/><path d="M16 8c2 2 2 6 0 8m3-11c4 4 4 10 0 14" stroke-linecap="round"/></svg>';
const fullIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const key = (text: string) => `<kbd>${text}</kbd>`;

export class View {
  readonly stage: HTMLElement;
  onStart = (_options: MatchOptions): void => {};
  onPreviewMap = (_id: MapId): void => {};
  onPause = (): void => {};
  onResume = (): void => {};
  onMenu = (): void => {};
  onRestart = (): void => {};
  onSound = (): void => {};
  onFullscreen = (): void => {};
  private root: HTMLElement;
  private menu: HTMLElement;
  private pause: HTMLElement;
  private result: HTMLElement;
  private hud: HTMLElement;
  private scoreboard: HTMLElement;
  private center: HTMLElement;
  private mode: 'menu' | 'playing' | 'paused' | 'ended' = 'menu';
  private lastScores = '';
  private lastAbilities = '';
  private toastUntil = 0;
  private muted = false;
  private htmlCache = new Map<HTMLElement, string>();

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="stage" id="stage"></div>
      <div class="transition-wipe" id="transition-wipe" aria-hidden="true" hidden></div>
      <div class="vignette" aria-hidden="true"></div>
      <header class="topbar">
        <a class="brand" href="#" id="brand" aria-label="回到主菜单"><span class="brand-mark">${boomerang}</span><span>回旋花园<small>BOOMERANG GARDEN</small></span></a>
        <div class="top-actions"><span class="edition">一场小小的食物大战</span><button class="icon-button" id="sound" title="音效开关 · M" aria-label="关闭音效">${soundIcon}</button><button class="icon-button" id="fullscreen" title="全屏" aria-label="切换全屏">${fullIcon}</button><button class="icon-button pause-button" id="pause-button" title="暂停 · Esc" aria-label="暂停游戏" hidden>Ⅱ</button></div>
      </header>
      <section class="menu-card" id="menu" aria-labelledby="menu-title">
        <div class="eyebrow"><span class="live-dot"></span> COURTYARD CLUB · 01</div>
        <h1 id="menu-title">小小花园，<br>大大<span>回旋。</span></h1>
        <p class="intro">扔出去，接回来。<br>和食物伙伴过上几招，最后站着的人赢。</p>
        <div class="mode-selector" role="group" aria-label="游戏模式"><button class="mode selected" data-mode="solo" aria-pressed="true">单人挑战 <span>VS 机器人</span></button><button class="mode" data-mode="local" aria-pressed="false">同屏双人 <span>和朋友一起</span></button></div>
        <div class="settings-row"><label>机器人<select id="bots" aria-label="机器人数量"><option value="1">1 位对手</option><option value="3">3 位对手</option></select></label><label>难度<select id="difficulty" aria-label="机器人难度"><option value="easy">轻松</option><option value="normal" selected>标准</option><option value="hard">挑战</option></select></label></div>
        <div class="settings-row map-settings"><label>地图<select id="map" aria-label="地图">${MAPS.map((map) => `<option value="${map.id}">${map.name}</option>`).join('')}</select></label><label>回合换图<select id="rotation" aria-label="回合换图"><option value="fixed">固定地图</option><option value="cycle">依次轮换</option></select></label></div>
        <p class="map-description" id="map-description">${MAPS[0].description}</p>
        <div class="settings-row"><label>决胜缩圈<select id="sudden-death" aria-label="决胜缩圈时间"><option value="180">180 秒 · 原版节奏</option><option value="60">60 秒</option><option value="30">30 秒 · 快速体验</option></select></label></div>
        <button class="primary-button" id="start">进入花园 <span>↗</span></button>
        <div class="match-meta"><span>先得 5 分</span><span>五张地图</span><span>支持手柄</span></div>
        <details class="instructions"><summary>第一次玩？看看操作 <span>＋</span></summary><div class="instruction-content">
          <p><b>1P</b> ${key('W A S D')} 移动 · ${key('J')} 近战 · ${key('K')} 投掷 · ${key('L / 空格')} 冲刺</p>
          <p><b>2P</b> ${key('↑ ↓ ← →')} 移动 · ${key(',')} 近战 · ${key('.')} 投掷 · ${key('/')} 冲刺；也支持小键盘 1 / 2 / 3。</p>
          <p>按住投掷蓄力，松开出手；空手时按住同一键召回。挥砍能反弹飞镖，冲刺能躲攻击、越过水坑。刚开始下落时可冲刺自救一次。</p>
          <p>决胜时矩形边界向箭头收缩。出界后有短暂返回时间，倒计时结束即出局。</p>
          <p>手柄：左摇杆移动 · X 近战 · B / RB 蓄力投掷 · A 冲刺 · Start 暂停。两支手柄按连接顺序分配。</p>
          <p>开始后 1.2 秒自动发镖，无需寻找武器。配方书有 14 种效果，最多保留 3 个强化；第 4 个替换最早获得的。火与冰互斥。</p>
        </div></details>
        <details class="instructions powerup-guide"><summary>14 种道具 · 组合试验 <span>＋</span></summary><div class="instruction-content">
          <p>选最多三种效果开始练习，全员使用相同配方；头昏眼花与缩圈只在开场触发。留空恢复普通随机对局。</p>
          <div class="loadout-selects">${[1, 2, 3]
            .map(
              (i) =>
                `<label>配方 ${i}<select id="power-${i}" aria-label="配方 ${i}"><option value="">不指定</option>${Object.entries(
                  POWERUPS,
                )
                  .map(([id, p]) => `<option value="${id}">${p.name}</option>`)
                  .join('')}</select></label>`,
            )
            .join('')}</div>
          <button class="secondary-button" id="practice-start">带此配方进入花园</button>
          <div class="powerup-catalog">${Object.values(POWERUPS)
            .map(
              (p) =>
                `<p><b style="color:${p.color}">${p.short} · ${p.name}</b><span>${p.description}</span></p>`,
            )
            .join('')}</div>
        </div></details>
      </section>
      <div class="scene-caption" id="scene-caption"><span class="location-dot">✦</span><div>山间庭院<small>THE LITTLE COURTYARD</small></div><span class="scene-line"></span><span>短回合 · 随时再来</span></div>
      <div class="hud" id="hud" hidden>
        <div class="scoreboard" id="scoreboard"></div>
        <div class="round-chip"><span id="round-label">ROUND 01</span><i></i><span id="round-timer">00:00</span></div>
        <div class="abilities" id="abilities"></div>
        <div class="control-strip" id="control-strip"></div>
        <div class="danger-note" id="danger-note" role="status" hidden></div>
      </div>
      <div class="center-message" id="center" aria-live="polite"></div>
      <div class="toast" id="toast" role="status" hidden></div>
      <div class="modal-backdrop" id="pause" hidden><section class="modal pause-modal" role="dialog" aria-modal="true" aria-labelledby="pause-title"><span class="eyebrow">TAKE A BREATHER</span><h2 id="pause-title">歇一小会儿</h2><p>花园里的时间已经停下。</p><button class="primary-button" id="resume">继续对局 <span>↗</span></button><button class="secondary-button" id="pause-restart">重新开始这场</button><button class="text-button" id="return-menu">返回主菜单</button><small>Esc 也可以继续</small></section></div>
      <div class="modal-backdrop" id="result" hidden><section class="modal result-modal" role="dialog" aria-modal="true" aria-labelledby="result-title"><div class="trophy">✦</div><span class="eyebrow">GARDEN CHAMPION</span><h2 id="result-title"></h2><p id="result-subtitle"></p><div id="final-scores"></div><button class="primary-button" id="replay">再来一场 <span>↗</span></button><button class="text-button" id="result-menu">返回主菜单</button></section></div>
      <footer class="menu-footer" id="menu-footer"><span>THROW. DODGE. REPEAT.</span><span>花园已开放 <i>✳</i></span></footer>`;
    this.stage = this.get('stage');
    this.menu = this.get('menu');
    this.pause = this.get('pause');
    this.result = this.get('result');
    this.hud = this.get('hud');
    this.scoreboard = this.get('scoreboard');
    this.center = this.get('center');
    let selectedMode: MatchOptions['mode'] = 'solo';
    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) =>
      button.addEventListener('click', () => {
        selectedMode = button.dataset.mode as MatchOptions['mode'];
        root.querySelectorAll('[data-mode]').forEach((b) => {
          b.classList.toggle('selected', b === button);
          b.setAttribute('aria-pressed', String(b === button));
        });
        this.get<HTMLSelectElement>('bots').innerHTML =
          selectedMode === 'solo'
            ? '<option value="1">1 位对手</option><option value="3">3 位对手</option>'
            : '<option value="0">只有我们俩</option><option value="2">再加 2 位</option>';
      }),
    );
    const start = (practice = false): void => {
      const powers = practice
        ? ([
            ...new Set(
              [1, 2, 3].map((i) => this.get<HTMLSelectElement>(`power-${i}`).value).filter(Boolean),
            ),
          ] as PowerupKind[])
        : [];
      this.onStart({
        mode: selectedMode,
        bots: Number(this.get<HTMLSelectElement>('bots').value),
        difficulty: this.get<HTMLSelectElement>('difficulty').value as Difficulty,
        seed: crypto.getRandomValues(new Uint32Array(1))[0],
        scoreGoal: 5,
        mapId: this.get<HTMLSelectElement>('map').value as MapId,
        mapRotation: this.get<HTMLSelectElement>('rotation').value as MapRotation,
        suddenDeathTime: Number(this.get<HTMLSelectElement>('sudden-death').value),
        startingPowers: powers,
        powerupPool: powers.length ? powers : (Object.keys(POWERUPS) as PowerupKind[]),
      });
    };
    this.get('start').addEventListener('click', () => start());
    this.get('practice-start').addEventListener('click', () => start(true));
    this.get('map').addEventListener('change', () => {
      const id = this.get<HTMLSelectElement>('map').value as MapId;
      const info = mapInfo(id);
      this.get('map-description').textContent = info.description;
      this.get('scene-caption').innerHTML =
        `<span class="location-dot">✦</span><div>${info.name}<small>${info.subtitle}</small></div><span class="scene-line"></span><span>短回合 · 随时再来</span>`;
      this.onPreviewMap(id);
    });
    this.get('pause-button').addEventListener('click', () => this.onPause());
    this.get('resume').addEventListener('click', () => this.onResume());
    this.get('pause-restart').addEventListener('click', () => this.onRestart());
    this.get('return-menu').addEventListener('click', () => this.onMenu());
    this.get('result-menu').addEventListener('click', () => this.onMenu());
    this.get('replay').addEventListener('click', () => this.onRestart());
    this.get('brand').addEventListener('click', (event) => {
      event.preventDefault();
      if (this.mode !== 'menu') this.onPause();
    });
    this.get('sound').addEventListener('click', () => this.onSound());
    this.get('fullscreen').addEventListener('click', () => this.onFullscreen());
  }

  private get<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.root.querySelector<T>(`#${id}`)!;
  }

  private text(id: string, value: string): void {
    const element = this.get(id);
    if (element.textContent !== value) element.textContent = value;
  }

  private html(element: HTMLElement, value: string): void {
    if (this.htmlCache.get(element) === value) return;
    this.htmlCache.set(element, value);
    element.innerHTML = value;
  }

  setMode(mode: typeof this.mode): void {
    this.mode = mode;
    this.menu.hidden = mode !== 'menu';
    this.get('scene-caption').hidden = mode !== 'menu';
    this.get('menu-footer').hidden = mode !== 'menu';
    this.hud.hidden = mode === 'menu';
    this.pause.hidden = mode !== 'paused';
    this.result.hidden = mode !== 'ended';
    this.get('pause-button').hidden = mode !== 'playing';
    this.center.hidden = mode !== 'playing';
    if (mode === 'menu') this.get('transition-wipe').hidden = true;
    this.root.classList.toggle('in-game', mode !== 'menu');
    if (mode === 'paused') this.get('resume').focus();
    if (mode === 'ended') this.get('replay').focus();
    if (mode === 'menu') {
      this.lastScores = '';
      this.lastAbilities = '';
      this.get('toast').hidden = true;
    }
  }

  setSound(muted: boolean): void {
    this.muted = muted;
    const button = this.get('sound');
    button.classList.toggle('is-muted', muted);
    button.setAttribute('aria-label', muted ? '开启音效' : '关闭音效');
    button.setAttribute('aria-pressed', String(muted));
  }

  events(events: GameEvent[], elapsed: number): void {
    for (const event of events) {
      if (event.type === 'pickup' && event.power) {
        this.get('toast').textContent =
          `${ROSTER[event.actorId].name} 获得${POWERUPS[event.power].name} · ${POWERUPS[event.power].description}`;
        this.toastUntil = elapsed + 2.7;
        this.get('toast').hidden = false;
      }
    }
    if (events.some((event) => event.type === 'equip' && event.actorId === 0)) {
      this.text('toast', '回旋镖已就绪！按 K 蓄力投掷 · J 挥砍');
      this.toastUntil = elapsed + 2;
      this.get('toast').hidden = false;
    }
  }

  update(state: GameState, elapsed: number): void {
    if (elapsed > this.toastUntil) this.get('toast').hidden = true;
    if (this.mode === 'menu') return;
    const presentation = transitionPresentation(state);
    const wipe = this.get('transition-wipe');
    wipe.hidden = presentation.wipeRadius >= 1 || state.phase === 'matchEnd';
    const radius =
      (presentation.wipeRadius * Math.hypot(this.root.clientWidth, this.root.clientHeight)) / 2;
    if (!wipe.hidden)
      wipe.style.maskImage = `radial-gradient(circle at center, transparent ${Math.max(0, radius - 1)}px, black ${radius}px)`;
    if (wipe.dataset.stage !== presentation.stage) wipe.dataset.stage = presentation.stage;
    const scores = state.actors
      .map(
        (a) =>
          `${a.id}:${a.score}:${a.alive}:${a.controller}:${a.humanIndex}:${eliminationLabel(a)}`,
      )
      .join('|');
    if (scores !== this.lastScores) {
      this.lastScores = scores;
      this.get('control-strip').innerHTML =
        state.options.mode === 'local'
          ? `<span>1P ${key('WASD')} ${key('J K L')}</span><span>2P ${key('↑↓←→')} ${key(', . /')}</span><span>近战 / 投掷 / 冲刺</span><span>${key('Esc')} 暂停</span>`
          : `<span>${key('WASD')} 移动</span><span>${key('J')} 挥砍</span><span>${key('K')} 按住蓄力 / 召回</span><span>${key('L')} 冲刺</span><span>${key('Esc')} 暂停</span>`;
      this.scoreboard.innerHTML = state.actors
        .map(
          (actor) =>
            `<div class="score-card ${actor.alive ? '' : 'eliminated'}" style="--player-color:${ROSTER[actor.id].color}"><div class="player-token">${actor.id === 0 ? '瓜' : actor.id === 1 ? '茄' : actor.id === 2 ? '橙' : '奶'}</div><div class="score-name">${ROSTER[actor.id].name}<small>${eliminationLabel(actor) || (actor.controller === 'human' ? `${actor.humanIndex + 1}P` : 'BOT')}</small></div><strong>${actor.score}</strong><div class="score-dots">${Array.from({ length: state.options.scoreGoal }, (_, i) => `<i class="${i < actor.score ? 'filled' : ''}"></i>`).join('')}</div></div>`,
        )
        .join('<span class="vs">·</span>');
    }
    this.text(
      'round-label',
      `${mapInfo(state.arena.id).name} · ROUND ${String(state.round).padStart(2, '0')}`,
    );
    this.text(
      'round-timer',
      `${String(Math.floor(state.roundTime / 60)).padStart(2, '0')}:${String(Math.floor(state.roundTime % 60)).padStart(2, '0')}`,
    );
    const danger = boundaryNotice(state);
    this.get('danger-note').hidden = !danger;
    this.text('danger-note', danger);
    const equipLeft = Math.max(0, PRESENTATION.equipDelay - state.roundTime).toFixed(1);
    const humans = state.actors.filter((a) => a.controller === 'human');
    const abilities = humans
      .map(
        (a) =>
          `${a.id}:${a.alive}:${eliminationLabel(a)}:${state.weaponsGranted ? 'ready' : equipLeft}:${a.armed}:${a.heldDiscs}:${a.recalling}:${a.controlling}:${a.disguised}:${Math.ceil(a.reverseTime ?? 0)}:${Math.ceil(a.frozenTime ?? 0)}:${Math.ceil(a.burnTime ?? 0)}:${Math.round(a.charge * 20)}:${Math.round(a.dashCooldown * 20)}:${a.powers.join(',')}`,
      )
      .join('|');
    if (abilities !== this.lastAbilities) {
      this.lastAbilities = abilities;
      this.get('abilities').innerHTML = humans
        .map((actor) => {
          const ready = actor.dashCooldown <= 0;
          const disc = state.discs.find((d) => d.ownerId === actor.id);
          const weapon =
            !actor.alive || actor.fall
              ? eliminationLabel(actor)
              : !state.weaponsGranted
                ? `自动发镖 · ${equipLeft} 秒`
                : (actor.frozenTime ?? 0) > 0
                  ? `冰冻 · ${Math.ceil(actor.frozenTime!)} 秒`
                  : (actor.reverseTime ?? 0) > 0
                    ? `方向反转 · ${Math.ceil(actor.reverseTime!)} 秒`
                    : (actor.burnTime ?? 0) > 0
                      ? '着火了 · 快移动或寻找冰面'
                      : actor.disguised
                        ? '伪装中 · 行动解除'
                        : actor.controlling
                          ? '遥控中 · 方向键转向'
                          : actor.armed
                            ? actor.charge > 0.1
                              ? '蓄力中…'
                              : `回旋镖就绪${actor.heldDiscs === 2 ? ' ×2' : ''}`
                            : disc?.explosive
                              ? '爆炸镖在场'
                              : actor.recalling
                                ? '召回中…'
                                : '按住投掷键召回';
          return `<div class="ability-card" style="--player-color:${ROSTER[actor.id].color}"><div class="ability-top"><span class="small-token">${actor.humanIndex + 1}P</span><b>${weapon}</b><span class="power-icons">${actor.powers.map((p) => `<i style="--power:${POWERUPS[p].color}" title="${POWERUPS[p].description}">${POWERUPS[p].short}</i>`).join('')}</span></div><div class="ability-meters"><span>冲刺 <i><em style="width:${ready ? 100 : clamp(1 - actor.dashCooldown / (RULES.dashCooldown * (actor.powers.includes('haste') ? 0.6 : 1)), 0, 1) * 100}%"></em></i><small>${ready ? '就绪' : '恢复'}</small></span><span>蓄力 <i><em class="charge-fill" style="width:${(actor.charge / RULES.chargeTime) * 100}%"></em></i></span></div></div>`;
        })
        .join('');
    }
    if (state.phase === 'countdown') {
      this.html(
        this.center,
        `<div class="countdown"><small>第 ${state.round} 回合 · ${mapInfo(state.arena.id).name}</small><strong>${presentation.label}</strong><span>${presentation.stage === 'ready' ? '开始后 1.2 秒自动发镖' : '伙伴们正在入场'}</span></div>`,
      );
    } else if (state.phase === 'roundEnd') {
      const winner = state.winnerId === null ? null : ROSTER[state.winnerId];
      this.html(
        this.center,
        `<div class="round-banner"><span class="eyebrow">${presentation.showScores ? 'ROUND SCORES' : winner ? 'ROUND SURVIVED' : 'WHAT A ROUND'}</span><h2>${winner ? `${winner.name}赢下这一回合` : '无人存活 · 平局'}</h2><p>${presentation.showScores ? state.actors.map((a) => `${ROSTER[a.id].name} ${a.score}`).join(' · ') : winner ? '＋1 分' : '本回合不计分'}<span>下一回合马上开始</span></p></div>`,
      );
    } else if (presentation.stage === 'go')
      this.html(this.center, '<div class="go-text">开始！</div>');
    else this.html(this.center, '');
    const banner = this.center.firstElementChild as HTMLElement | null;
    if (banner) {
      banner.style.transform = `scale(${presentation.labelScale})`;
      banner.style.opacity = String(presentation.showScores ? presentation.scoreOpacity : 1);
    }
    if (state.phase === 'matchEnd' && this.mode !== 'ended') {
      const winner = state.actors.find((a) => a.id === state.matchWinnerId)!;
      this.get('result-title').textContent = `${ROSTER[winner.id].name}，花园冠军！`;
      this.get('result-subtitle').textContent =
        winner.controller === 'human'
          ? '漂亮的一局。回旋镖还想再飞一会儿。'
          : '差一点点。下次试试用挥砍反弹它的飞镖。';
      this.get('final-scores').innerHTML = [...state.actors]
        .sort((a, b) => b.score - a.score)
        .map(
          (a) =>
            `<div class="final-score"><span><i style="background:${ROSTER[a.id].color}"></i>${ROSTER[a.id].name}<small>${a.controller === 'human' ? `${a.humanIndex + 1}P` : 'BOT'}</small></span><b>${a.score}<small> 分</small></b></div>`,
        )
        .join('');
      this.setMode('ended');
    }
  }

  renderError(message: string): void {
    this.menu.innerHTML = `<span class="eyebrow">画面未能启动</span><h1>需要 WebGL 2</h1><p class="intro">请使用支持硬件加速的 Chrome、Edge 或 Firefox，然后刷新页面。</p><p id="error-detail"></p>`;
    this.get('error-detail').textContent = message;
  }
  get isMuted(): boolean {
    return this.muted;
  }
}
