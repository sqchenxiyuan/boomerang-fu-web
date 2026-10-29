import type { DeathCause, GameEvent, MapId, PowerupKind } from '../core/types';
import { integer } from './control';
import { MAX_REPLAY_TICKS, ReplayPlayer } from './recording';
import type { ReplayData } from './recording';

export type ReplayMarkerKind = 'round' | 'death' | 'pickup' | 'deflect' | 'win';
export interface ReplayMarker {
  id: string;
  tick: number;
  kind: ReplayMarkerKind;
  round: number;
  mapId: MapId;
  actorId: number;
  sourceId?: number;
  cause?: DeathCause;
  power?: PowerupKind;
}
export interface ReplayTimelineSnapshot {
  status: 'indexing' | 'ready' | 'error';
  progress: number;
  markers: readonly Readonly<ReplayMarker>[];
  error: string | null;
  omitted: number;
}

/** Incremental deterministic event index for existing replay files, including version 1.
 * Hosts choose the work budget and can cancel simply by dropping the instance. */
export class ReplayTimeline {
  private player: ReplayPlayer;
  private markers: Readonly<ReplayMarker>[] = [];
  private round: number;
  private mapId: MapId;
  private error: string | null = null;
  private omitted = 0;
  private cache: ReplayTimelineSnapshot | null = null;
  constructor(data: ReplayData | string) {
    this.player = new ReplayPlayer(data);
    const state = this.player.getState();
    this.round = state.round;
    this.mapId = state.arena.id ?? 'courtyard';
    this.add({ type: 'round', actorId: -1, position: { x: 0, y: 0 } });
  }
  private add(event: GameEvent): void {
    if (!['round', 'death', 'pickup', 'deflect', 'win'].includes(event.type)) return;
    // Preserve round navigation even for unusually event-dense imported recordings.
    if (this.markers.length >= 10000 && event.type !== 'round' && event.type !== 'win') {
      this.omitted++;
      return;
    }
    this.markers.push(
      Object.freeze({
        id: `${this.player.tick}:${this.markers.length}`,
        tick: this.player.tick,
        kind: event.type as ReplayMarkerKind,
        round: this.round,
        mapId: this.mapId,
        actorId: event.actorId,
        sourceId: event.type === 'death' ? event.value : undefined,
        cause: event.cause,
        power: event.power,
      }),
    );
  }
  advance(ticks = 120): void {
    integer(ticks, 1, MAX_REPLAY_TICKS, 'ticks');
    if (this.error || this.player.status === 'ended') return;
    this.cache = null;
    try {
      for (let i = 0; i < ticks && this.player.tick < this.player.durationTicks; i++) {
        this.player.step();
        const events = this.player.drainEvents();
        let newRound = false;
        if (events.some((event) => event.type === 'round')) {
          const state = this.player.getState();
          newRound = this.round !== state.round || this.mapId !== (state.arena.id ?? 'courtyard');
          this.round = state.round;
          this.mapId = state.arena.id ?? 'courtyard';
        }
        // A checkpoint can still contain the initial round event; tick 0 already represents it.
        for (const event of events) if (event.type !== 'round' || newRound) this.add(event);
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  snapshot(): ReplayTimelineSnapshot {
    return (this.cache ??= Object.freeze({
      status: this.error ? 'error' : this.player.status === 'ended' ? 'ready' : 'indexing',
      progress: this.player.durationTicks ? this.player.tick / this.player.durationTicks : 1,
      markers: Object.freeze([...this.markers]),
      error: this.error,
      omitted: this.omitted,
    }));
  }
}
