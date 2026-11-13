/**
 * A session that may not exist yet.
 *
 * The MCP client connects before the user has necessarily started a browser. If the
 * connect happened at startup, a missing Chrome killed the process and the client saw
 * `Connection closed` — no tools, no error, nothing to act on. Here the transport is
 * created on demand: every call tries once, and failing that answers E_NO_BROWSER with
 * a pasteable command instead of dropping the pipe.
 */
import { ActionError } from '../core/errors.js';
import type { BrowserSession } from './cdp.js';
import type { RuntimePage } from './page.js';

export interface DeferredSessionOptions {
  kind: 'cdp' | 'extension';
  /** Opens the transport; may throw when nothing is listening. */
  open: () => Promise<BrowserSession>;
  /** Where the caller should have connected, quoted back in errors and doctor. */
  target: string;
  /** One pasteable command that fixes it, if there is one. */
  hint: string;
  /** Minimum gap between retries, so a caller in a loop cannot hammer the port. */
  retryAfterMs?: number;
}

/** Errors that mean the session itself is gone, not that the request was wrong. */
function looksDead(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === 'E_NO_TAB' || code === 'E_BROWSER_DISCONNECTED') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Target (page, context or browser )?(closed|has been closed)|browser has been closed|Connection closed|WebSocket is closed|socket hang up|No tab with given id/i.test(
    message,
  );
}

export class DeferredSession implements BrowserSession {
  readonly kind: 'cdp' | 'extension';
  private live: BrowserSession | null = null;
  private pending: Promise<BrowserSession> | null = null;
  private lastFailure: { at: number; error: ActionError } | null = null;
  private readonly options: DeferredSessionOptions;
  private readonly listeners: ((event: { method: string; params?: Record<string, unknown> }) => void)[] = [];
  private readonly forwarded = new WeakSet<BrowserSession>();

  constructor(options: DeferredSessionOptions) {
    this.options = options;
    this.kind = options.kind;
  }

  /** The attached session, or null. Synchronous: used by doctor to describe state. */
  current(): BrowserSession | null {
    return this.live;
  }

  /** True when a browser is attached right now. */
  get connected(): boolean {
    return this.live !== null;
  }

  onNetworkEvent(listener: (event: { method: string; params?: Record<string, unknown> }) => void): void {
    this.listeners.push(listener);
    this.forward(this.live);
  }

  /**
   * Attach if needed. Concurrent callers share one attempt; a failed attempt is
   * remembered briefly so `pages()` in a retry loop costs nothing.
   */
  async attach(): Promise<BrowserSession> {
    if (this.live) return this.live;
    const now = Date.now();
    if (this.lastFailure && now - this.lastFailure.at < (this.options.retryAfterMs ?? 500)) {
      throw this.lastFailure.error;
    }
    this.pending ??= this.options.open().then(
      (session) => {
        this.live = session;
        this.lastFailure = null;
        this.pending = null;
        this.forward(session);
        return session;
      },
      (cause: unknown) => {
        this.pending = null;
        const error = this.failure(cause);
        this.lastFailure = { at: Date.now(), error };
        throw error;
      },
    );
    return this.pending;
  }

  /** The E_NO_BROWSER envelope for a failed attach, keeping the underlying reason. */
  private failure(cause: unknown): ActionError {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new ActionError('E_NO_BROWSER', `No browser attached at ${this.options.target}`, {
      hint: this.options.hint,
      data: { target: this.options.target, transport: this.kind, reason },
      cause,
    });
  }

  /**
   * When a session dies later (browser closed), drop it and try once with a fresh one.
   * Reporting "the tab is closed" for a browser that has been restarted would send the
   * caller looking for a closed tab that no longer exists.
   */
  private async retryOnDead<T>(fn: (session: BrowserSession) => Promise<T>): Promise<T> {
    const session = await this.attach();
    try {
      return await fn(session);
    } catch (err) {
      if (!looksDead(err)) throw err;
      this.live = null;
      this.pending = null;
      const replacement = await this.attach();
      return fn(replacement);
    }
  }

  private forward(session: BrowserSession | null): void {
    if (!session || this.forwarded.has(session)) return;
    if (!session.onNetworkEvent) return;
    this.forwarded.add(session);
    for (const listener of this.listeners) session.onNetworkEvent(listener);
  }

  async pages(): Promise<RuntimePage[]> {
    return this.retryOnDead((session) => session.pages());
  }

  async activePage(): Promise<RuntimePage> {
    return this.retryOnDead((session) => session.activePage());
  }

  async newPage(): Promise<RuntimePage> {
    return this.retryOnDead((session) => session.newPage());
  }

  async close(): Promise<void> {
    const session = this.live;
    this.live = null;
    this.pending = null;
    if (session) await session.close().catch(() => undefined);
  }
}
