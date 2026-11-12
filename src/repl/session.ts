/**
 * Persistent JavaScript session.
 *
 * Same idea as the reference tool: the agent writes code once and keeps the
 * variables, functions and classes it defined. Three things make that work here:
 *
 *   - a `vm` context that survives between calls;
 *   - declarations are re-attached to the context after each run, since they are
 *     otherwise scoped to the wrapper function;
 *   - top-level `await` works because the wrapper is async.
 *
 * The session runs in the host process, so a timeout stops waiting but cannot
 * kill already-running code. Callers should assume side effects may continue.
 */

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

export interface ReplOptions {
  timeoutMs?: number;
  maxChars?: number;
}

export interface ReplResult {
  ok: boolean;
  value?: unknown;
  /** Console output produced while running. */
  writes: string[];
  elapsedMs: number;
  error?: { message: string; name?: string; stack?: string };
  /** Variable names carried over from this run. */
  defined?: string[];
}

interface Declarations {
  [name: string]: unknown;
}

// Declarations may share a line (`const a = 1; const b = 2;`), so the anchor is
// the start of a line or a statement separator, not only a line start.
const DECLARATION_PATTERNS: Array<RegExp> = [
  /(?:^|[;\n])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /(?:^|[;\n])\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /(?:^|[;\n])\s*class\s+([A-Za-z_$][\w$]*)/g,
];

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'if', 'for', 'while', 'do', 'switch',
  'try', 'return', 'throw', 'import', 'export', 'else', 'catch', 'finally', 'case',
  'default', 'break', 'continue', '{', '}',
]);

/** Names declared at the top level of the snippet, used to re-export them. */
export function declaredNames(code: string): string[] {
  const names = new Set<string>();
  for (const pattern of DECLARATION_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code))) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

/**
 * Splits the trailing expression off a snippet, the way a REPL should.
 *
 * Heuristic-free part: the candidate tail is compiled as `(tail)`; if that
 * compiles, it really is an expression. The split point is the last top-level
 * semicolon, scanned outside quotes so `"a;b"` does not fool it.
 */
function splitTrailingExpression(code: string): { body: string; expression?: string } {
  // A trailing semicolon is optional in a REPL, so probe without it.
  const working = code.replace(/\s+$/, '').replace(/;\s*$/, '');
  if (!working.trim()) return { body: code };

  const cut = lastTopLevelSemicolon(working);
  const candidate = (cut >= 0 ? working.slice(cut + 1) : working).trim();
  if (!candidate) return { body: code };

  const body = cut >= 0 ? working.slice(0, cut + 1) : '';
  if (looksLikeDeclaration(candidate)) return { body: code };
  if (!compilesAsExpression(candidate)) return { body: code };
  return { body, expression: candidate };
}

function looksLikeDeclaration(candidate: string): boolean {
  const firstWord = candidate.split(/\s/)[0]?.replace(/[([{].*$/, '') ?? '';
  if (firstWord === 'async') return /^async\s+function\b/.test(candidate);
  return KEYWORDS.has(firstWord);
}

function compilesAsExpression(candidate: string): boolean {
  try {
    // Wrapped in an async function so `await` is legal here too; it is only compiled.
    new vm.Script(`(async () => (${candidate}))`, { filename: 'browsermcp-repl-probe.js' });
    return true;
  } catch {
    return false;
  }
}

/** Index of the last `;` outside strings, template literals and brackets. */
function lastTopLevelSemicolon(code: string): number {
  let depth = 0;
  let quote: string | null = null;
  let last = -1;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    const prev = i > 0 ? code[i - 1] : '';
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) last = i;
  }
  return last;
}

export class JsSession {
  private context: vm.Context;
  private readonly globals: Record<string, unknown>;
  private boundNames = new Set<string>();
  private readonly statePath?: string;
  private restoredCount = 0;

  constructor(globals: Record<string, unknown>, options: { statePath?: string } = {}) {
    this.globals = globals;
    this.statePath = options.statePath;
    this.context = this.newContext();
    if (this.statePath) this.restore();
  }

  get restored(): number {
    return this.restoredCount;
  }

  /**
   * Restores JSON-safe bindings saved by a previous session.
   *
   * Only values that survive JSON are kept: a browser handle or a closure cannot
   * be carried across processes, and pretending otherwise would fail later.
   */
  private restore(): void {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as { bindings?: Record<string, unknown> };
      for (const [name, value] of Object.entries(parsed.bindings ?? {})) {
        if (/^__/.test(name)) continue;
        this.context[name] = value;
        this.boundNames.add(name);
        this.restoredCount++;
      }
    } catch {
      // A corrupt snapshot must not stop the session from starting.
    }
  }

  private persist(): void {
    if (!this.statePath) return;
    const bindings: Record<string, unknown> = {};
    for (const name of this.boundNames) {
      if (/^__/.test(name)) continue;
      const value = this.context[name];
      if (typeof value === 'function' || value === undefined) continue;
      try {
        const json = JSON.stringify(value);
        if (json !== undefined && json.length <= 200_000) bindings[name] = JSON.parse(json);
      } catch {
        // Circular or exotic values are simply not persisted.
      }
    }
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify({ savedAt: new Date().toISOString(), bindings }, null, 2), 'utf8');
    } catch {
      // Persistence is best-effort; never fail the run because of it.
    }
  }

  private newContext(): vm.Context {
    // Host objects must be injected into the sandbox object: a vm context has no
    // timers or web globals of its own, so referencing them from inside the
    // bootstrap script would throw.
    const sandbox: Record<string, unknown> = {
      ...this.globals,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      queueMicrotask,
      structuredClone,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      AbortController,
      AbortSignal,
      fetch,
    };
    const context = vm.createContext(sandbox, { name: 'browsermcp-repl' });
    vm.runInContext('globalThis.global = globalThis;', context, { filename: 'browsermcp-repl-bootstrap.js' });
    return context;
  }

  async run(code: string, options: ReplOptions = {}): Promise<ReplResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxChars = options.maxChars ?? 20_000;
    const writes: string[] = [];
    const started = Date.now();

    const { body, expression } = splitTrailingExpression(code);
    const names = declaredNames(body);

    const consoleShim = {
      log: (...args: unknown[]) => writes.push(formatArgs(args)),
      info: (...args: unknown[]) => writes.push(formatArgs(args)),
      warn: (...args: unknown[]) => writes.push(formatArgs(args)),
      error: (...args: unknown[]) => writes.push(formatArgs(args)),
    };

    // Declarations live inside the wrapper, so they are handed back explicitly and
    // re-attached to the context below. No `with` block: it would shadow the
    // injected console and make output capture silently fail.
    const wrapped = `(async () => {
      const console = globalThis.__console;
      ${body}
      const __expr = ${expression !== undefined ? `(${expression})` : 'undefined'};
      const __decls = { ${names.map((name) => `${JSON.stringify(name)}: typeof ${name} === 'undefined' ? undefined : ${name}`).join(', ')} };
      for (const __key of Object.keys(__decls)) {
        if (__decls[__key] !== undefined) globalThis[__key] = __decls[__key];
      }
      return { __expr, __decls };
    })()`;

    this.context.__console = consoleShim;

    let value: unknown;
    try {
      const script = new vm.Script(wrapped, { filename: 'browsermcp-repl.js' });
      const pending = script.runInContext(this.context, { timeout: timeoutMs }) as Promise<{
        __expr: unknown;
        __decls: Declarations;
      }>;
      // The timeout timer must be cleared when the run finishes first, otherwise a
      // pending timer keeps the host process alive after the work is done.
      let timer: NodeJS.Timeout | undefined;
      const settled = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`execution timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      for (const [name, result] of Object.entries(settled.__decls ?? {})) {
        if (result !== undefined || !this.boundNames.has(name)) {
          this.context[name] = result;
          this.boundNames.add(name);
        }
      }
      // An un-awaited Promise prints as {} and looks like success — the worst kind of
      // failure. Await it here so the trailing expression always reports its value.
      value = settled.__expr;
      if (value && typeof (value as { then?: unknown }).then === 'function') {
        const pendingExpr = value as Promise<unknown>;
        let timer2: NodeJS.Timeout | undefined;
        value = await Promise.race([
          pendingExpr,
          new Promise<never>((_resolve, reject) => {
            timer2 = setTimeout(() => reject(new Error(`promise did not settle within ${timeoutMs}ms`)), timeoutMs);
          }),
        ]).finally(() => {
          if (timer2) clearTimeout(timer2);
        });
      }
      this.persist();
      return {
        ok: true,
        ...(value !== undefined ? { value: truncate(value, maxChars) } : {}),
        writes: writes.map((line) => truncate(line, maxChars) as string),
        elapsedMs: Date.now() - started,
        defined: names,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        ok: false,
        writes,
        elapsedMs: Date.now() - started,
        error: { message: error.message, ...(error.name ? { name: error.name } : {}), ...(error.stack ? { stack: error.stack.split('\n').slice(0, 4).join('\n') } : {}) },
        ...(names.length ? { defined: names } : {}),
      };
    } finally {
      // nothing to unwind: the console shim is replaced on the next run
    }
  }

  /** Drops every binding the session carried; globals are re-seeded. */
  reset(): void {
    this.context = this.newContext();
    this.boundNames.clear();
  }

  get bindingCount(): number {
    return this.boundNames.size;
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');
}

function truncate(value: unknown, maxChars: number): unknown {
  if (typeof value === 'string' && value.length > maxChars) {
    return `${value.slice(0, maxChars)}…(truncated ${value.length - maxChars} chars)`;
  }
  if (value && typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (json && json.length > maxChars) return `${json.slice(0, maxChars)}…(truncated ${json.length - maxChars} chars)`;
    } catch {
      return String(value);
    }
  }
  return value;
}

