/**
 * A session that may not exist yet.
 *
 * The MCP client connects before the user has necessarily started a browser. If the
 * connect happened at startup, a missing Chrome killed the process and the client saw
 * `Connection closed` — no tools, no error, nothing to act on. Here the transport is
 * created on demand: every call tries once, and failing that answers E_NO_BROWSER with
 * a pasteable command instead of dropping the pipe.
 *
 * Reconnecting is not silent. When a call is served by a *different* page than the one
 * the caller was talking to, the result carries `sessionReplaced` with both tab ids, so
 * "this succeeded somewhere else" cannot be mistaken for "this succeeded where I asked".
 */
import { ActionError } from '../core/errors.js';
import type { BrowserSession, TabDescriptor } from './cdp.js';
import type { RuntimePage } from './page.js';

/** What the caller needs to know about a call that did not run where they thought. */
export interface SessionNotice {
  /** A different page served the call: which one died, which one answered. */
  replaced?: {
    previousTabId: string | null;
    currentTabId: string | null;
    cause: string;
    /** 'observed' = this call returned it; 'lastKnown' = filled from an earlier call. */
    currentTabIdSource?: 'observed' | 'lastKnown';
  };
  /**
   * The transport said something that sounds like a dead session, but nothing in the
   * synonym list matched it. Surfaced so a changed message cannot fail silently.
   */
  unmatchedDeadText?: string;
}

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

/** Words that show up when a transport dies. Kept separate from the match below. */
const DEAD_WORDS = /closed|disconnected|target|websocket|socket|ECONNRESET|EPIPE/i;

/**
 * Messages that mean the page or the connection is gone. Exported because the tool
 * layer needs the same judgement for errors raised deeper down (page.goto on a closed
 * tab never passes through this class).
 */
export function looksDeadMessage(message: string): boolean {
  return /Target (page, context or browser )?(closed|has been closed)|Target closed|browser has been closed|Connection closed|WebSocket is closed|socket hang up|No tab with given id/i.test(
    message,
  );
}

/** Errors that mean the session itself is gone, not that the request was wrong. */
function looksDead(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === 'E_NO_TAB' || code === 'E_BROWSER_DISCONNECTED') return true;
  return looksDeadMessage(messageOf(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DeferredSession implements BrowserSession {
  readonly kind: 'cdp' | 'extension';
  private live: BrowserSession | null = null;
  private pending: Promise<BrowserSession> | null = null;
  private lastFailure: { at: number; error: ActionError } | null = null;
  private readonly options: DeferredSessionOptions;
  private readonly listeners: ((event: { method: string; params?: Record<string, unknown> }) => void)[] = [];
  private readonly forwarded = new WeakSet<BrowserSession>();
  /** Last page the caller actually worked with; the "previous" side of a replacement. */
  private lastPageId: string | null = null;
  private notice: SessionNotice = {};

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

  /**
   * Take what the caller should be told about the last call, once. The server merges
   * this into the result; draining here keeps one call's news from leaking into the next.
   */
  takeNotice(): SessionNotice | null {
    const notice = this.notice;
    this.notice = {};
    // A replacement that answered with a list (e.g. pages()) names no page itself; by
    // now the handler has usually asked for one, so fill the gap from what it saw.
    if (notice.replaced && !notice.replaced.currentTabId) {
      notice.replaced.currentTabId = this.lastPageId;
      // Filled in from an earlier observation: say so instead of presenting it as measured.
      notice.replaced.currentTabIdSource = this.lastPageId ? 'lastKnown' : undefined;
    } else if (notice.replaced) {
      notice.replaced.currentTabIdSource = 'observed';
    }
    return notice.replaced || notice.unmatchedDeadText ? notice : null;
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
    return new ActionError('E_NO_BROWSER', `No browser attached at ${this.options.target}`, {
      hint: this.options.hint,
      data: { target: this.options.target, transport: this.kind, reason: messageOf(cause) },
      cause,
    });
  }

  /**
   * Run against the live session. If the session turns out to be dead, attach again and
   * try once — and record that the answer came from a different page than the caller's.
   */
  /** Transports report their own page-level swaps; fold them into the same notice. */
  private collect(session: BrowserSession): void {
    const source = session as BrowserSession & {
      takePageReplacement?: () => { previousTabId: string | null; currentTabId: string | null; cause: string } | null;
    };
    const replaced = typeof source.takePageReplacement === 'function' ? source.takePageReplacement() : null;
    if (replaced) this.notice.replaced = replaced;
  }

  private async retryOnDead<T>(fn: (session: BrowserSession) => Promise<T>): Promise<T> {
    const session = await this.attach();
    try {
      const value = this.remember(await fn(session));
      this.collect(session);
      return value;
    } catch (err) {
      if (!looksDead(err)) {
        // A message that sounds dead but matched nothing is a blind spot, not a request
        // error: say so, so a changed wording cannot turn into "never works again".
        if (DEAD_WORDS.test(messageOf(err)) && (err as { code?: string }).code === undefined) {
          this.notice.unmatchedDeadText = messageOf(err);
        }
        throw err;
      }
      const previousTabId = this.lastPageId;
      this.live = null;
      this.pending = null;
      const replacement = await this.attach();
      try {
        const value = await this.remember(await fn(replacement));
        this.notice.replaced = {
          previousTabId,
          // Only what this call actually returned; takeNotice() can fill a gap later.
          currentTabId: pageIdOf(value),
          cause: messageOf(err),
        };
        return value;
      } catch (retryError) {
        // The retry failed too. The caller still has to know that the object changed
        // underneath it, and both reasons have to survive - losing either turns a
        // two-part failure into a one-line mystery.
        this.notice.replaced = {
          previousTabId,
          currentTabId: this.lastPageId,
          cause: `${messageOf(err)}; retry on the new session also failed: ${messageOf(retryError)}`,
        };
        if (retryError instanceof ActionError) {
          // data is readonly on ActionError: build a new one with both causes attached.
          throw new ActionError(retryError.code, retryError.message, {
            ...(retryError.hint ? { hint: retryError.hint } : {}),
            data: { ...(retryError.data ?? {}), previousFailure: messageOf(err), previousTabId },
            cause: retryError.cause ?? retryError,
          });
        }
        throw new ActionError('E_ACTION_FAILED', 'the call failed on the original session and again on the new one', {
          hint: 'Call doctor, then retry. The page you were using may no longer exist.',
          data: { first: messageOf(err), second: messageOf(retryError), previousTabId },
          cause: retryError,
        });
      }
    }
  }

  /**
   * Drop the attached session and attach again. Used when the failure came from a page
   * operation rather than from this class, so the caller can retry once against a live
   * page and learn that the object changed underneath it.
   */
  async recover(cause: string): Promise<boolean> {
    if (!this.live) return false;
    const previousTabId = this.lastPageId;
    this.live = null;
    this.pending = null;
    this.lastFailure = null;
    this.lastPageId = null;
    try {
      await this.attach();
    } catch {
      return false;
    }
    this.notice.replaced = { previousTabId, currentTabId: null, cause };
    return true;
  }

  /** Remember which page answered, so a later replacement can name the one that died. */
  private remember<T>(value: T): T {
    const id = pageIdOf(value);
    if (id) this.lastPageId = id;
    return value;
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

  /** Optional on BrowserSession: forwarded when the transport offers it. */
  async tabList(): Promise<TabDescriptor[]> {
    const session = await this.attach();
    if (!session.tabList) {
      throw new ActionError('E_TARGET_UNSUPPORTED', 'this transport cannot list tabs', {
        hint: 'Use doctor for the current tab, or attach over CDP to list every tab.',
      });
    }
    return this.retryOnDead((live) => (live.tabList as () => Promise<TabDescriptor[]>)());
  }

  async focusDifference(): Promise<{ current: string | null; foreground: string | null } | null> {
    if (!this.live?.focusDifference) return null;
    return this.live.focusDifference().catch(() => null);
  }

  async selectTab(id: string): Promise<void> {
    const session = await this.attach();
    if (!session.selectTab) {
      throw new ActionError('E_TARGET_UNSUPPORTED', 'this transport cannot select a tab', {
        hint: 'Use doctor to see the current tab, or attach over CDP to choose one.',
      });
    }
// Deliberately not `retryOnDead`: that helper re-attaches and runs the callback
    // again. For a read that is what you want. For this one it would set the default
    // target twice and, because the repeat succeeds, the caller would never learn the
    // first attempt may already have landed. Let the dead error through; the MCP layer
    // answers with `sessionReplaced` and says the action may already have happened.
    await session.selectTab(id);
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

function pageIdOf(value: unknown): string | null {
  // Deliberately not derived from pages(): with several tabs there is no "the" page,
  // and naming the wrong previous tab would be worse than saying nothing.
  if (Array.isArray(value)) return null;
  if (value && typeof value === 'object' && 'id' in value) return String((value as { id: unknown }).id);
  return null;
}
