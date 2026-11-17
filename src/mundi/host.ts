import { AGENT_PROTOCOL, CHARACTERS, TICK_HZ } from '../agent/contract';
import type { AgentFrame, AgentObservation } from '../agent/contract';
import { PRESENT_MAX_FRAMES, type AgentRuntime } from '../agent/runtime';
import type { FramePacer } from './pacer';

/*
 * Game side of the MUNDI `arkena.game.v1` bridge for the web engine. The
 * platform connects with a MessagePort; this host validates each command the
 * way the platform's Godot host does, runs the shared AgentRuntime (the same
 * simulation as the headless CLI, so browser and CLI frames agree), and paces
 * live play in real time. DOM-free: rendering, sound and page messages live
 * behind `HostView` (see main.ts), so the protocol is testable under Node.
 */

/** Match modes the platform sends. Every `match-*` variant runs as one `match`. */
export const PLATFORM_MODES = [
  'round',
  'match',
  'match-seven',
  'match-short',
  'match-medium',
  'match-long',
] as const;
export const PACED_SPEEDS = [1, 1.25, 1.5, 2, 4, 8] as const;
const RUNNER_METHODS = new Set(['observations', 'pacedStep']);
const COMMANDS = new Set([
  'reset',
  'observe',
  'step',
  'pacedStep',
  'snapshot',
  'replay',
  'dispose',
]);

export type Playback = 'idle' | 'playing' | 'paused' | 'ended';
export interface AudioStatus {
  phase: string;
  enabled: boolean;
}
export interface HostView {
  /** A fresh match was set up (new map, scores). */
  reset(): void;
  /** The simulation advanced; drain runtime events for presentation. */
  advanced(): void;
  playback(state: Playback): void;
  audio(): AudioStatus;
  /** Display-only appearance for each player (not part of the result). */
  appearance(players: unknown): void;
  /** After the ending: let the last frames reach the screen and linger. */
  settle(): Promise<void>;
  dispose(): void;
}
export interface HostPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  start?(): void;
  close(): void;
}
export interface Manifest {
  protocol: string;
  engineId: string;
  tickHz: number;
  directRunner: boolean;
  preparedReset: boolean;
  pacedStep: boolean;
  observations: boolean;
  stepObservations: boolean;
  presentEnding: boolean;
  appearance: boolean;
}
interface Request {
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
  control?: unknown;
  paused?: unknown;
}

const fail = (message: string): never => {
  throw new Error(message);
};

export class MundiHost {
  readonly manifest: Manifest;
  private port: HostPort | null = null;
  private runnerPort: HostPort | null = null;
  private working = false;
  private idle: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly pacer: FramePacer,
    private readonly view: HostView,
    engineId: string,
  ) {
    this.manifest = {
      protocol: AGENT_PROTOCOL,
      engineId,
      tickHz: TICK_HZ,
      directRunner: true,
      preparedReset: true,
      pacedStep: true,
      observations: true,
      stepObservations: true,
      presentEnding: true,
      appearance: true,
    };
  }

  get connected(): boolean {
    return this.port !== null;
  }

  /** Accept the platform's port once; later connections are ignored. */
  connect(port: HostPort): boolean {
    if (this.port || this.disposed) return false;
    this.port = port;
    port.onmessage = this.receive(port);
    port.start?.();
    port.postMessage({ id: 0, result: this.manifest });
    return true;
  }

  private receive(replyPort: HostPort) {
    return (event: MessageEvent) =>
      void this.handle(replyPort, event.data as Request, event.ports ?? []);
  }

  private async handle(
    replyPort: HostPort,
    data: Request,
    ports: readonly MessagePort[],
  ): Promise<void> {
    if (this.disposed || !data || typeof data !== 'object') return;
    if (data.control === 'pause' && typeof data.paused === 'boolean') {
      this.pacer.pause(data.paused);
      this.view.playback(data.paused ? 'paused' : 'playing');
      return;
    }
    const id = data.id;
    if (!Number.isSafeInteger(id)) return;
    const method = String(data.method);
    const params = (data.params && typeof data.params === 'object' ? data.params : {}) as Record<
      string,
      unknown
    >;
    const reply = (result: unknown) => replyPort.postMessage({ id, result });
    const replyError = (error: unknown) =>
      replyPort.postMessage({
        id,
        error: String(error instanceof Error ? error.message : error).slice(0, 300),
      });
    const main = replyPort === this.port;
    if (!main && !RUNNER_METHODS.has(method))
      return replyError(new Error('Unsupported runner command'));
    if (method === 'connectRunner') {
      if (!main || ports.length !== 1 || this.working)
        return replyError(new Error('Invalid runner connection'));
      this.runnerPort?.close();
      const runner = ports[0] as unknown as HostPort;
      this.runnerPort = runner;
      runner.onmessage = this.receive(runner);
      runner.start?.();
      return reply(true);
    }
    if (method === 'detachRunner') {
      this.runnerPort?.close();
      this.runnerPort = null;
      this.pacer.pause(true);
      if (this.working) await new Promise<void>((resolve) => (this.idle = resolve));
      return reply(true);
    }
    if (method === 'audio') {
      try {
        return reply(this.view.audio());
      } catch (error) {
        return replyError(error);
      }
    }
    if (method === 'appearance') {
      try {
        this.view.appearance(params.players);
        return reply(true);
      } catch (error) {
        return replyError(error);
      }
    }
    if (this.working) return replyError(new Error('Game command already in flight'));
    this.working = true;
    try {
      const result = await this.command(method, params);
      reply(result);
      if (method === 'dispose') this.dispose();
    } catch (error) {
      this.view.playback('paused');
      replyError(error);
    } finally {
      this.working = false;
      this.idle?.();
      this.idle = null;
    }
  }

  private observations(): [AgentObservation, AgentObservation] {
    return [this.runtime.observe(0), this.runtime.observe(1)];
  }

  private async command(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'presentEnding') return this.presentEnding();
    if (method === 'observations') return this.observations();
    if (!COMMANDS.has(method)) fail('Unsupported game command');
    switch (method) {
      case 'reset': {
        const { seed, mode, characters } = params;
        if (!Number.isInteger(seed) || !PLATFORM_MODES.includes(mode as never))
          fail('Invalid game reset');
        if (
          characters !== undefined &&
          (!Array.isArray(characters) ||
            characters.length !== 2 ||
            characters[0] === characters[1] ||
            !characters.every((c) => CHARACTERS.includes(c as never)))
        )
          fail('Invalid characters');
        this.view.playback('idle');
        this.pacer.reset();
        const frame = this.runtime.reset({
          seed: seed as number,
          mode: mode === 'round' ? 'round' : 'match',
          characters: characters as string[] | undefined,
        });
        this.view.reset();
        return frame;
      }
      case 'observe':
        if (params.player !== 0 && params.player !== 1) fail('Invalid player');
        return this.runtime.observe(params.player as number);
      case 'snapshot':
        return this.runtime.snapshot();
      case 'replay': {
        const actions = params.actions;
        if (
          !Array.isArray(actions) ||
          actions.length < 1 ||
          actions.length > 30 ||
          actions.some((pair) => !Array.isArray(pair) || pair.length !== 2)
        )
          fail('Invalid replay batch');
        this.view.playback('paused');
        const frames: AgentFrame[] = [];
        for (const pair of actions as unknown[][]) frames.push(this.runtime.step(pair, 6));
        this.view.advanced();
        if (frames.at(-1)?.done) this.view.playback('ended');
        return frames;
      }
      case 'dispose':
        return true;
    }
    // step / pacedStep
    const { actions, frames } = params;
    if (
      !Array.isArray(actions) ||
      actions.length !== 2 ||
      !Number.isInteger(frames) ||
      (frames as number) < 1 ||
      (frames as number) > 6
    )
      fail('Invalid step');
    const count = frames as number;
    if (method === 'step') {
      this.view.playback('paused');
      const frame = this.runtime.step(actions as unknown[], count);
      this.view.advanced();
      if (frame.done) this.view.playback('ended');
      return frame;
    }
    if (!PACED_SPEEDS.includes(params.speed as never)) fail('Invalid speed');
    if (!this.pacer.paused) this.view.playback('playing');
    let advanced = 0,
      frame: AgentFrame | null = null;
    while (advanced < count) {
      const due = await this.pacer.next(count - advanced, params.speed as number);
      if (!due) break;
      frame = this.runtime.step(actions as unknown[], due);
      advanced += due;
      this.view.advanced();
      if (frame.done) break;
    }
    const result: { advanced: number; frame: AgentFrame | null; observations?: unknown } = {
      advanced,
      frame: frame ?? this.runtime.snapshot(),
    };
    if (
      params.observations === true &&
      advanced === count &&
      !result.frame!.done &&
      !this.pacer.paused
    )
      result.observations = this.observations();
    return result;
  }

  /** The result arrives on the deciding frame; play the ending in real time, no inputs. */
  private async presentEnding(): Promise<{ frames: number }> {
    this.view.playback('playing');
    this.pacer.reset();
    let frames = 0;
    while (frames < PRESENT_MAX_FRAMES) {
      const due = await this.pacer.next(Math.min(6, PRESENT_MAX_FRAMES - frames), 1);
      if (!due) fail('收尾录制已暂停，请重新生成完整视频');
      const step = this.runtime.present(due);
      this.view.advanced();
      frames += due;
      if (!step.presented) break;
    }
    await this.view.settle();
    return { frames };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pacer.pause(true);
    this.runnerPort?.close();
    this.runnerPort = null;
    this.port?.close();
    this.view.dispose();
    this.runtime.dispose();
  }
}
