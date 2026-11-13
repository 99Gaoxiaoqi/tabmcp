/**
 * Network tap: keeps a page's CDP network events flowing across full-page
 * navigations, and says so when it cannot.
 *
 * NOT A FIX FOR AN OBSERVED DEFECT. The motivating story was "a full navigation
 * replaces the page target and the old session goes quiet without raising
 * anything". That story was repeated several times before anyone measured it, and on
 * Chrome 157.0.8103.51 it does not reproduce: with re-attach disabled, a same-origin
 * and a cross-origin `page.goto` both kept delivering the new page's requests (/api
 * requests seen: 1 before the navigation, 2 after, and the new page's own fetch was
 * among them). The claim "the product drops events after a navigation" therefore has
 * no evidence behind it, and nothing here repairs it.
 *
 * What this module is instead: defense in depth for a failure mode nobody has
 * observed yet. If a session does die silently - a target replaced out from under us,
 * a renderer swap that outlives the session - every `send` still resolves and no
 * event ever arrives again, which downstream is indistinguishable from "this page
 * really made no requests". Re-attaching on main-frame navigation turns that into a
 * recoverable gap instead of a silent zero.
 *
 * Two states matter to callers, and they are not the same thing:
 *
 *   attachLost: true                   - no session is attached right now; the
 *                                        stream is frozen until a re-attach succeeds.
 *   attachLost: false + lostAtSequence - a gap happened earlier and was closed; the
 *                                        stream is live again, but everything between
 *                                        lostAtSequence and the recovery is missing.
 *
 * `lostAtSequence` is the number of events forwarded before the gap started, so a
 * consumer can say "trust what I gave you before this sequence, nothing after".
 */

export const NETWORK_METHODS = [
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFailed',
] as const;

export type NetworkMethod = (typeof NETWORK_METHODS)[number];
export type NetworkEventPayload = { method: string; params?: Record<string, unknown> };

/** The slice of a Playwright CDPSession this module needs. */
export interface TapSession {
  send(method: string): Promise<unknown>;
  on(method: string, handler: (params: unknown) => void): void;
  detach(): Promise<void>;
}

/** The slice of a Playwright Page this module needs. */
export interface TapPage {
  url(): string;
  isClosed(): boolean;
  context(): { newCDPSession(page: never): Promise<TapSession> };
  on(event: 'framenavigated', handler: (frame: { parentFrame(): unknown | null }) => void): void;
}

export interface TapState {
  /** No session is attached right now. The event stream is frozen. */
  attachLost: boolean;
  /** Events forwarded before the most recent gap; null if there has never been one. */
  lostAtSequence: number | null;
}

interface PageEntry {
  session: TapSession | null;
  error: string | null;
  hookInstalled: boolean;
  /** Serialises attach/re-attach per page so two navigations cannot race. */
  queue: Promise<void>;
}

export class NetworkTap {
  private readonly entries = new Map<TapPage, PageEntry>();
  private forwarded = 0;
  private lostAt: number | null = null;

  constructor(private readonly emit: (event: NetworkEventPayload) => void) {}

  /** Attach to a page once; later calls are cheap no-ops. */
  ensureAttached(page: TapPage): Promise<void> {
    const entry = this.entry(page);
    return this.enqueue(page, entry, () => this.attachNow(page, entry));
  }

  /** Drop the session for this page and open a new one. Navigation calls this. */
  reattach(page: TapPage): Promise<void> {
    const entry = this.entry(page);
    return this.enqueue(page, entry, async () => {
      await this.detachNow(entry);
      await this.attachNow(page, entry);
    });
  }

  /** Close every session this tap opened. */
  async detachAll(): Promise<void> {
    for (const entry of this.entries.values()) await this.detachNow(entry);
    this.entries.clear();
  }

  /** Events this tap forwarded so far, across every page. */
  get sequence(): number {
    return this.forwarded;
  }

  state(): TapState {
    // Derived, never latched: a page that re-attached successfully stops counting as
    // lost by itself. Keeping a boolean flag here meant every recovery path had to
    // remember to clear it - the same shape of bug this module exists to fix.
    const attached = [...this.entries.values()].some((entry) => entry.session === null && entry.error !== null);
    return { attachLost: attached, lostAtSequence: this.lostAt };
  }

  /** One line per page that is not currently attached, for doctor-style output. */
  diagnostics(): Array<{ url: string; error: string }> {
    const out: Array<{ url: string; error: string }> = [];
    for (const [page, entry] of this.entries) {
      if (!entry.error) continue;
      out.push({ url: page.url(), error: entry.error });
    }
    return out;
  }

  private entry(page: TapPage): PageEntry {
    let entry = this.entries.get(page);
    if (!entry) {
      entry = { session: null, error: null, hookInstalled: false, queue: Promise.resolve() };
      this.entries.set(page, entry);
    }
    return entry;
  }

  private enqueue(page: TapPage, entry: PageEntry, work: () => Promise<void>): Promise<void> {
    const next = entry.queue.then(work, work);
    // Keep the chain alive even when a step rejects: the caller still sees the
    // rejection, but the next attach does not inherit it.
    entry.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async attachNow(page: TapPage, entry: PageEntry): Promise<void> {
    if (entry.session) return;
    if (page.isClosed()) {
      this.markLost(entry, 'page closed before the network tap could attach');
      return;
    }
    try {
      const session = await page.context().newCDPSession(page as never);
      await session.send('Network.enable');
      entry.session = session;
      entry.error = null;
      for (const method of NETWORK_METHODS) {
        session.on(method, (params) => {
          this.forwarded++;
          this.emit({ method, params: params as Record<string, unknown> });
        });
      }
      this.installNavigationHook(page, entry);
    } catch (error) {
      this.markLost(entry, error instanceof Error ? error.message : String(error));
    }
  }

  private installNavigationHook(page: TapPage, entry: PageEntry): void {
    if (entry.hookInstalled) return;
    entry.hookInstalled = true;
    page.on('framenavigated', (frame) => {
      // Only the main frame replaces the target. Sub-frame navigations reuse the
      // session, so re-attaching on them would open sessions for no reason.
      if (frame.parentFrame() !== null) return;
      void this.reattach(page);
    });
  }

  private async detachNow(entry: PageEntry): Promise<void> {
    const session = entry.session;
    entry.session = null;
    if (!session) return;
    await session.detach().catch(() => undefined);
  }

  /**
   * Record a gap. The sequence is captured here, at the moment events stopped, so a
   * caller reading it later gets the boundary rather than "whenever the report ran".
   */
  private markLost(entry: PageEntry, error: string): void {
    if (this.lostAt === null) this.lostAt = this.forwarded;
    entry.error = error;
  }
}
