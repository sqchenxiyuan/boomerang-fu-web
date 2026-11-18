import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { DECISION_TICKS, ENGINE_ID, LOCAL_PROTOCOL } from './contract';
import { AgentRuntime } from './runtime';

/*
 * The `mundi.local.v1` runtime role, as the MUNDI CLI and batch runner use it
 * for the Godot engine: connect back to the runner's loopback port,
 * authenticate with its token, then answer reset / advance / snapshot (each
 * returning `{frame, observations}`) until quit. Used by `serve --connect` and
 * by the standalone runtime file the platform pins (local-runtime-main.ts).
 */
const PLATFORM_MODES = [
  'round',
  'match',
  'match-seven',
  'match-short',
  'match-medium',
  'match-long',
];

export function dispatch(
  runtime: AgentRuntime,
  method: string,
  params: Record<string, unknown> = {},
) {
  const both = () => ({
    frame: runtime.snapshot(),
    observations: [runtime.observe(0), runtime.observe(1)],
  });
  switch (method) {
    case 'reset': {
      // Every match-* variant runs as one match; the platform settles targets
      // and round limits (as with the embed).
      const mode = String(params.mode);
      if (!PLATFORM_MODES.includes(mode)) throw new RangeError('mode must be round or match');
      runtime.reset({
        ...(params as never as object),
        mode: mode === 'round' ? 'round' : 'match',
      } as never);
      return both();
    }
    case 'advance':
      runtime.step(params.actions as unknown[], DECISION_TICKS);
      return both();
    case 'step':
      return runtime.step(params.actions as unknown[], Number(params.frames ?? DECISION_TICKS));
    case 'observe':
      return runtime.observe(Number(params.player));
    case 'snapshot':
      return runtime.snapshot();
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

export async function serveLocal({ port, token }: { port: number; token: string }): Promise<void> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error('MUNDI_LOCAL_PORT is not set');
  const runtime = new AgentRuntime();
  const socket = connect({ host: '127.0.0.1', port });
  socket.setNoDelay(true);
  await new Promise<void>((done, fail) => socket.once('connect', done).once('error', fail));
  socket.write(JSON.stringify({ hello: LOCAL_PROTOCOL, token, engine: ENGINE_ID }) + '\n');
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 1048576) break;
      const request = JSON.parse(line) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (request.method === 'quit') {
        socket.end(JSON.stringify({ id: request.id, result: true }) + '\n');
        break;
      }
      try {
        if (!['reset', 'advance', 'snapshot'].includes(request.method))
          throw new Error('Unknown local runtime method');
        if (request.method !== 'snapshot') dispatch(runtime, request.method, request.params);
        const result = {
          frame: runtime.snapshot(),
          observations: [runtime.observe(0), runtime.observe(1)],
        };
        socket.write(JSON.stringify({ id: request.id, result }) + '\n');
      } catch (error) {
        socket.write(JSON.stringify({ id: request.id, error: (error as Error).message }) + '\n');
      }
    }
  } finally {
    runtime.dispose();
    socket.destroy();
  }
}
