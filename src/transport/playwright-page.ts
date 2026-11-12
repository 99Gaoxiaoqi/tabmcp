/**
 * Playwright-backed RuntimePage.
 *
 * Thin adapter: Playwright already implements the semantics, this only narrows
 * the surface and normalises errors so the API layer stays transport-agnostic.
 */

import type { Page } from 'playwright-core';
import { ANNOTATE_SCRIPT, REMOVE_ANNOTATION_SCRIPT } from '../core/annotate.js';
import { CONTENT_STATE_SCRIPT, NetworkJournal } from '../core/journal.js';
import { NetworkCounter, type NetworkInfo } from '../core/activity.js';
import type {
  EvaluateOptions,
  Expectation,
  ExpectResult,
  FetchJsonOptions,
  FindHit,
  FindTarget,
  FrameInfo,
  NavigationResult,
  Retention,
  RuntimePage,
  ScreenshotOptions,
} from './page.js';

export class PlaywrightPage implements RuntimePage {
  readonly id: string;
  private network: NetworkCounter | undefined;
  private retentionState: Retention = null;

  constructor(private readonly page: Page) {
    this.id = `pw-${Math.random().toString(16).slice(2, 10)}`;
  }

  get raw(): Page {
    return this.page;
  }

  get retention(): Retention {
    return this.retentionState;
  }

  async url(): Promise<string> {
    return this.page.url();
  }

  async title(): Promise<string> {
    return this.page.title().catch(() => '');
  }

  async goto(
    url: string,
    options: { timeoutMs: number; waitUntil: 'load' | 'domcontentloaded' | 'commit' },
  ): Promise<NavigationResult> {
    const response = await this.page.goto(url, { waitUntil: options.waitUntil, timeout: options.timeoutMs });
    return { url: this.page.url(), status: response ? response.status() : null };
  }

  async evaluate<T = unknown>(script: string, options?: EvaluateOptions): Promise<T> {
    const result = await this.page.evaluate(script);
    void options;
    return result as T;
  }

  async evaluateInFrame(target: { index?: number; frameId?: string }, script: string): Promise<unknown> {
    const frames = this.page.frames();
    const frame =
      target.index !== undefined
        ? frames[target.index]
        : frames.find((candidate) => candidate.name() === target.frameId);
    if (!frame) {
      throw new Error(`frame not found (index ${target.index ?? '-'}, id ${target.frameId ?? '-'})`);
    }
    return frame.evaluate(script);
  }

  async click(selector: string, timeoutMs: number): Promise<void> {
    await this.page.locator(selector).first().click({ timeout: timeoutMs });
  }

  async fill(selector: string, value: string, timeoutMs: number): Promise<void> {
    await this.page.locator(selector).first().fill(value, { timeout: timeoutMs });
  }

  async press(selector: string, key: string, timeoutMs: number): Promise<void> {
    await this.page.locator(selector).first().press(key, { timeout: timeoutMs });
  }

  async selectOption(selector: string, value: string, timeoutMs: number): Promise<void> {
    await this.page.locator(selector).first().selectOption(value, { timeout: timeoutMs });
  }

  async hover(selector: string, timeoutMs: number): Promise<void> {
    await this.page.locator(selector).first().hover({ timeout: timeoutMs });
  }

  async scrollIntoView(selector: string, timeoutMs: number): Promise<void> {
    await this.page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: timeoutMs });
  }

  async waitForSelector(selector: string, timeoutMs: number, state: 'visible' | 'attached' = 'visible'): Promise<void> {
    await this.page.locator(selector).first().waitFor({ state, timeout: timeoutMs });
  }

  async waitForNavigation(timeoutMs: number): Promise<boolean> {
    try {
      await this.page.waitForNavigation({ waitUntil: 'commit', timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  async screenshot(options: ScreenshotOptions): Promise<Buffer> {
    if (options.annotate) await this.page.evaluate(ANNOTATE_SCRIPT).catch(() => 0);
    try {
      return await this.page.screenshot({
        fullPage: options.fullPage ?? false,
        type: options.format ?? 'png',
        ...(options.format === 'jpeg' ? { quality: options.quality ?? 80 } : {}),
      });
    } finally {
      if (options.annotate) await this.page.evaluate(REMOVE_ANNOTATION_SCRIPT).catch(() => undefined);
    }
  }

  async frames(): Promise<FrameInfo[]> {
    return this.page.frames().map((frame, index) => ({
      index,
      frameId: frame.name() || `frame-${index}`,
      url: frame.url(),
      name: frame.name(),
    }));
  }

  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: 'load' }).catch(() => undefined);
  }

  async back(): Promise<void> {
    await this.page.goBack({ waitUntil: 'load' }).catch(() => null);
  }

  async forward(): Promise<void> {
    await this.page.goForward({ waitUntil: 'load' }).catch(() => null);
  }

  async cookies(domain: string): Promise<Array<{ name: string; value: string; domain: string; path?: string }>> {
    const all = await this.page.context().cookies();
    return all
      .filter((cookie) => !domain || cookie.domain === domain || cookie.domain === `.${domain}` || cookie.domain.endsWith(domain))
      .map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path }));
  }

  async download(options: { selector: string; timeoutMs?: number }): Promise<{ filename?: string; bytes?: number; path?: string }> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const [download] = await Promise.all([
      this.page.waitForEvent('download', { timeout: timeoutMs }),
      this.page.locator(options.selector).first().click({ timeout: timeoutMs }),
    ]);
    const filePath = await download.path().catch(() => null);
    const failure = await download.failure();
    if (failure) throw new Error(`download failed: ${failure}`);
    return {
      filename: download.suggestedFilename(),
      ...(filePath ? { path: filePath } : {}),
      ...(filePath ? { bytes: (await import('node:fs')).statSync(filePath).size } : {}),
    };
  }

  async contentState(): Promise<'ready' | 'empty' | 'placeholder' | 'unknown'> {
    return this.page.evaluate<'ready' | 'empty' | 'placeholder'>(CONTENT_STATE_SCRIPT).catch(() => 'unknown');
  }

  async networkRead(options: {
    pattern?: string;
    limit?: number;
    afterSequence?: number;
    includeStatic?: boolean;
  } = {}): Promise<{ cursor: number; entries: Array<Record<string, unknown>>; hasMore: boolean }> {
    await this.ensureJournal();
    const result = this.journal.read(options);
    return {
      cursor: result.cursor,
      entries: result.entries.map((entry) => ({ ...entry })),
      hasMore: result.hasMore,
    };
  }

  private journal = new NetworkJournal();
  private journalAttached = false;

  /** Attaches response-body capture for the journal. */
  private async ensureJournal(): Promise<void> {
    if (this.journalAttached) return;
    this.journalAttached = true;
    try {
      const session = await this.page.context().newCDPSession(this.page);
      await session.send('Network.enable');
      session.on('Network.requestWillBeSent', (event) => {
        this.journal.requestStarted(event.requestId, event.request.method, event.request.url);
      });
      session.on('Network.responseReceived', async (event) => {
        const mimeType = event.response.mimeType;
        if (!/json|text\/plain/i.test(mimeType)) return;
        try {
          const body = (await session.send('Network.getResponseBody', { requestId: event.requestId })) as {
            body: string;
            base64Encoded: boolean;
          };
          const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
          this.journal.record(event.requestId, event.response.status, mimeType, text);
        } catch {
          // Body already evicted or not retrievable; drop the entry.
        }
      });
      session.on('Network.loadingFailed', (event) => this.journal.requestFinished(event.requestId));
    } catch {
      this.journalAttached = false;
    }
  }

  async markDeliverable(): Promise<void> {
    this.retentionState = 'deliverable';
  }

  async markHandoff(): Promise<void> {
    this.retentionState = 'handoff';
  }

  async clearRetention(): Promise<void> {
    this.retentionState = null;
  }

  async cookie(name: string, options: { domain?: string } = {}): Promise<string | undefined> {
    const cookies = await this.page.context().cookies();
    const hit = cookies.find(
      (cookie) =>
        cookie.name === name &&
        (!options.domain || cookie.domain === options.domain || cookie.domain === `.${options.domain}`),
    );
    return hit?.value;
  }

  async fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<T> {
    // Fetch from the page: that is what carries the user's cookies and origin.
    const payload = JSON.stringify({
      url,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      body: options.body === undefined ? null : JSON.stringify(options.body),
      timeoutMs: options.timeoutMs ?? 20_000,
    });
    const result = await this.page.evaluate<string>(`(async () => {
      const spec = ${payload};
      const target = new URL(spec.url, location.href).toString();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
      try {
        const response = await fetch(target, {
          method: spec.method,
          headers: spec.headers,
          body: spec.body === null ? undefined : spec.body,
          credentials: 'include',
          signal: controller.signal,
        });
        const text = await response.text();
        return JSON.stringify({ status: response.status, ok: response.ok, text });
      } catch (error) {
        return JSON.stringify({ status: 0, ok: false, text: String((error && error.message) || error) });
      } finally {
        clearTimeout(timer);
      }
    })()`);
    const parsed = JSON.parse(result) as { status: number; ok: boolean; text: string };
    if (!parsed.ok) throw new Error(`fetch ${parsed.status}: ${parsed.text.slice(0, 300)}`);
    try {
      return JSON.parse(parsed.text) as T;
    } catch {
      throw new Error(`response is not JSON: ${parsed.text.slice(0, 300)}`);
    }
  }

  async find(target: FindTarget): Promise<FindHit[]> {
    return this.page.evaluate<FindHit[]>(`(() => {
      const spec = ${JSON.stringify(target)};
      const wanted = spec.limit || 10;
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const roleOf = (el) => clean(el.getAttribute('role')) || el.tagName.toLowerCase();
      const nameOf = (el) => clean(el.getAttribute('aria-label')) || clean(el.innerText || el.textContent).slice(0, 80);
      const out = [];
      for (const el of document.querySelectorAll(spec.css || '*')) {
        if (out.length >= wanted) break;
        const name = nameOf(el);
        if (spec.role && roleOf(el) !== spec.role) continue;
        if (spec.name && !name.toLowerCase().includes(String(spec.name).toLowerCase())) continue;
        if (spec.text && !clean(el.textContent).toLowerCase().includes(String(spec.text).toLowerCase())) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const ref = el.getAttribute('data-bmcp-ref');
        if (!ref) continue;
        out.push({ ref, role: roleOf(el), name, value: el.value || undefined });
      }
      return out;
    })()`);
  }

  async expect(what: Expectation, options: { timeoutMs?: number } = {}): Promise<ExpectResult> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const state = await this.page.evaluate<{ selector: boolean; text: boolean; url: boolean }>(`(() => {
        const spec = ${JSON.stringify(what)};
        const hasSelector = spec.selector
          ? (() => { const el = document.querySelector(spec.selector); if (!el) return false;
              const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; })()
          : true;
        const bodyText = document.body ? (document.body.innerText || '') : '';
        return {
          selector: hasSelector,
          text: spec.text ? bodyText.includes(spec.text) : true,
          url: spec.url ? location.href.includes(spec.url) : true,
        };
      })()`);
      if (state.selector && state.text && state.url) return { ok: true, waitedMs: Date.now() - started };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { ok: false, waitedMs: Date.now() - started, detail: 'expectation not met before timeout' };
  }

  async networkInfo(since: number): Promise<NetworkInfo> {
    const counter = await this.ensureNetwork();
    return counter ? counter.info(since) : { pending: 0, idleMs: Number.POSITIVE_INFINITY };
  }

  private async ensureNetwork(): Promise<NetworkCounter | undefined> {
    if (this.network) return this.network;
    try {
      const session = await this.page.context().newCDPSession(this.page);
      await session.send('Network.enable');
      const counter = new NetworkCounter();
      this.network = counter;
      session.on('Network.requestWillBeSent', (event) => counter.started(event.requestId));
      session.on('Network.loadingFinished', (event) => counter.finished(event.requestId));
      session.on('Network.loadingFailed', (event) => counter.finished(event.requestId));
      return counter;
    } catch {
      return undefined;
    }
  }

  isClosed(): boolean {
    return this.page.isClosed();
  }

  async close(): Promise<void> {
    // The tab belongs to the user's browser: closing the transport must not
    // silently close what they were looking at.
    return;
  }
}

