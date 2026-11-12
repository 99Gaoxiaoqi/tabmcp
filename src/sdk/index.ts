/**
 * Adapter SDK: the contract a site adapter is written against.
 *
 * An adapter is data plus one function. The data becomes the MCP tool schema, so
 * an agent sees typed arguments instead of guessing; the function gets a tab
 * already bound to the site and returns plain JSON.
 *
 * Written adapters may import `defineAdapter` or simply export a plain object —
 * the loader accepts both, because adapters are meant to be dropped into a
 * directory without a build step.
 */

import type { RuntimePage } from '../transport/page.js';

export type Access = 'read' | 'write';

export type ArgType = 'string' | 'int' | 'number' | 'boolean' | 'array' | 'object';

export interface ArgSpec {
  /** snake_case, agent-facing */
  name: string;
  type?: ArgType;
  required?: boolean;
  help?: string;
  choices?: Array<string | number | boolean>;
  default?: unknown;
  /** One representative value shown to the agent; not a default. */
  example?: unknown;
  items?: ArgSpec;
}

export interface AdapterContext {
  tab: RuntimePage;
  args: Record<string, unknown>;
  log: (message: string) => void;
}

export interface AdapterResult {
  [key: string]: unknown;
}

export interface AdapterExpectation {
  selector?: string;
  text?: string;
  url?: string;
  /** Minimum array length of `result_path` in the adapter's return value. */
  minRows?: number;
  result_path?: string;
}

export interface AdapterDefinition {
  /** One line, agent-facing. */
  description: string;
  access: Access;
  /** Host the adapter works on, e.g. "x.com". Used for search and routing. */
  domain?: string;
  args?: ArgSpec[];
  run(context: AdapterContext): Promise<AdapterResult>;
  /** Used by drafts: what must be true for the adapter to count as working. */
  expect?: AdapterExpectation;
}

export function defineAdapter(definition: AdapterDefinition): AdapterDefinition {
  return definition;
}

export class AdapterError extends Error {
  readonly kind: 'argument' | 'auth' | 'not_found' | 'failed';
  readonly hint?: string;
  constructor(kind: AdapterError['kind'], message: string, hint?: string) {
    super(message);
    this.name = 'AdapterError';
    this.kind = kind;
    if (hint !== undefined) this.hint = hint;
  }
}

export const errors = {
  argument: (message: string) => new AdapterError('argument', message),
  auth: (message: string, hint?: string) => new AdapterError('auth', message, hint),
  notFound: (message: string) => new AdapterError('not_found', message),
  failed: (message: string, hint?: string) => new AdapterError('failed', message, hint),
};

/** Validates a loaded module looks like an adapter; returns problems instead of throwing. */
export function validateDefinition(value: unknown): { ok: true; definition: AdapterDefinition } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const candidate = value as Partial<AdapterDefinition> | null;
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, problems: ['default export is not an object'] };
  }
  if (typeof candidate.description !== 'string' || !candidate.description.trim()) {
    problems.push('description must be a non-empty string');
  }
  if (candidate.access !== 'read' && candidate.access !== 'write') {
    problems.push('access must be "read" or "write"');
  }
  if (typeof candidate.run !== 'function') {
    problems.push('run must be a function');
  }
  if (candidate.args !== undefined) {
    if (!Array.isArray(candidate.args)) {
      problems.push('args must be an array');
    } else {
      for (const [index, arg] of candidate.args.entries()) {
        if (!arg || typeof arg !== 'object') {
          problems.push(`args[${index}] is not an object`);
          continue;
        }
        if (typeof arg.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(arg.name)) {
          problems.push(`args[${index}].name must be snake_case`);
        }
        if (arg.type && !['string', 'int', 'number', 'boolean', 'array', 'object'].includes(arg.type)) {
          problems.push(`args[${index}].type is not a known type`);
        }
        if (arg.choices && !Array.isArray(arg.choices)) {
          problems.push(`args[${index}].choices must be an array`);
        }
      }
    }
  }
  if (candidate.expect !== undefined && (typeof candidate.expect !== 'object' || candidate.expect === null)) {
    problems.push('expect must be an object');
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, definition: candidate as AdapterDefinition };
}

/** Coerces and checks arguments against the spec; returns the values to pass to run(). */
export function coerceArgs(
  spec: ArgSpec[] | undefined,
  input: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; problem: string } {
  const value: Record<string, unknown> = {};
  const known = new Set((spec ?? []).map((arg) => arg.name));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) return { ok: false, problem: `unknown argument "${key}"` };
  }
  for (const arg of spec ?? []) {
    let raw = input[arg.name];
    if (raw === undefined || raw === null) {
      if (arg.default !== undefined) {
        value[arg.name] = arg.default;
        continue;
      }
      if (arg.required) return { ok: false, problem: `"${arg.name}" is required` };
      continue;
    }
    switch (arg.type) {
      case 'int':
      case 'number': {
        const num = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(num)) return { ok: false, problem: `"${arg.name}" must be a number` };
        if (arg.type === 'int' && !Number.isInteger(num)) return { ok: false, problem: `"${arg.name}" must be an integer` };
        raw = num;
        break;
      }
      case 'boolean': {
        if (typeof raw !== 'boolean') {
          if (raw === 'true') raw = true;
          else if (raw === 'false') raw = false;
          else return { ok: false, problem: `"${arg.name}" must be a boolean` };
        }
        break;
      }
      case 'array':
        if (!Array.isArray(raw)) return { ok: false, problem: `"${arg.name}" must be an array` };
        break;
      case 'object':
        if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problem: `"${arg.name}" must be an object` };
        break;
      case 'string':
      default:
        if (typeof raw !== 'string') return { ok: false, problem: `"${arg.name}" must be a string` };
        break;
    }
    if (arg.choices && !arg.choices.includes(raw as string | number | boolean)) {
      return { ok: false, problem: `"${arg.name}" must be one of: ${arg.choices.join(', ')}` };
    }
    value[arg.name] = raw;
  }
  return { ok: true, value };
}
