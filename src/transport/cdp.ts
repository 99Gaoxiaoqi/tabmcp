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

export interface BrowserSession {
  readonly kind: 'cdp' | 'extension';
  /** Optional CDP event stream, used by recon; transports without it report unavailable. */
  onNetworkEvent?(listener: (event: { method: string; params?: Record<string, unknown> }) => void): void;
  /** Pages the agent may operate on. */
  pages(): Promise<RuntimePage[]>;
  /** The page to use when the caller did not name one. */
  activePage(): Promise<RuntimePage>;
  newPage(): Promise<RuntimePage>;
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

  /**
   * One wrapper per underlying page. Session state lives on the wrapper (journal,
   * refs), so handing out a fresh wrapper would silently reset it mid-session.
   */
  private wrap(page: Page): PlaywrightPage {
    const existing = this.wrappers.get(page);
    if (existing) return existing;
    const created = new PlaywrightPage(page);
    this.wrappers.set(page, created);
    return created;
  }

  async pages(): Promise<RuntimePage[]> {
    return this.context.pages().map((page) => this.wrap(page));
  }

  private readonly networkListeners: Array<(event: { method: string; params?: Record<string, unknown> }) => void> = [];
  private readonly attachedPages = new WeakSet<Page>();

  /**
   * Real CDP events from the underlying browser, so recon works on this transport
   * too. Playwright's own page events are close but not the same shape the recorder
   * reads, and inventing a second event vocabulary invites drift.
   */
  onNetworkEvent(listener: (event: { method: string; params?: Record<string, unknown> }) => void): void {
    this.networkListeners.push(listener);
    for (const page of this.context.pages()) void this.attachNetwork(page);
    this.context.on('page', (page) => void this.attachNetwork(page));
  }

  private async attachNetwork(page: Page): Promise<void> {
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    try {
      const session = await page.context().newCDPSession(page);
      await session.send('Network.enable');
      for (const method of ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed']) {
        session.on(method as 'Network.requestWillBeSent', (params) => {
          for (const listener of this.networkListeners) listener({ method, params: params as Record<string, unknown> });
        });
      }
    } catch {
      // A page can vanish before the session attaches; drop it.
      this.attachedPages.delete(page);
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
    // connectOverCDP: closing the connection must not kill the user's browser.
    await this.browser.close().catch(() => undefined);
  }
}




