import * as THREE from 'three';
import { createCharacter, updateCharacter, type CharacterView } from '../rendering/characters';
import { makeActor } from '../simulation/state';
import {
  LOOK_RES,
  VOXEL_GRID,
  cleanName,
  dominantHex,
  hashOf,
  newLookId,
  presetDraw,
  removeLook,
  traitsFrom,
  upsertLook,
  voxelize,
  type AgentLibrary,
  type AgentLook,
  type Traits,
} from '../agents/look';
import './atelier.css';

/*
 * Agent atelier, after MUNDI's "Agent 形象工坊": a symmetric drawing pad with
 * brush, fill and eraser, seeded preset creatures that accept a short trait
 * description, and a live turntable of the exact in-game voxel model.
 */
const SIZES = [5, 11, 22, 40];
const SWATCHES = [
  '#C6F24E',
  '#4EE2F2',
  '#F2569E',
  '#F2A54E',
  '#A98BFA',
  '#7CE38B',
  '#FFFFFF',
  '#E9ECE6',
  '#8D949B',
  '#2B2F33',
  '#F24E4E',
  '#F2D34E',
  '#4E8CF2',
  '#8A5A2B',
  '#F29CC8',
  '#0B0D0F',
];
const BACKDROPS = ['#F3F5F2', '#0B0D0F', '#101A12', '#1A1114', '#0F1420', '#E9E1C8'];
const PRESETS = 12;
const UNDO_LIMIT = 12;

type Tool = 'brush' | 'fill' | 'erase';

export interface AtelierHost {
  library(): AgentLibrary;
  /** Adopt a new library; `use` assigns the saved agent to 1P. False: not persisted. */
  commit(library: AgentLibrary, use?: string): boolean;
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      if (!object.geometry.userData.shared) object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const mat of materials) if (!mat.userData.shared) mat.dispose();
    }
    if (object instanceof THREE.Sprite) {
      object.material.map?.dispose();
      object.material.dispose();
    }
  });
}

/** Turntable of the in-game character built from a draft look. */
class AgentTurntable {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  private view: CharacterView | null = null;
  private actor = makeActor(0, 'human', 0);
  private raf = 0;
  private start = performance.now();
  private size = '';
  readonly failed: boolean;

  constructor(private readonly canvas: HTMLCanvasElement) {
    let failed = false;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.12;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    } catch {
      failed = true;
    }
    this.failed = failed;
    this.scene.add(new THREE.HemisphereLight('#fff8df', '#769f96', 1.9));
    const sun = new THREE.DirectionalLight('#fff0ca', 2.4);
    sun.position.set(-3, 6, 5);
    this.scene.add(sun);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(1.15, 40),
      new THREE.MeshStandardMaterial({ color: '#cfe0c4', roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    this.camera.position.set(0, 2.1, 5.6);
    this.camera.lookAt(0, 1.05, 0);
    this.actor.armed = true;
    this.actor.heldDiscs = 1;
  }

  setLook(look: AgentLook | null, name: string, color: string): void {
    if (this.view) {
      this.scene.remove(this.view.root);
      disposeTree(this.view.root);
    }
    this.view = createCharacter(this.actor, { name, color, look });
    this.view.label.visible = false;
    this.scene.add(this.view.root);
  }

  run(): void {
    if (!this.renderer || this.raf) return;
    const loop = (now: number): void => {
      this.raf = requestAnimationFrame(loop);
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width)),
        height = Math.max(1, Math.round(rect.height));
      // Compare CSS sizes: the backing store is floored by fractional pixel ratios.
      if (this.size !== `${width}x${height}`) {
        this.size = `${width}x${height}`;
        this.renderer!.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
      }
      const t = (now - this.start) / 1000;
      // Face the camera most of the time, sweeping to show the block depth.
      const yaw = Math.sin(t * 0.7) * 1.1;
      this.actor.facing = { x: Math.sin(yaw), y: Math.cos(yaw) };
      if (this.view) {
        updateCharacter(this.view, this.actor, 1, t);
        this.view.label.visible = false;
        this.view.aim.visible = false;
      }
      this.renderer!.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    this.stop();
    if (this.view) disposeTree(this.view.root);
    this.renderer?.dispose();
  }
}

export class Atelier {
  readonly root: HTMLElement;
  private readonly pad: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private turntable: AgentTurntable | null = null;
  private tool: Tool = 'brush';
  private size = 1;
  private color = SWATCHES[0];
  private backdrop = BACKDROPS[0];
  private symmetric = true;
  private undo: ImageData[] = [];
  private redo: ImageData[] = [];
  private editing: AgentLook | null = null;
  private hue = '#C6F24E';
  private hueLocked = false;
  private batch = 0;
  private traits: Traits | null = null;
  private refreshTimer = 0;
  private stroke: { x: number; y: number } | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: AtelierHost,
  ) {
    this.root = document.createElement('section');
    this.root.className = 'atelier';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'atelier-title');
    this.root.innerHTML = `
      <div class="atelier-card">
        <header class="atelier-head">
          <div><span class="eyebrow">AGENT ATELIER</span><h2 id="atelier-title">捏一个 Agent</h2></div>
          <label class="atelier-name">名字<input id="agent-name" maxlength="12" autocomplete="off" spellcheck="false"></label>
          <button class="atelier-close" data-act="close" aria-label="关闭工坊">✕</button>
        </header>
        <div class="atelier-grid">
          <section class="atelier-panel atelier-preview" aria-label="三维预览">
            <span class="atelier-label">在花园里的样子</span>
            <canvas id="agent-turntable" aria-label="Agent 三维转台"></canvas>
            <p class="atelier-fallback" hidden>当前浏览器不支持 WebGL，保存后仍可在对局中使用。</p>
            <label class="atelier-hue">主色<input type="color" id="agent-hue" aria-label="Agent 主色"><button data-act="auto-hue" class="chip">跟随画面</button></label>
            <p class="atelier-tip">画出来的轮廓会变成方块头，颜色就是每一格的颜色；身体、手脚跟随主色。</p>
          </section>
          <section class="atelier-panel atelier-pad" aria-label="画板">
            <div class="atelier-tools" role="toolbar" aria-label="画板工具">
              <div class="chip-group">
                <button class="chip" data-tool="brush">✎ 画笔</button><button class="chip" data-tool="fill">◧ 填色</button><button class="chip" data-tool="erase">⌫ 橡皮</button>
              </div>
              <div class="chip-group" aria-label="粗细">${SIZES.map((_, i) => `<button class="chip size" data-size="${i}" aria-label="粗细 ${i + 1}"><i style="width:${5 + i * 4}px;height:${5 + i * 4}px"></i></button>`).join('')}</div>
              <div class="chip-group">
                <button class="chip" data-act="sym" aria-label="左右对称">⇔ 对称</button><button class="chip" data-act="undo" aria-label="撤销">↶</button><button class="chip" data-act="redo" aria-label="重做">↷</button><button class="chip" data-act="clear">清空</button>
              </div>
            </div>
            <div class="atelier-swatches" aria-label="画笔颜色">${SWATCHES.map((c) => `<button class="swatch" data-color="${c}" style="background:${c}" aria-label="颜色 ${c}"></button>`).join('')}<input type="color" id="agent-color" aria-label="自定义画笔颜色"></div>
            <div class="atelier-canvas" id="agent-pad-wrap"></div>
            <div class="atelier-backdrops"><span class="atelier-label">画板底色</span>${BACKDROPS.map((c) => `<button class="swatch small" data-backdrop="${c}" style="background:${c}" aria-label="底色 ${c}"></button>`).join('')}<span class="atelier-label">${LOOK_RES} × ${LOOK_RES} · 透明处不会变成方块</span></div>
          </section>
          <section class="atelier-panel atelier-presets" aria-label="预制形象">
            <div class="atelier-row"><span class="atelier-label">预制</span><button class="link" data-act="batch">换一批 ↻</button></div>
            <input id="agent-traits" class="atelier-traits" placeholder="描述一下：红色的龙、三只眼、机器人…" aria-label="形象描述" maxlength="40">
            <div class="atelier-preset-grid">${Array.from({ length: PRESETS }, (_, i) => `<canvas width="120" height="120" data-preset="${i}" tabindex="0" role="button" aria-label="预制形象 ${i + 1}"></canvas>`).join('')}</div>
            <button class="chip wide" data-act="random">🎲 随机一个放到画布上</button>
          </section>
        </div>
        <footer class="atelier-foot">
          <div class="atelier-gallery" id="agent-gallery" aria-label="已保存的 Agent"></div>
          <p class="atelier-status" id="agent-status" role="status"></p>
          <div class="atelier-actions">
            <button class="chip" data-act="delete">删除</button>
            <button class="chip" data-act="save">保存</button>
            <button class="primary-button compact" data-act="use">保存并用它出战 <span>↗</span></button>
          </div>
        </footer>
      </div>`;
    parent.appendChild(this.root);
    this.pad = document.createElement('canvas');
    this.pad.width = this.pad.height = LOOK_RES;
    this.pad.className = 'agent-pad';
    this.pad.setAttribute('aria-label', 'Agent 画板');
    this.ctx = this.pad.getContext('2d', { willReadFrequently: true })!;
    this.get('agent-pad-wrap').appendChild(this.pad);
    this.bind();
  }

  private get<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.root.querySelector<T>(`#${id}`)!;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Opens an existing agent, or a fresh preset when `id` is omitted. */
  open(id?: string): void {
    const look = id ? this.host.library().agents.find((agent) => agent.id === id) : undefined;
    this.root.hidden = false;
    if (!this.turntable) {
      this.turntable = new AgentTurntable(this.get<HTMLCanvasElement>('agent-turntable'));
      this.root.querySelector<HTMLElement>('.atelier-fallback')!.hidden = !this.turntable.failed;
    }
    if (look) this.load(look);
    else this.fresh();
    this.renderPresets();
    this.renderGallery();
    this.turntable.run();
    this.get<HTMLInputElement>('agent-name').focus();
  }

  close(): void {
    this.root.hidden = true;
    this.turntable?.stop();
    this.stroke = null;
    this.undo = [];
    this.redo = [];
  }

  destroy(): void {
    this.close();
    this.turntable?.dispose();
    this.root.remove();
  }

  private fresh(): void {
    this.editing = null;
    const count = this.host.library().agents.length;
    this.get<HTMLInputElement>('agent-name').value = `Agent ${count + 1}`;
    this.hueLocked = false;
    this.ctx.clearRect(0, 0, LOOK_RES, LOOK_RES);
    this.hue = presetDraw(this.ctx, LOOK_RES, hashOf(`garden|${Date.now()}`), null);
    this.undo = [];
    this.redo = [];
    this.status('从预制开始，或直接在画板上画');
    this.refresh(true);
  }

  private load(look: AgentLook): void {
    this.editing = look;
    this.get<HTMLInputElement>('agent-name').value = look.name;
    this.backdrop = look.bg;
    this.hue = look.hue;
    this.hueLocked = true;
    this.undo = [];
    this.redo = [];
    this.ctx.clearRect(0, 0, LOOK_RES, LOOK_RES);
    const image = new Image();
    image.onload = () => {
      this.ctx.clearRect(0, 0, LOOK_RES, LOOK_RES);
      this.ctx.drawImage(image, 0, 0, LOOK_RES, LOOK_RES);
      this.refresh(false);
    };
    image.src = look.img;
    this.status(`正在编辑 ${look.name}`);
    this.refresh(false);
  }

  private status(text: string): void {
    this.get('agent-status').textContent = text;
  }

  /* ----------------------------------------------------------- drawing */

  private snapshot(): void {
    this.undo.push(this.ctx.getImageData(0, 0, LOOK_RES, LOOK_RES));
    if (this.undo.length > UNDO_LIMIT) this.undo.shift();
    this.redo = [];
  }

  private position(event: PointerEvent): [number, number] {
    const rect = this.pad.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) * LOOK_RES) / rect.width,
      ((event.clientY - rect.top) * LOOK_RES) / rect.height,
    ];
  }

  private segment(x0: number, y0: number, x1: number, y1: number): void {
    const c = this.ctx;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = SIZES[this.size];
    c.globalCompositeOperation = this.tool === 'erase' ? 'destination-out' : 'source-over';
    c.strokeStyle = this.tool === 'erase' ? '#000' : this.color;
    const draw = (a: number, b: number, d: number, e: number): void => {
      c.beginPath();
      c.moveTo(a, b);
      c.lineTo(d, e);
      c.stroke();
    };
    draw(x0, y0, x1, y1);
    if (this.symmetric) draw(LOOK_RES - x0, y0, LOOK_RES - x1, y1);
    c.globalCompositeOperation = 'source-over';
  }

  /** Scanline flood fill with MUNDI's tolerance (sum of channel differences < 90). */
  private fill(sx: number, sy: number, color: string | null): void {
    const W = LOOK_RES,
      image = this.ctx.getImageData(0, 0, W, W),
      d = image.data;
    const i0 = (sy * W + sx) * 4;
    const target = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]];
    const fill = color
      ? [
          parseInt(color.slice(1, 3), 16),
          parseInt(color.slice(3, 5), 16),
          parseInt(color.slice(5, 7), 16),
          255,
        ]
      : [0, 0, 0, 0];
    if (target.reduce((sum, v, k) => sum + Math.abs(v - fill[k]), 0) < 8) return;
    const near = (i: number): boolean =>
      Math.abs(d[i] - target[0]) +
        Math.abs(d[i + 1] - target[1]) +
        Math.abs(d[i + 2] - target[2]) +
        Math.abs(d[i + 3] - target[3]) <
      90;
    const seen = new Uint8Array(W * W),
      stack = [sy * W + sx];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen[p]) continue;
      const y = Math.floor(p / W),
        row = y * W;
      let l = p,
        r = p;
      while (l > row && near((l - 1) * 4) && !seen[l - 1]) l--;
      while (r < row + W - 1 && near((r + 1) * 4) && !seen[r + 1]) r++;
      for (let q = l; q <= r; q++) {
        seen[q] = 1;
        d.set(fill, q * 4);
        if (y > 0 && !seen[q - W] && near((q - W) * 4)) stack.push(q - W);
        if (y < W - 1 && !seen[q + W] && near((q + W) * 4)) stack.push(q + W);
      }
    }
    this.ctx.putImageData(image, 0, 0);
  }

  private applyPreset(seed: number): void {
    this.snapshot();
    this.ctx.clearRect(0, 0, LOOK_RES, LOOK_RES);
    const hue = presetDraw(this.ctx, LOOK_RES, seed, this.traits);
    if (!this.hueLocked) this.hue = hue;
    this.refresh(true);
  }

  /* ------------------------------------------------------------ looks */

  private voxels(): ReturnType<typeof voxelize> {
    const small = document.createElement('canvas');
    small.width = small.height = VOXEL_GRID;
    const c = small.getContext('2d', { willReadFrequently: true })!;
    c.imageSmoothingEnabled = true;
    c.drawImage(this.pad, 0, 0, VOXEL_GRID, VOXEL_GRID);
    return voxelize(c.getImageData(0, 0, VOXEL_GRID, VOXEL_GRID), VOXEL_GRID);
  }

  private draft(): AgentLook {
    return {
      v: 1,
      id: this.editing?.id ?? 'draft',
      name: cleanName(this.get<HTMLInputElement>('agent-name').value),
      img: '',
      bg: this.backdrop,
      hue: this.hue,
      grid: VOXEL_GRID,
      runs: this.voxels(),
      updated: Date.now(),
    };
  }

  /** Updates tool states, then rebuilds the turntable model shortly after edits settle. */
  private refresh(changed: boolean): void {
    if (changed && !this.hueLocked) {
      const sample = document.createElement('canvas');
      sample.width = sample.height = 40;
      const c = sample.getContext('2d', { willReadFrequently: true })!;
      c.drawImage(this.pad, 0, 0, 40, 40);
      this.hue = dominantHex(c.getImageData(0, 0, 40, 40)) ?? this.hue;
    }
    const q = (selector: string) => this.root.querySelectorAll<HTMLElement>(selector);
    q('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === this.tool));
    q('[data-size]').forEach((b) => b.classList.toggle('on', Number(b.dataset.size) === this.size));
    q('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === this.color));
    q('[data-backdrop]').forEach((b) =>
      b.classList.toggle('on', b.dataset.backdrop === this.backdrop),
    );
    q('[data-act="sym"]').forEach((b) => b.classList.toggle('on', this.symmetric));
    q('[data-act="auto-hue"]').forEach((b) => b.classList.toggle('on', !this.hueLocked));
    this.get<HTMLInputElement>('agent-color').value = this.color.toLowerCase();
    this.get<HTMLInputElement>('agent-hue').value = this.hue.toLowerCase();
    this.get('agent-pad-wrap').style.background = this.backdrop;
    this.root.querySelector<HTMLButtonElement>('[data-act="delete"]')!.disabled = !this.editing;
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      const look = this.draft();
      this.turntable?.setLook(look.runs.length ? look : null, look.name, this.hue);
    }, 90);
  }

  private save(use: boolean): void {
    const draft = this.draft();
    if (!draft.runs.length) {
      this.status('画板是空的 · 先画点什么，或选一个预制');
      return;
    }
    const look: AgentLook = {
      ...draft,
      id: this.editing?.id ?? newLookId(),
      img: this.pad.toDataURL('image/png'),
    };
    this.editing = look;
    const persisted = this.host.commit(
      upsertLook(this.host.library(), look),
      use ? look.id : undefined,
    );
    this.renderGallery();
    this.status(
      (use ? `${look.name} 已保存，下一局由 1P 使用` : `${look.name} 已保存`) +
        (persisted ? '' : ' · 浏览器存储不可用，刷新后会丢失'),
    );
    this.refresh(false);
    if (use && persisted) this.close();
  }

  private remove(): void {
    if (!this.editing) return;
    const name = this.editing.name;
    this.host.commit(removeLook(this.host.library(), this.editing.id));
    this.fresh();
    this.renderGallery();
    this.status(`已删除 ${name}`);
  }

  private renderPresets(): void {
    const base = cleanName(this.get<HTMLInputElement>('agent-name').value);
    this.root.querySelectorAll<HTMLCanvasElement>('[data-preset]').forEach((canvas, i) => {
      const seed = hashOf(`${base}|preset|${this.batch}|${i}`);
      canvas.dataset.seed = String(seed);
      const c = canvas.getContext('2d')!;
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.fillStyle = this.backdrop;
      c.fillRect(0, 0, canvas.width, canvas.height);
      presetDraw(c, canvas.width, seed, this.traits);
    });
  }

  private renderGallery(): void {
    const gallery = this.get('agent-gallery');
    gallery.replaceChildren();
    const fresh = document.createElement('button');
    fresh.className = 'gallery-item new';
    fresh.textContent = '＋ 新建';
    fresh.addEventListener('click', () => {
      this.fresh();
      this.renderPresets();
    });
    gallery.appendChild(fresh);
    for (const look of this.host.library().agents) {
      const item = document.createElement('button');
      item.className = `gallery-item${this.editing?.id === look.id ? ' on' : ''}`;
      item.style.setProperty('--agent-bg', look.bg);
      item.title = look.name;
      const img = document.createElement('img');
      img.src = look.img;
      img.alt = '';
      const label = document.createElement('span');
      label.textContent = look.name;
      item.append(img, label);
      item.addEventListener('click', () => {
        this.load(look);
        this.renderGallery();
      });
      gallery.appendChild(item);
    }
  }

  /* ------------------------------------------------------------ events */

  private bind(): void {
    const pad = this.pad;
    pad.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      pad.setPointerCapture(event.pointerId);
      const [x, y] = this.position(event);
      if (this.tool === 'fill') {
        this.snapshot();
        const px = Math.max(0, Math.min(LOOK_RES - 1, Math.round(x))),
          py = Math.max(0, Math.min(LOOK_RES - 1, Math.round(y)));
        this.fill(px, py, this.color);
        if (this.symmetric) this.fill(LOOK_RES - 1 - px, py, this.color);
        this.refresh(true);
        return;
      }
      this.snapshot();
      this.stroke = { x, y };
      this.segment(x, y, x, y);
    });
    pad.addEventListener('pointermove', (event) => {
      if (!this.stroke) return;
      const events = event.getCoalescedEvents?.() ?? [event];
      for (const sample of events.length ? events : [event]) {
        const [x, y] = this.position(sample);
        this.segment(this.stroke.x, this.stroke.y, x, y);
        this.stroke = { x, y };
      }
    });
    const end = (): void => {
      if (!this.stroke) return;
      this.stroke = null;
      this.refresh(true);
    };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
    this.root.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-tool],[data-size],[data-color],[data-backdrop],[data-act],[data-preset]',
      );
      if (!target || !this.root.contains(target)) return;
      const { tool, size, color, backdrop, act, preset } = target.dataset;
      if (tool) this.tool = tool as Tool;
      else if (size) this.size = Number(size);
      else if (color) {
        this.color = color;
        if (this.tool === 'erase') this.tool = 'brush';
      } else if (backdrop) {
        this.backdrop = backdrop;
        this.renderPresets();
      } else if (preset !== undefined) {
        this.applyPreset(Number(target.dataset.seed));
        return;
      } else if (act === 'sym') this.symmetric = !this.symmetric;
      else if (act === 'undo' || act === 'redo') {
        const from = act === 'undo' ? this.undo : this.redo,
          to = act === 'undo' ? this.redo : this.undo;
        const image = from.pop();
        if (!image) return;
        to.push(this.ctx.getImageData(0, 0, LOOK_RES, LOOK_RES));
        this.ctx.putImageData(image, 0, 0);
        this.refresh(true);
        return;
      } else if (act === 'clear') {
        this.snapshot();
        this.ctx.clearRect(0, 0, LOOK_RES, LOOK_RES);
        this.refresh(true);
        return;
      } else if (act === 'batch') {
        this.batch++;
        this.renderPresets();
      } else if (act === 'random') {
        this.applyPreset((Math.random() * 4294967295) >>> 0);
        return;
      } else if (act === 'auto-hue') {
        this.hueLocked = false;
        this.refresh(true);
        return;
      } else if (act === 'save') return this.save(false);
      else if (act === 'use') return this.save(true);
      else if (act === 'delete') return this.remove();
      else if (act === 'close') return this.close();
      this.refresh(false);
    });
    this.root.querySelectorAll<HTMLCanvasElement>('[data-preset]').forEach((canvas) =>
      canvas.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.applyPreset(Number(canvas.dataset.seed));
      }),
    );
    this.get<HTMLInputElement>('agent-color').addEventListener('input', (event) => {
      this.color = (event.target as HTMLInputElement).value;
      if (this.tool === 'erase') this.tool = 'brush';
      this.refresh(false);
    });
    this.get<HTMLInputElement>('agent-hue').addEventListener('input', (event) => {
      this.hue = (event.target as HTMLInputElement).value;
      this.hueLocked = true;
      this.refresh(false);
    });
    this.get<HTMLInputElement>('agent-name').addEventListener('input', () => this.refresh(false));
    let traitTimer = 0;
    this.get<HTMLInputElement>('agent-traits').addEventListener('input', (event) => {
      window.clearTimeout(traitTimer);
      const text = (event.target as HTMLInputElement).value;
      traitTimer = window.setTimeout(() => {
        const traits = traitsFrom(text);
        this.traits = Object.keys(traits).length ? traits : null;
        this.renderPresets();
      }, 160);
    });
    // Keep game shortcuts (Esc pause, M mute, movement) out of the dialog.
    this.root.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') this.close();
      const editable = event.target instanceof HTMLInputElement;
      if (!editable && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        this.root
          .querySelector<HTMLElement>(event.shiftKey ? '[data-act="redo"]' : '[data-act="undo"]')!
          .click();
      }
    });
  }
}
