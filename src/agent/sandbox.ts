import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import RELEASE from '@jitl/quickjs-singlefile-browser-release-sync';
import { LIMITS, normalizeAction, type AgentAction, type AgentObservation } from './contract';

/*
 * Strategy sandbox with the MUNDI platform's limits: QuickJS (WASM) with an
 * 8 MB heap, a 30 ms wall-clock budget per call, at most 24 KB of code and
 * 8 KB of returned JSON, no Date and a seeded Math.random. Strategy code never
 * runs in the host realm and receives only the JSON observation.
 */
export interface Strategy {
  decide(observation: AgentObservation): AgentAction;
  dispose(): void;
}

let modulePromise: Promise<QuickJSWASMModule> | undefined;
const quickjs = (): Promise<QuickJSWASMModule> =>
  (modulePromise ??= newQuickJSWASMModuleFromVariant(RELEASE));

export const codeBytes = (code: string): number => new TextEncoder().encode(code).length;

export function validCodeSize(code: unknown): code is string {
  if (typeof code !== 'string') return false;
  const size = codeBytes(code);
  return size > 0 && size <= LIMITS.codeBytes;
}

export async function createStrategy(code: string, seed = 1): Promise<Strategy> {
  if (!validCodeSize(code))
    throw new Error(`Strategy is empty or larger than ${LIMITS.codeBytes} bytes`);
  const module = await quickjs();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(LIMITS.memoryBytes);
  runtime.setMaxStackSize(256 * 1024);
  let deadline = Date.now() + 100;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();
  let disposed = false;
  const run = (source: string, budget: number = LIMITS.turnMs): unknown => {
    deadline = Date.now() + budget;
    const result = vm.evalCode(source);
    if (result.error) {
      let error: { message?: string } | undefined;
      try {
        error = vm.dump(result.error);
      } finally {
        result.error.dispose();
      }
      throw new Error(
        error?.message === 'interrupted'
          ? 'Strategy exceeded its time budget'
          : error?.message || 'Strategy failed',
      );
    }
    try {
      return vm.dump(result.value);
    } finally {
      result.value.dispose();
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    vm.dispose();
    runtime.dispose();
  };
  try {
    // Only this fixed bootstrap gets the cold-start budget; user code gets a normal turn.
    run(
      `globalThis.Date=undefined;globalThis.__seed=${seed >>> 0};Math.random=()=>{__seed=(Math.imul(__seed,1664525)+1013904223)>>>0;return __seed/4294967296};`,
      100,
    );
    run(
      `${code}\nif(typeof decide!=="function")throw new Error("Define function decide(observation, memory)");`,
    );
  } catch (error) {
    dispose();
    throw error;
  }
  let memory: Record<string, unknown> = {};
  return {
    decide(observation) {
      if (disposed) throw new Error('Strategy sandbox is closed');
      const json = run(
        `JSON.stringify(decide(${JSON.stringify(observation)},${JSON.stringify(memory)}))`,
      );
      if (typeof json !== 'string' || json.length > LIMITS.memoryJsonBytes)
        throw new Error(
          `Strategy result is invalid or larger than ${LIMITS.memoryJsonBytes} bytes`,
        );
      let value: { action?: unknown; memory?: unknown };
      try {
        value = JSON.parse(json);
      } catch {
        throw new Error('Strategy result must be JSON');
      }
      const action = normalizeAction(value?.action);
      const next = value.memory ?? {};
      if (!next || typeof next !== 'object' || Array.isArray(next))
        throw new Error('memory must be a JSON object');
      memory = next as Record<string, unknown>;
      return action;
    },
    dispose,
  };
}
