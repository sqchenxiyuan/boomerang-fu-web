import type { ReplayData } from '../sdk/recording';
import type { MapId, MatchOptions } from '../core/types';
import { decodeReplay, encodeReplay } from './replay-file';

export interface ReplayEntry {
  id: string;
  createdAt: string;
  label: string;
  mapId: MapId;
  mode: MatchOptions['mode'];
  players: number;
  ticks: number;
  complete: boolean;
  bytes: number;
  persistent: boolean;
}

export function replayEntry(data: ReplayData): ReplayEntry {
  const state = data.checkpoints[0].world.state;
  return {
    id: `${data.createdAt}/${data.durationTicks}/${data.finalHash}`,
    createdAt: data.createdAt,
    label: data.label,
    mapId: state.arena.id ?? 'courtyard',
    mode: state.options.mode,
    players: state.actors.length,
    ticks: data.durationTicks,
    complete: data.stopReason === 'match-end',
    bytes: 0,
    persistent: false,
  };
}

const request = <T>(value: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });

/** Keep only metadata in list queries; large compressed recordings are read on demand.
 * Capacity failures preserve existing history and retain the new recording in this tab. */
export class ReplayHistory {
  warning = '';
  private opening: Promise<IDBDatabase> | null = null;
  private temporary = new Map<string, { entry: ReplayEntry; blob: Blob }>();
  private open(): Promise<IDBDatabase> {
    return (this.opening ??= new Promise((resolve, reject) => {
      const opening = indexedDB.open('boomerang-garden-replays', 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore('entries', { keyPath: 'id' });
        opening.result.createObjectStore('files');
      };
      opening.onsuccess = () => {
        const database = opening.result;
        database.onversionchange = () => {
          database.close();
          this.opening = null;
        };
        resolve(database);
      };
      opening.onerror = () => reject(opening.error);
      opening.onblocked = () => reject(new Error('录像存储被其他页面占用'));
    }));
  }
  async list(): Promise<ReplayEntry[]> {
    const entries = new Map<string, ReplayEntry>();
    try {
      const db = await this.open();
      for (const entry of await request<ReplayEntry[]>(
        db.transaction('entries').objectStore('entries').getAll(),
      ))
        entries.set(entry.id, entry);
    } catch {
      this.warning = '浏览器本地存储不可用，录像暂存于本页，请及时下载。';
    }
    for (const { entry } of this.temporary.values()) entries.set(entry.id, entry);
    return [...entries.values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.ticks - a.ticks,
    );
  }
  async save(data: ReplayData): Promise<ReplayEntry> {
    const blob = await encodeReplay(data);
    const entry = { ...replayEntry(data), bytes: blob.size, persistent: true };
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['entries', 'files'], 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('历史录像已达容量上限'));
        tx.onerror = () => {
          /* onabort reports the transaction failure. */
        };
        const meta = tx.objectStore('entries');
        const all = meta.getAll();
        all.onsuccess = () => {
          const others = (all.result as ReplayEntry[]).filter((item) => item.id !== entry.id);
          if (
            others.length >= 100 ||
            others.reduce((bytes, item) => bytes + item.bytes, blob.size) > 200 * 1024 * 1024
          ) {
            tx.abort();
            return;
          }
          meta.put(entry);
          tx.objectStore('files').put(blob, entry.id);
        };
      });
      this.temporary.delete(entry.id);
      this.warning = '';
    } catch {
      entry.persistent = false;
      this.temporary.set(entry.id, { entry, blob });
      this.warning = '本地保存失败或空间不足。这局暂存于本页，可先下载或删除不需要的历史录像。';
    }
    return entry;
  }
  async read(id: string): Promise<ReplayData> {
    let blob = this.temporary.get(id)?.blob;
    if (!blob) {
      const db = await this.open();
      blob = await request<Blob | undefined>(db.transaction('files').objectStore('files').get(id));
    }
    if (!blob) throw new Error('录像已被删除，请选择其他对局');
    return decodeReplay(blob);
  }
  async remove(id: string): Promise<void> {
    if (!this.temporary.has(id)) {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['entries', 'files'], 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('删除失败'));
        tx.objectStore('entries').delete(id);
        tx.objectStore('files').delete(id);
      });
    }
    this.temporary.delete(id);
  }
}
