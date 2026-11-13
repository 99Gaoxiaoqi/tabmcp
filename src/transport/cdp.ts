/**
 * Transport: how we reach a browser.
 *
 * Two implementations are planned — direct CDP against a Chrome started with a
 * debugging port, and a Chrome extension that bridges over native messaging.
 * The API layer only sees this interface, so the second one can be swapped in
 * without touching tool behavior.
 */

import { ActionError } from '../core/errors.js';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { PlaywrightPage } from './playwright-page.js';
import type { RuntimePage } from './page.js';

/** One tab as the caller sees it: identity, what it shows, and where the user is. */
export interface TabDescriptor {
  id: string;
  url: string;
  title: string;
  /** True when a call without a tab would use this one. */
  currentTarget: boolean;
  /** True when the tab is actually visible to the user. */
  focused: boolean;
}

export interface BrowserSession {
  readonly kind: 'cdp' | 'extension';
  /** Optional CDP event stream, used by recon; transports without it report unavailable. */
  onNetworkEvent?(listener: (event: { method: string; params?: Record<string, unknown> }) => void): void;
  /** Pages the agent may operate on. */
  pages(): Promise<RuntimePage[]>;
  /** The page to use when the caller did not name one. */
  activePage(): Promise<RuntimePage>;
  newPage(): Promise<RuntimePage>;
  /** Every tab the agent may operate on, with the user-facing facts about it. */
  tabList?(): Promise<TabDescriptor[]>;
  /** Set the default target. Deliberately not "use once": stickiness must survive. */
  selectTab?(id: string): Promise<void>;
  /** Non-null only when the user is looking at a different tab than the target. */
  focusDifference?(): Promise<{ current: string | null; focused: string | null } | null>;
  close(): Promise<void>;
}

export interface CdpSessionOptions {
  /** e.g. http://127.0.0.1:9222 */
  endpoint: string;
}

/** Direct CDP session: attaches to an already running browser. */
export class CdpSession implements BrowserSession {
  readonly kind = 'cdp' as const;

  private readonly owned: PlaywrightPage[] = [];

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private preferred: Page | null,
  ) {}

  static async connect(options: CdpSessionOptions): Promise<CdpSession> {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.connectOverCDP(options.endpoint);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const pages = context.pages();
    return new CdpSession(browser, context, pages[pages.length - 1] ?? null);
  }

  private readonly wrappers = new WeakMap<Page, PlaywrightPage>();
  /** Wrapper id → Playwright page, so a named id can become the default target. */
  private readonly byId = new Map<string, Page>();

  /**
   * One wrapper per underlying page. Session state lives on the wrapper (journal,
   * refs), so handing out a fresh wrapper would silently reset it mid-session.
   */
  private wrap(page: Page): PlaywrightPage {
    const existing = this.wrappers.get(page);
    if (existing) return existing;
    const created = new PlaywrightPage(page);
    this.wrappers.set(page, created);
    this.byId.set(created.id, page);
    return created;
  }

  async pages(): Promise<RuntimePage[]> {
    return this.context.pages().map((page) => this.wrap(page));
  }

  private readonly networkListeners: Array<(event: { method: string; params?: Record<string, unknown> }) => void> = [];
  private readonly attachedPages = new WeakSet<Page>();
  /** One page-hook for the whole session; a hook per listener grows on every reconnect. */
  private pageHookInstalled = false;
  /** CDP sessions this transport opened, so close() can detach them. */
  private readonly cdpSessions: Array<{ detach(): Promise<void> }> = [];
  /** Pages whose network attach failed; retried next time pages are walked. */
  private readonly attachErrors = new Map<Page, string>();

  /**
   * Real CDP events from the underlying browser, so recon works on this transport
   * too. Playwright's own page events are close but not the same shape the recorder
   * reads, and inventing a second event vocabulary invites drift.
   */
  onNetworkEvent(listener: (event: { method: string; params?: Record<string, unknown> }) => void): void {
    if (!this.networkListeners.includes(listener)) this.networkListeners.push(listener);
    for (const page of this.context.pages()) void this.attachNetwork(page);
    if (!this.pageHookInstalled) {
      this.pageHookInstalled = true;
      this.context.on('page', (page) => void this.attachNetwork(page));
    }
  }

  /** Network-attach failures, for doctor-style reporting rather than silent gaps. */
  networkAttachDiagnostics(): Array<{ url: string; error: string }> {
    return [...this.attachErrors].map(([page, error]) => ({ url: page.url(), error }));
  }

  private async attachNetwork(page: Page): Promise<void> {
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    try {
      const session = await page.context().newCDPSession(page);
      await session.send('Network.enable');
      this.cdpSessions.push(session);
      this.attachErrors.delete(page);
      for (const method of ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed']) {
        session.on(method as 'Network.requestWillBeSent', (params) => {
          for (const listener of this.networkListeners) listener({ method, params: params as Record<string, unknown> });
        });
      }
    } catch (error) {
      // A page can vanish before the session attaches. Drop the marker so the
      // next walk retries, and keep the reason: an empty event stream otherwise
      // reads as "this tab made no requests".
      this.attachedPages.delete(page);
      this.attachErrors.set(page, error instanceof Error ? error.message : String(error));
    }
  }

  /** Set when activePage() had to abandon a page the caller was using. */
  private replaced: { previousTabId: string | null; currentTabId: string; cause: string } | null = null;

  /** Hand the replacement news to the caller once. */
  takePageReplacement(): { previousTabId: string | null; currentTabId: string; cause: string } | null {
    const replaced = this.replaced;
    this.replaced = null;
    return replaced;
  }

  async activePage(): Promise<RuntimePage> {
    if (this.preferred && !this.preferred.isClosed()) return this.wrap(this.preferred);
    const abandoned = this.preferred && this.preferred.isClosed() ? this.wrap(this.preferred).id : null;
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const last = pages[pages.length - 1];
    if (!last) throw new ActionError('E_NO_TAB', 'no page available');
    this.preferred = last;
    const wrapped = this.wrap(last);
    if (abandoned) {
      this.replaced = {
        previousTabId: abandoned,
        currentTabId: wrapped.id,
        cause: 'the page in use was closed',
      };
    }
    return wrapped;
  }

  /**
   * `document.visibilityState` is the only foreground signal a page can be asked for.
   * It says "the user is looking at this tab", which is what "focused" has to mean here:
   * the alternative is guessing from focus events we never subscribe to.
   */
  private async visibility(page: RuntimePage): Promise<boolean> {
    return page
      .evaluate<boolean>("document.visibilityState === 'visible'")
      .then((visible) => Boolean(visible))
      .catch(() => false);
  }

  async tabList(): Promise<TabDescriptor[]> {
    const pages = await this.pages();
    const preferred = this.preferred && !this.preferred.isClosed() ? this.wrap(this.preferred).id : null;
    return Promise.all(
      pages.map(async (page) => ({
        id: page.id,
        url: await page.url().catch(() => ''),
        title: await page.title().catch(() => ''),
        currentTarget: page.id === preferred,
        focused: await this.visibility(page),
      })),
    );
  }

  async focusDifference(): Promise<{ current: string | null; focused: string | null } | null> {
    const pages = await this.pages();
    const current = this.preferred && !this.preferred.isClosed() ? this.wrap(this.preferred).id : null;
    let focused: string | null = null;
    for (const page of pages) {
      if (await this.visibility(page)) {
        focused = page.id;
        break;
      }
    }
    if (!focused || !current || focused === current) return null;
    return { current, focused };
  }

  async selectTab(id: string): Promise<void> {
    const pages = await this.pages();
    const target = pages.find((page) => page.id === id);
    if (!target) {
      throw new ActionError('E_NO_TAB', `no tab with id ${id}`, {
        hint: 'Call browser_tabs to list the ids this session can use.',
        data: { id, known: pages.map((page) => page.id) },
      });
    }
    const raw = this.byId.get(target.id);
    if (!raw) throw new ActionError('E_NO_TAB', `tab ${id} is no longer available`, { data: { id } });
    // Sticky on purpose: the next call that names no tab must use this one.
    this.preferred = raw;
  }

  async newPage(): Promise<RuntimePage> {
    const page = await this.context.newPage();
    this.preferred = page;
    const wrapped = this.wrap(page);
    this.owned.push(wrapped);
    return wrapped;
  }

  /**
   * Close scratch tabs this session opened; keep anything marked deliverable or
   * handoff, and never touch tabs the user opened themselves.
   */
  async close(): Promise<void> {
    for (const page of this.owned) {
      if (page.retention) continue;
      await page.raw.close({ runBeforeUnload: false }).catch(() => undefined);
    }
    this.owned.length = 0;
    // Detach the network sessions we opened: an attached session keeps the page's
    // instrumentation alive after the transport is gone.
    for (const session of this.cdpSessions.splice(0)) {
      await session.detach().catch(() => undefined);
    }
    // connectOverCDP: closing the connection must not kill the user's browser.
    await this.browser.close().catch(() => undefined);
  }
}




