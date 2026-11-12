/**
 * Adapter execution.
 *
 * Validates arguments against the adapter's spec, binds the tab, runs the
 * adapter, and normalises failures into codes an agent can branch on.
 */

import { ActionError } from '../core/errors.js';
import { AdapterError, coerceArgs, type AdapterDefinition } from '../sdk/index.js';
import type { RuntimePage } from '../transport/page.js';
import type { LoadedAdapter } from './loader.js';

export interface RunAdapterOptions {
  adapter: LoadedAdapter | AdapterDefinition;
  tab: RuntimePage;
  args: Record<string, unknown>;
  log?: (message: string) => void;
  timeoutMs?: number;
}

export interface RunAdapterResult {
  ok: true;
  tool: string;
  access: 'read' | 'write';
  result: Record<string, unknown>;
  elapsedMs: number;
}

export async function runAdapter(options: RunAdapterOptions): Promise<RunAdapterResult> {
  const definition = 'definition' in options.adapter ? options.adapter.definition : options.adapter;
  const toolName = 'toolName' in options.adapter ? options.adapter.toolName : definition.description;

  const coerced = coerceArgs(definition.args, options.args ?? {});
  if (!coerced.ok) {
    throw new ActionError('E_BAD_ARGUMENT', `${toolName}: ${coerced.problem}`, {
      hint: 'Check the adapter argument spec returned by sites_search.',
    });
  }

  const started = Date.now();
  try {
    const result = await withTimeout(
      definition.run({
        tab: options.tab,
        args: coerced.value,
        log: options.log ?? (() => undefined),
      }),
      options.timeoutMs ?? 60_000,
      toolName,
    );
    return {
      ok: true,
      tool: toolName,
      access: definition.access,
      result: result ?? {},
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof AdapterError) {
      const code =
        err.kind === 'argument'
          ? 'E_BAD_ARGUMENT'
          : err.kind === 'auth'
            ? 'E_AUTH'
            : err.kind === 'not_found'
              ? 'E_TARGET_NOT_FOUND'
              : 'E_ACTION_FAILED';
      throw new ActionError(code as never, `${toolName}: ${err.message}`, {
        ...(err.hint !== undefined ? { hint: err.hint } : {}),
        cause: err,
      });
    }
    if (err instanceof ActionError) throw err;
    throw new ActionError('E_ACTION_FAILED', `${toolName}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Checks a draft's expectation against a run result. */
export function checkExpectation(
  expectation: AdapterDefinition['expect'],
  result: Record<string, unknown>,
): { ok: boolean; detail?: string } {
  if (!expectation) return { ok: true };
  if (expectation.minRows !== undefined) {
    const value = expectation.result_path
      ? expectation.result_path.split('.').reduce<unknown>((acc, key) => {
          if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
          return undefined;
        }, result)
      : firstArray(result);
    if (!Array.isArray(value)) return { ok: false, detail: `expected an array at ${expectation.result_path ?? 'result'}` };
    if (value.length < expectation.minRows) {
      return { ok: false, detail: `expected at least ${expectation.minRows} rows, got ${value.length}` };
    }
  }
  if (expectation.text !== undefined) {
    const haystack = JSON.stringify(result);
    if (!haystack.includes(expectation.text)) return { ok: false, detail: `result does not contain ${JSON.stringify(expectation.text)}` };
  }
  return { ok: true };
}

/** Without an explicit path, minRows means the first array in the result. */
function firstArray(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const candidate of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return undefined;
}
