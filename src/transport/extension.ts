/**
 * Extension transport: drive Chrome through the broker socket.
 *
 * This is the path that keeps the user's real browser (and its logins) while an
 * agent is in control. Every operation is a CDP command sent through the
 * extension, so behavior matches the Playwright path closely.
 */

import { ActionError } from '../core/errors.js';
import net from 'node:net';
import fs from 'node:fs';
import { encodeFrame, FrameDecoder, type BrokerRequest, type BrokerResponse, type BrokerEvent, type TabInfo } from '../protocol.js';
import { NetworkCounter, type NetworkInfo } from '../core/activity.js';
import { ANNOTATE_SCRIPT, REMOVE_ANNOTATION_SCRIPT } from '../core/annotate.js';
import { CONTENT_STATE_SCRIPT, NetworkJournal } from '../core/journal.js';
import { cookieMatchesDomain, normalizeCookies, type Cookie } from '../core/cookie.js';
import type { BrowserSession } from './cdp.js';
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

interface BrokerClientOptions {
  stateFile: string;
  /** How long to wait for a live broker while Chrome restarts its host. */
  waitMs?: number;
}

/** One connection to the broker, shared by every page of this session. */
class BrokerClient {
  private socket: net.Socket;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners: Array<(event: BrokerEvent) => void> = [];
  private id = 0;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      for (const raw of this.decoder.push(chunk)) {
        const message = raw as BrokerResponse & Partial<BrokerEvent>;
        if (message.event === 'cdp') {
          for (const listener of this.listeners) listener(message as BrokerEvent);
          continue;
        }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        const error = (message as { error?: { message: string } }).error;
        if (error) pending.reject(new Error(error.message));
        else pending.resolve((message as { result: unknown }).result);
      }
    });
    socket.on('error', () => undefined);
  }

  static async connect(options: BrokerClientOptions): Promise<BrokerClient> {
    // A broker only exists while the extension holds its native port open. When
    // Chrome restarts the host, the state file briefly points at a dead port; wait
    // for the new one instead of failing the whole session on a stale read.
    const deadline = Date.now() + (options.waitMs ?? 20_000);
    let lastError: unknown = null;
    for (;;) {
      if (fs.existsSync(options.stateFile)) {
        try {
          const { port, token } = JSON.parse(fs.readFileSync(options.stateFile, 'utf8')) as {
            port: number;
            token: string;
          };
          const socket = await new Promise<net.Socket>((resolve, reject) => {
            const conn = net.createConnection({ host: '127.0.0.1', port }, () => resolve(conn));
            conn.once('error', reject);
          });
          const client = new BrokerClient(socket);
          // First frame authorises the connection.
          socket.write(encodeFrame({ id: 0, method: 'auth', token }));
          return client;
        } catch (error) {
          lastError = error;
        }
      }
      if (Date.now() >= deadline) {
        throw new ActionError('E_BROWSER_DISCONNECTED', `no live broker at ${options.stateFile}`, {
          hint: 'Start Chrome with the BrowserMCP extension loaded; it reconnects within a few seconds.',
          cause: lastError,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  on(listener: (event: BrokerEvent) => void): void {
    this.listeners.push(listener);
  }

  request(request: Omit<BrokerRequest, 'id'>, timeoutMs = 30_000): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`broker request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeFrame({ ...request, id } as BrokerRequest));
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

/** A page implemented over CDP commands relayed by the extension. */
export class ExtensionPage implements RuntimePage {
  readonly id: string;
  private readonly network = new NetworkCounter();
  private closed = false;

  constructor(
    private readonly client: BrokerClient,
    readonly tabId: number,
    private readonly onEvent: (listener: (event: BrokerEvent) => void) => void,
    private readonly onRetentionChange?: (tabId: number, retention: Retention) => void,
  ) {
    this.id = `ext-${tabId}`;
    this.onEvent((event) => {
      if (event.tabId !== this.tabId) return;
      if (event.method === 'Network.requestWillBeSent') {
        const requestId = (event.params?.requestId as string | undefined) ?? '';
        this.network.started(requestId);
      } else if (event.method === 'Network.loadingFinished' || event.method === 'Network.loadingFailed') {
        const requestId = (event.params?.requestId as string | undefined) ?? '';
        this.network.finished(requestId);
      } else {
        this.network.markEvent();
      }
    });
    void this.enableDomains();
    // Traffic before the first navigation still counts: network_read and recon read
    // this feed, and an agent often attaches to a page that is already open.
    this.ensureJournal();
  }

  private async enableDomains(): Promise<void> {
    await Promise.all([
      this.send('Page.enable').catch(() => undefined),
      this.send('Runtime.enable').catch(() => undefined),
      this.send('Network.enable').catch(() => undefined),
      // A background tab receives neither input nor screenshots reliably: input
      // events need focus emulation, and capture blocks while the tab is hidden.
      this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined),
      this.send('Page.bringToFront').catch(() => undefined),
    ]);
  }

  /** Input and capture only land on the foreground tab. */
  private async focus(): Promise<void> {
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    await this.send('Page.bringToFront').catch(() => undefined);
  }

  private async send<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    try {
      const result = await this.client.request({ method: 'cdp', params: { tabId: this.tabId, method, ...(params ? { params } : {}) } }, timeoutMs);
      return result as T;
    } catch (error) {
      // A closed tab must stop being "the active page", otherwise every later call
      // replays the same stale id.
      const message = error instanceof Error ? error.message : String(error);
      if (/No tab with given id|Cannot access a chrome:\/\/ URL/i.test(message)) this.closed = true;
      throw error;
    }
  }

  private async evaluateRaw<T>(expression: string, awaitPromise = true): Promise<T> {
    const response = await this.send<{
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
    if (response.exceptionDetails) {
      throw new ActionError('E_ACTION_FAILED', response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'evaluate failed');
    }
    return response.result?.value as T;
  }

  async url(): Promise<string> {
    return this.evaluateRaw<string>('location.href');
  }

  async title(): Promise<string> {
    return this.evaluateRaw<string>('document.title');
  }

  async goto(
    url: string,
    options: { timeoutMs: number; waitUntil: 'load' | 'domcontentloaded' | 'commit' },
  ): Promise<NavigationResult> {
    // Capture must be attached before the navigation, or the journal misses it.
    this.ensureJournal();
    // Page.navigate reports a frame id, not an HTTP status. The status is only
    // observable on the document response, so subscribe before navigating.
    const statusPromise = this.waitForDocumentStatus(Math.min(options.timeoutMs, 8_000));
    const result = await this.send<{ frameId?: string; errorText?: string }>('Page.navigate', { url });
    if (result.errorText) throw new ActionError('E_ACTION_FAILED', result.errorText);
    if (options.waitUntil !== 'commit') {
      // "complete" never arrives while a request is still pending, and waiting the
      // full timeout blocked every later call behind the queue. Interactive is
      // enough here; settle() decides whether the page has actually stopped moving.
      const deadline = Date.now() + Math.min(options.timeoutMs, 5_000);
      const started = Date.now();
      while (Date.now() < deadline) {
        const ready = await this.evaluateRaw<string>('document.readyState').catch(() => 'loading');
        if (ready === 'complete') break;
        if (ready === 'interactive' && Date.now() - started > 800) break;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
    const status = await statusPromise;
    return { url: await this.url().catch(() => url), status };
  }

  /** HTTP status of the next main-document response, or null if none arrives. */
  private async waitForDocumentStatus(timeoutMs: number): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      let settled = false;
      const finish = (value: number | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      this.onEvent((event) => {
        if (event.method !== 'Network.responseReceived') return;
        const params = event.params as { type?: string; response?: { status?: number } } | undefined;
        if (params?.type !== 'Document') return;
        finish(typeof params.response?.status === 'number' ? params.response.status : null);
      });
      setTimeout(() => finish(null), timeoutMs);
    });
  }

  async evaluate<T = unknown>(script: string, options?: EvaluateOptions): Promise<T> {
    void options;
    return this.evaluateRaw<T>(script);
  }

  /** Resolves an element's box, scrolling it into view first. */
  private async box(selector: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
    const json = JSON.stringify(selector);
    return this.evaluateRaw<{ x: number; y: number; w: number; h: number } | null>(`(() => {
      const el = document.querySelector(${json});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
  }

  private async clickAt(x: number, y: number): Promise<void> {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async click(selector: string, _timeoutMs: number): Promise<void> {
    const target = await this.box(selector);
    if (!target) throw new ActionError('E_TARGET_NOT_FOUND', 'element is not visible');
    await this.focus();
    await this.clickAt(target.x, target.y);
  }

  async fill(selector: string, value: string, _timeoutMs: number): Promise<void> {
    const target = await this.box(selector);
    if (!target) throw new ActionError('E_TARGET_NOT_FOUND', 'element is not visible');
    await this.clickAt(target.x, target.y);
    await this.evaluateRaw<unknown>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      el.value = '';
      return true;
    })()`);
    await this.send('Input.insertText', { text: value });
  }

  async press(selector: string, key: string, _timeoutMs: number): Promise<void> {
    const target = await this.box(selector);
    if (!target) throw new ActionError('E_TARGET_NOT_FOUND', 'element is not visible');
    await this.clickAt(target.x, target.y);
    const descriptor = keyToDescriptor(key);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...descriptor });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...descriptor });
  }

  async selectOption(selector: string, value: string, _timeoutMs: number): Promise<void> {
    const ok = await this.evaluateRaw<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.tagName !== 'SELECT') return false;
      const options = Array.from(el.options);
      const match = options.find((o) => o.value === ${JSON.stringify(value)}) || options.find((o) => (o.textContent || '').trim() === ${JSON.stringify(value)});
      if (!match) return false;
      el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new ActionError('E_TARGET_NOT_FOUND', 'select option not found');
  }

  async hover(selector: string, _timeoutMs: number): Promise<void> {
    const target = await this.box(selector);
    if (!target) throw new ActionError('E_TARGET_NOT_FOUND', 'element is not visible');
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
  }

  async scrollIntoView(selector: string, _timeoutMs: number): Promise<void> {
    const ok = await this.evaluateRaw<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      return true;
    })()`);
    if (!ok) throw new ActionError('E_TARGET_NOT_FOUND', 'element not found');
  }

  async waitForSelector(selector: string, timeoutMs: number, state: 'visible' | 'attached' = 'visible'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const json = JSON.stringify(selector);
    while (Date.now() < deadline) {
      const ok = await this.evaluateRaw<boolean>(`(() => {
        const el = document.querySelector(${json});
        if (!el) return false;
        ${state === 'attached' ? 'return true;' : `const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width >= 1 && r.height >= 1 && s.visibility !== 'hidden' && s.display !== 'none';`}
      })()`).catch(() => false);
      if (ok) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new ActionError('E_ACTION_TIMEOUT', `waitForSelector timed out after ${timeoutMs}ms`);
  }

  async waitForNavigation(timeoutMs: number): Promise<boolean> {
    const before = await this.evaluateRaw<string>('location.href').catch(() => '');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = await this.evaluateRaw<string>('location.href').catch(() => before);
      if (now !== before) return true;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return false;
  }

  async screenshot(options: ScreenshotOptions): Promise<Buffer> {
    const format = options.format ?? 'png';
    await this.focus();
    if (options.annotate) await this.evaluateRaw(ANNOTATE_SCRIPT).catch(() => 0);
    try {
      const result = await this.send<{ data: string }>('Page.captureScreenshot', {
        format,
        ...(options.fullPage ? { captureBeyondViewport: true } : {}),
        ...(format === 'jpeg' ? { quality: Math.round(options.quality ?? 80) } : {}),
      });
      return Buffer.from(result.data, 'base64');
    } finally {
      if (options.annotate) await this.evaluateRaw(REMOVE_ANNOTATION_SCRIPT).catch(() => undefined);
    }
  }

  networkInfo(since: number): Promise<NetworkInfo> {
    return Promise.resolve(this.network.info(since));
  }

  async cookie(name: string, options: { domain?: string } = {}): Promise<string | undefined> {
    const current = await this.url().catch(() => '');
    const urls = [current.startsWith('http') ? current : 'https://x.com'];
    const result = await this.send<{ cookies?: Array<{ name: string; value: string; domain: string }> }>(
      'Network.getCookies',
      { urls },
    ).catch(() => ({ cookies: [] as Array<{ name: string; value: string; domain: string }> }));
    const hit = (result.cookies ?? []).find(
      (cookie) =>
        cookie.name === name &&
        (!options.domain || cookie.domain === options.domain || cookie.domain === `.${options.domain}`),
    );
    return hit?.value;
  }

  async fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<T> {
    const spec = JSON.stringify({
      url,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      body: options.body === undefined ? null : JSON.stringify(options.body),
      timeoutMs: options.timeoutMs ?? 20_000,
    });
    const raw = await this.evaluateRaw<string>(`(async () => {
      const spec = ${spec};
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
    const parsed = JSON.parse(raw) as { status: number; ok: boolean; text: string };
    if (!parsed.ok) throw new ActionError('E_ACTION_FAILED', `fetch ${parsed.status}: ${parsed.text.slice(0, 300)}`);
    try {
      return JSON.parse(parsed.text) as T;
    } catch {
      throw new ActionError('E_ACTION_FAILED', `response is not JSON: ${parsed.text.slice(0, 300)}`);
    }
  }

  async find(target: FindTarget): Promise<FindHit[]> {
    return this.evaluateRaw<FindHit[]>(`(() => {
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
        out.push({ ref, role: roleOf(el), name: name ? name : '', value: el.value || undefined });
      }
      return out;
    })()`);
  }

  async expect(what: Expectation, options: { timeoutMs?: number } = {}): Promise<ExpectResult> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const state = await this.evaluateRaw<{ selector: boolean; text: boolean; url: boolean }>(`(() => {
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

  async reload(): Promise<void> {
    await this.send('Page.reload', { ignoreCache: false });
  }

  private async navigateHistory(delta: number): Promise<void> {
    const history = await this.send<{
      currentIndex: number;
      entries: Array<{ id: number; url: string }>;
    }>('Page.getNavigationHistory');
    const index = history.currentIndex + delta;
    const target = history.entries[index];
    if (!target) throw new ActionError('E_TARGET_NOT_FOUND', 'no history entry in that direction');
    await this.send('Page.navigateToHistoryEntry', { entryId: target.id });
  }

  async back(): Promise<void> {
    await this.navigateHistory(-1);
  }

  async forward(): Promise<void> {
    await this.navigateHistory(1);
  }

  async cookies(domain: string): Promise<Cookie[]> {
    const current = await this.url().catch(() => '');
    const result = await this.send<{ cookies?: Array<Record<string, unknown>> }>('Network.getCookies', {
      urls: [current.startsWith('http') ? current : `https://${domain || 'example.com'}`],
    }).catch(() => ({ cookies: [] as Array<Record<string, unknown>> }));
    return normalizeCookies((result.cookies ?? []).filter((cookie) => cookieMatchesDomain(cookie, domain)));
  }

  async download(options: { selector: string; timeoutMs?: number }): Promise<{ filename?: string; bytes?: number; path?: string }> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    // Browser.setDownloadBehavior only exists on the browser target, and this page's
    // debugger session is scoped to one tab, so the download is observed through
    // chrome.downloads in the background instead.
    const began = new Promise<{ filename?: string }>((resolve) => {
      const off = this.onDownloadEvent((event) => {
        if (event.method === 'download.created') {
          off();
          const params = (event.params ?? {}) as { filename?: string };
          resolve({ filename: params.filename ? params.filename.split(/[\\/]/).pop() : undefined });
        }
      });
      setTimeout(() => {
        off();
        resolve({});
      }, timeoutMs);
    });
    await this.click(options.selector, timeoutMs);
    const info = await began;
    if (!info.filename) {
      throw new ActionError('E_ACTION_TIMEOUT', `download did not start within ${timeoutMs}ms`, {
        hint: 'This channel only observes downloads through chrome.downloads; headless Chrome may block them.',
      });
    }
    return { filename: info.filename };
  }
  async contentState(): Promise<'ready' | 'empty' | 'placeholder' | 'unknown'> {
    return this.evaluateRaw<'ready' | 'empty' | 'placeholder'>(CONTENT_STATE_SCRIPT).catch(() => 'unknown');
  }

  async networkRead(options: {
    pattern?: string;
    limit?: number;
    afterSequence?: number;
    includeStatic?: boolean;
  } = {}): Promise<{ cursor: number; entries: Array<Record<string, unknown>>; hasMore: boolean }> {
    this.ensureJournal();
    const result = this.journal.read(options);
    return {
      cursor: result.cursor,
      entries: result.entries.map((entry) => ({ ...entry })),
      hasMore: result.hasMore,
    };
  }

  private readonly journal = new NetworkJournal();
  private journalAttached = false;
  private downloadListeners: Array<(event: { method: string; params?: Record<string, unknown> }) => void> = [];

  private onDownloadEvent(listener: (event: { method: string; params?: Record<string, unknown> }) => void): () => void {
    this.downloadListeners.push(listener);
    return () => {
      this.downloadListeners = this.downloadListeners.filter((entry) => entry !== listener);
    };
  }

  /** Journal capture: responses arrive as CDP events, bodies are fetched on demand. */
  private ensureJournal(): void {
    if (this.journalAttached) return;
    this.journalAttached = true;
    this.onEvent((event) => {
      if (event.method === 'Network.requestWillBeSent') {
        const request = event.params?.request as { url?: string; method?: string } | undefined;
        const requestId = String(event.params?.requestId ?? '');
        if (requestId && request?.url) this.journal.requestStarted(requestId, request.method ?? 'GET', request.url);
        return;
      }
      if (event.method === 'Network.responseReceived') {
        const requestId = String(event.params?.requestId ?? '');
        const response = event.params?.response as { mimeType?: string; status?: number } | undefined;
        const mimeType = response?.mimeType ?? '';
        if (!/json|text\/plain/i.test(mimeType)) return;
        void this.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId })
          .then((body) => {
            const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
            this.journal.record(requestId, response?.status, mimeType, text);
          })
          .catch(() => undefined);
        return;
      }
      if (event.method === 'Network.loadingFailed') {
        this.journal.requestFinished(String(event.params?.requestId ?? ''));
        return;
      }
      for (const listener of this.downloadListeners) listener(event);
    });
  }

  async evaluateInFrame(target: { index?: number; frameId?: string }, script: string): Promise<unknown> {
    if (target.index === 0 || (target.index === undefined && !target.frameId)) return this.evaluateRaw(script);
    if (!target.frameId) throw new ActionError('E_TARGET_UNSUPPORTED', 'only index 0 is supported without a frameId');
    const world = await this.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: target.frameId,
      worldName: 'browsermcp-frame',
    });
    const response = await this.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression: script,
      contextId: world.executionContextId,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new ActionError('E_ACTION_FAILED', response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'frame evaluate failed');
    }
    return response.result?.value;
  }

  async frames(): Promise<FrameInfo[]> {
    const tree = await this.send<{ frameTree?: { frame?: { id?: string; url?: string; name?: string } } }>('Page.getFrameTree').catch(
      () => ({}) as { frameTree?: { frame?: { id?: string; url?: string; name?: string } } },
    );
    const frame = tree.frameTree?.frame;
    if (!frame) return [{ index: 0, frameId: '', url: await this.url().catch(() => ''), name: '' }];
    return [{ index: 0, frameId: frame.id ?? '', url: frame.url ?? '', name: frame.name ?? '' }];
  }

  private retentionState: Retention = null;
  get retention(): Retention {
    return this.retentionState;
  }
  async markDeliverable(): Promise<void> {
    this.retentionState = 'deliverable';
    this.onRetentionChange?.(this.tabId, 'deliverable');
  }
  async markHandoff(): Promise<void> {
    this.retentionState = 'handoff';
    this.onRetentionChange?.(this.tabId, 'handoff');
  }
  async clearRetention(): Promise<void> {
    this.retentionState = null;
    this.onRetentionChange?.(this.tabId, null);
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function keyToDescriptor(key: string): { key: string; code: string; windowsVirtualKeyCode: number; text?: string } {
  const named: Record<string, { code: string; vk: number }> = {
    Enter: { code: 'Enter', vk: 13 },
    Tab: { code: 'Tab', vk: 9 },
    Escape: { code: 'Escape', vk: 27 },
    Backspace: { code: 'Backspace', vk: 8 },
    ArrowDown: { code: 'ArrowDown', vk: 40 },
    ArrowUp: { code: 'ArrowUp', vk: 38 },
  };
  const hit = named[key];
  if (hit) return { key, code: hit.code, windowsVirtualKeyCode: hit.vk, ...(key === 'Enter' ? { text: '\r' } : {}) };
  const upper = key.toUpperCase();
  return { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
}

/** Session over the extension: tabs come from Chrome, pages speak CDP. */
export class ExtensionSession implements BrowserSession {
  readonly kind = 'extension' as const;
  /** Tabs this session created, with what happens to them on cleanup. */
  private readonly owned = new Map<number, Retention>();
  private listeners: Array<(event: BrokerEvent) => void> = [];
  private active: ExtensionPage | null = null;

  private constructor(private readonly client: BrokerClient) {
    client.on((event) => {
      for (const listener of this.listeners) listener(event);
    });
  }

  static async connect(stateFile: string): Promise<ExtensionSession> {
    const client = await BrokerClient.connect({ stateFile });
    return new ExtensionSession(client);
  }

  /** Forwards CDP network events to recon. */
  onNetworkEvent(listener: (event: { method: string; params?: Record<string, unknown> }) => void): void {
    this.client.on((event) => {
      if (event.method.startsWith('Network.')) listener({ method: event.method, params: event.params });
    });
  }

  async tabs(): Promise<TabInfo[]> {
    const tabs = await this.client.request({ method: 'tabs', params: {} }, 20_000);
    return tabs as TabInfo[];
  }

  /** chrome:// pages cannot be attached, so they are never handed out as the target. */
  private static usable(tab: TabInfo): boolean {
    return /^(https?|about|file):/i.test(tab.url ?? '') || (tab.url ?? '') === '';
  }

  async pages(): Promise<RuntimePage[]> {
    const tabs = (await this.tabs()).filter((tab) => ExtensionSession.usable(tab));
    return tabs.map((tab) => new ExtensionPage(this.client, tab.tabId, (listener) => this.listeners.push(listener)));
  }

  async activePage(): Promise<RuntimePage> {
    if (this.active && !this.active.isClosed()) return this.active;
    const tabs = await this.tabs();
    const usable = tabs.filter((tab) => ExtensionSession.usable(tab));
    const target = usable.find((tab) => tab.active) ?? usable[0];
    // No usable tab at all: open one rather than attaching to a page the debugger
    // is not allowed to touch.
    if (!target) return this.newPage();
    this.active = new ExtensionPage(this.client, target.tabId, (listener) => this.listeners.push(listener));
    return this.active;
  }

  async newPage(): Promise<RuntimePage> {
    const created = (await this.client.request({ method: 'create', params: {} }, 15_000)) as { tabId: number };
    this.owned.set(created.tabId, null);
    const page = new ExtensionPage(
      this.client,
      created.tabId,
      (listener) => this.listeners.push(listener),
      (tabId, retention) => this.owned.set(tabId, retention),
    );
    this.active = page;
    return page;
  }

  /** Tabs this session created and their retention, for diagnostics. */
  ownedTabs(): Array<{ tabId: number; retention: Retention }> {
    return [...this.owned.entries()].map(([tabId, retention]) => ({ tabId, retention }));
  }

  /**
   * Cleanup closes only scratch tabs the agent created. Tabs the user already
   * had — and any tab marked deliverable or handoff — are left alone.
   */
  async close(): Promise<void> {
    for (const [tabId, retention] of this.owned) {
      if (retention !== null) continue;
      await this.client.request({ method: 'close', params: { tabId } }, 5000).catch(() => undefined);
    }
    this.owned.clear();
    this.client.close();
  }
}


