/**
 * Transport: how we reach a browser.
 *
 * Two implementations are planned — direct CDP against a Chrome started with a
 * debugging port, and a Chrome extension that bridges over native messaging.
 * The API layer only sees this interface, so the second one can be swapped in
 * without touching tool behavior.
 */

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

  async activePage(): Promise<RuntimePage> {
    if (this.preferred && !this.preferred.isClosed()) return this.wrap(this.preferred);
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const last = pages[pages.length - 1];
    if (!last) throw new Error('no page available');
    this.preferred = last;
    return this.wrap(last);
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




