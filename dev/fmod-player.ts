/**
 * Minimal FMOD Studio HTML5 player for dev/sfx.html. The init sequence mirrors
 * the Godot port's bridge (arkevo-games/games/boomerangfu/web/audio/runtime.js).
 * Files come from the dev-only `/__godot-audio/` middleware in vite.config.ts.
 */
type Fmod = any;
const BASE = '/__godot-audio/';
const BANKS = ['Master Bank.strings.bank', 'Master Bank.bank'];
// FMOD_STUDIO_PARAMETER_FLAGS: hide parameters the game never sets per instance.
const READONLY = 1,
  AUTOMATIC = 2,
  GLOBAL = 4;

export interface FmodParameter {
  name: string;
  min: number;
  max: number;
  value: number;
}
export interface FmodEventInfo {
  oneShot: boolean;
  lengthMs: number;
  parameters: FmodParameter[];
}
export type FmodPhase = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

declare global {
  interface Window {
    FMODModule?: (options: Record<string, unknown>) => Promise<Fmod>;
  }
}

export class FmodPlayer {
  phase: FmodPhase = 'idle';
  message = '';
  bankEvents: string[] = [];
  private F: Fmod = null;
  private studio: Fmod = null;
  private core: Fmod = null;
  private bus: Fmod = null;
  private playing = new Set<Fmod>();
  private timer = 0;
  private unlocked = false;

  private check(result: number, name: string): void {
    if (result !== this.F.OK) throw new Error(`${name}: ${this.F.ErrorString(result)}`);
  }
  private get(target: Fmod, method: string, ...args: unknown[]): Fmod {
    const out: Fmod = {};
    this.check(target[method](...args, out), method);
    return out.val === undefined ? out : out.val;
  }

  async status(): Promise<{ available: boolean; dir: string; missing: string[] }> {
    const response = await fetch(`${BASE}status`);
    if (!response.ok) throw new Error('dev server has no /__godot-audio middleware');
    return response.json();
  }

  async load(): Promise<void> {
    if (this.phase === 'loading' || this.phase === 'ready') return;
    this.phase = 'loading';
    try {
      const status = await this.status();
      if (!status.available) {
        this.phase = 'unavailable';
        this.message = `未找到原版 FMOD 文件：${status.missing.join('、')}（目录 ${status.dir}，可用 GODOT_AUDIO_DIR 指定）`;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        if (window.FMODModule) return resolve();
        const script = document.createElement('script');
        script.src = `${BASE}fmodstudio.js`;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('fmodstudio.js failed to load'));
        document.head.append(script);
      });
      const [wasm, ...banks] = await Promise.all(
        ['fmodstudio.wasm', ...BANKS].map(async (name) => {
          const response = await fetch(BASE + encodeURIComponent(name));
          if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
          return new Uint8Array(await response.arrayBuffer());
        }),
      );
      this.F = await window.FMODModule!({
        wasmBinary: wasm,
        // Same fixed 128 MiB heap as the Godot bridge (runtime.js).
        INITIAL_MEMORY: 128 * 1024 * 1024,
        wasmMemory: new WebAssembly.Memory({ initial: 2048, maximum: 2048 }),
        locateFile: (name: string) => BASE + name,
        print: () => {},
        printErr: (text: string) => console.warn('FMOD', text),
      });
      const F = this.F;
      this.studio = this.get(F, 'Studio_System_Create');
      this.core = this.get(this.studio, 'getCoreSystem');
      this.check(this.core.setDSPBufferSize(2048, 2), 'setDSPBufferSize');
      this.check(
        this.studio.initialize(128, F.STUDIO_INIT_NORMAL, F.INIT_NORMAL, null),
        'initialize',
      );
      const loaded: Fmod[] = [];
      BANKS.forEach((name, i) => {
        try {
          F.FS_unlink('/' + name);
        } catch {
          // not present yet
        }
        F.FS_createDataFile('/', name, banks[i], true, false);
        loaded.push(this.get(this.studio, 'loadBankFile', '/' + name, F.STUDIO_LOAD_BANK_NORMAL));
      });
      this.bus = this.get(this.studio, 'getBus', 'bus:/');
      // Same mixer snapshots the Godot bridge starts; absent ones are skipped.
      for (const [name, param] of [
        ['SFXVolume', 'sfxBusVolume'],
        ['MusicVolume', 'musicBusVolume'],
      ])
        try {
          const snapshot = this.instance(`snapshot:/${name}`, { [param]: 1 });
          this.check(snapshot.start(), 'snapshot');
        } catch {
          // optional
        }
      try {
        this.studio.setParameterByName('timeScale', 1, false);
      } catch {
        // optional global parameter
      }
      this.bankEvents = this.enumerate(loaded[1]);
      this.timer = window.setInterval(() => {
        try {
          this.studio?.update();
        } catch (error) {
          console.warn(error);
        }
      }, 20);
      this.phase = 'ready';
      this.message = `FMOD 就绪，bank 中 ${this.bankEvents.length || '?'} 个事件`;
    } catch (error) {
      this.phase = 'error';
      this.message = String(error);
      console.error(error);
    }
  }

  /** Best effort: list every event path in the bank (needs the strings bank). */
  private enumerate(bank: Fmod): string[] {
    try {
      const count = this.get(bank, 'getEventCount');
      const list: Fmod = {};
      this.check(bank.getEventList(list, count, {}), 'getEventList');
      return (list.val as Fmod[])
        .map((description) => {
          const out: Fmod = {};
          description.getPath(out, 512, {});
          return String(out.val ?? '');
        })
        .filter((path) => path.startsWith('event:/'))
        .sort();
    } catch (error) {
      console.warn('FMOD event enumeration failed', error);
      return [];
    }
  }

  private description(path: string): Fmod {
    return this.get(this.studio, 'getEvent', path);
  }
  private instance(path: string, parameters: Record<string, number> = {}): Fmod {
    const value = this.get(this.description(path), 'createInstance');
    for (const [name, v] of Object.entries(parameters))
      this.check(value.setParameterByName(name, v, false), `parameter ${name}`);
    return value;
  }

  has(path: string): boolean {
    if (this.phase !== 'ready') return false;
    const out: Fmod = {};
    return this.studio.getEvent(path, out) === this.F.OK;
  }

  info(path: string): FmodEventInfo | null {
    if (!this.has(path)) return null;
    const description = this.description(path);
    const parameters: FmodParameter[] = [];
    let oneShot = true,
      lengthMs = 0;
    try {
      oneShot = !!this.get(description, 'isOneshot');
    } catch {
      // older runtime
    }
    try {
      lengthMs = Number(this.get(description, 'getLength')) || 0;
    } catch {
      // unknown
    }
    try {
      const count = this.get(description, 'getParameterDescriptionCount');
      for (let i = 0; i < count; i++) {
        const p = this.get(description, 'getParameterDescriptionByIndex', i);
        if ((p.flags ?? 0) & (READONLY | AUTOMATIC | GLOBAL)) continue;
        parameters.push({ name: p.name, min: p.minimum, max: p.maximum, value: p.defaultvalue });
      }
    } catch {
      // parameters unavailable
    }
    return { oneShot, lengthMs, parameters };
  }

  /** Must run inside a user gesture the first time (browser autoplay policy). */
  private unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      this.core.mixerSuspend();
      this.core.mixerResume();
    } catch {
      // older runtime
    }
  }

  play(path: string, parameters: Record<string, number> = {}): { stop: () => void } {
    if (this.phase !== 'ready') throw new Error('FMOD not ready');
    this.unlock();
    const value = this.instance(path, parameters);
    this.check(value.start(), 'start');
    this.playing.add(value);
    const stop = (): void => {
      if (!this.playing.delete(value)) return;
      try {
        value.stop(this.F.STUDIO_STOP_ALLOWFADEOUT);
        value.release();
      } catch {
        // already released
      }
    };
    return { stop };
  }

  stopAll(): void {
    for (const value of [...this.playing])
      try {
        value.stop(this.F.STUDIO_STOP_ALLOWFADEOUT);
        value.release();
      } catch {
        // already released
      }
    this.playing.clear();
  }

  setVolume(volume: number): void {
    try {
      this.bus?.setVolume(volume);
    } catch {
      // not ready
    }
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.stopAll();
    try {
      this.studio?.release();
    } catch {
      // ignore
    }
    this.studio = null;
    this.phase = 'idle';
  }
}
