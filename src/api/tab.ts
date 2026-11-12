/**
 * The browser API surface an agent sees.
 *
 * Five operations, deliberately small: navigate, observe, act, read, screenshot.
 * Everything else an agent might want is expressible with these plus a REPL.
 *
 * Behavior that matters for how this feels:
 *   - act() always reports what actually happened (navigated / changed / none);
 *   - a missing target answers fast once the page is quiet;
 *   - refs carry a revision so a stale one is refused instead of mis-clicked.
 *
 * Transport-agnostic: works over Playwright over CDP, or over the Chrome
 * extension, because it only needs RuntimePage.
 */

import { ActionError } from '../core/errors.js';
import {
  installActivity,
  makeSource,
  readActivityInPage,
  type ActivitySource,
} from '../core/activity.js';
import {
  DEFAULT_SETTLE_MS,
  DEFAULT_TUNING,
  NAV_CLASSIFY_MS,
  effectOf,
  settle,
  snapshot,
  waitForTarget,
  TargetNotFound,
  type ActionEffect,
  type SettleTuning,
} from '../core/settle.js';
import { REF_ATTRIBUTE, RefRegistry, type SnapshotState } from '../core/refs.js';
import { captureSnapshot, renderSnapshot, type SnapshotNode } from '../core/snapshot.js';
import type { RuntimePage, ScreenshotOptions } from '../transport/page.js';

export type ActKind = 'click' | 'fill' | 'press' | 'select' | 'hover' | 'scroll';

export interface GotoOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'none';
  timeoutMs?: number;
  settleMs?: number;
}

export interface ObserveOptions {
  maxNodes?: number;
  maxChars?: number;
  includeStructure?: boolean;
}

export interface ActOptions {
  ref: string;
  action: ActKind;
  value?: string;
  /** Revision returned by observe(); a mismatch means the page moved on. */
  revision?: number;
  timeoutMs?: number;
  settleMs?: number;
}

export interface ReadOptions {
  target?: string | 'page';
  format?: 'text' | 'html';
  maxChars?: number;
}

export interface GotoResult {
  ok: true;
  /** What the caller asked for. */
  requestedUrl: string;
  /** Where the browser actually ended up; a redirect or a login wall changes it. */
  url: string;
  /** True when url !== requestedUrl: a 200 does not mean "you are where you asked". */
  landedElsewhere: boolean;
  title: string;
  status: number | null;
  /** Present only when the page loaded but has no usable content. */
  content?: 'empty' | 'placeholder';
}

export interface ObserveResult {
  ok: true;
  url: string;
  title: string;
  revision: number;
  nodes: SnapshotNode[];
  total: number;
  truncated: boolean;
  text: string;
}

export interface ActResult {
  ok: true;
  effect: ActionEffect;
  url?: string;
  revision: number;
  settled: boolean;
  pendingRequests?: number;
}

export interface ReadResult {
  ok: true;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  target: string;
}

export interface ScreenshotResult {
  ok: true;
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
  bytes: number;
}

export interface TabOptions {
  tuning?: SettleTuning;
}

export class Tab {
  private refs = new RefRegistry();
  private source: ActivitySource | null = null;
  private readonly tuning: SettleTuning;

  constructor(
    readonly page: RuntimePage,
    options: TabOptions = {},
  ) {
    this.tuning = options.tuning ?? DEFAULT_TUNING;
  }

  private async ensureReady(): Promise<ActivitySource> {
    if (this.page.isClosed()) {
      throw new ActionError('E_NO_TAB', 'The tab is closed', { hint: 'Open a new tab and retry.' });
    }
    const info = await readActivityInPage(this.page, false);
    if (!info) await installActivity(this.page);
    this.source = makeSource(this.page, (since) => this.page.networkInfo(since), () => installActivity(this.page));
    return this.source;
  }

  /** Navigation: bounded wait, then settle so the caller sees a ready page. */
  async goto(url: string, options: GotoOptions = {}): Promise<GotoResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const waitUntil = options.waitUntil ?? 'load';
    if (!/^https?:\/\/|^about:|^data:/i.test(url)) {
      throw new ActionError('E_BAD_URL', `Refusing to navigate to "${url}"`, {
        hint: 'Use an absolute http(s) URL.',
      });
    }
    const source = await this.ensureReady();
    const started = Date.now();
    let status: number | null = null;
    try {
      const result = await this.page.goto(url, {
        timeoutMs,
        waitUntil: waitUntil === 'none' ? 'commit' : waitUntil,
      });
      status = result.status;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Timeout/i.test(message)) {
        throw new ActionError('E_NAV_TIMEOUT', `Navigation to ${url} timed out after ${timeoutMs}ms`, {
          hint: 'The page may be slow or blocking; retry with a larger timeoutMs.',
          cause: err,
        });
      }
      throw new ActionError('E_ACTION_FAILED', message, { cause: err });
    }
    await installActivity(this.page);
    await settle(source, started, options.settleMs ?? 1200, this.tuning);
    this.refs = new RefRegistry();
    // A page can load cleanly and still be empty: a blocked request or a redirect
    // leaves a title and nothing else. Say that instead of reporting success.
    // The check retries once because it can land between commit and first paint.
    let content: 'ready' | 'empty' | 'placeholder' | 'unknown' =
      waitUntil === 'none' ? 'unknown' : await this.page.contentState().catch(() => 'unknown' as const);
    if (content === 'empty') {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const retry = await this.page.contentState().catch(() => 'unknown' as const);
      if (retry !== 'empty') content = retry;
    }
    const finalUrl = await this.page.url().catch(() => url);
    const landedElsewhere = finalUrl !== url;
    return {
      ok: true,
      requestedUrl: url,
      url: finalUrl,
      landedElsewhere,
      title: await this.page.title().catch(() => ''),
      status,
      ...(content === 'empty' || content === 'placeholder' ? { content } : {}),
    };
  }

  /** Snapshot: refs + compact text, bounded. */
  async observe(options: ObserveOptions = {}): Promise<ObserveResult> {
    const source = await this.ensureReady();
    const info = await source.activity();
    const docId = info?.docId ?? 'unknown';
    const state: SnapshotState = this.refs.startSnapshot(docId, info?.url ?? (await this.page.url().catch(() => '')));
    const snapshotResult = await captureSnapshot(this.page, docId, {
      generation: state.generation,
      maxNodes: options.maxNodes ?? 400,
      includeStructure: options.includeStructure ?? true,
    });
    const maxChars = options.maxChars ?? 8000;
    const text = clip(renderSnapshot(snapshotResult, maxChars), maxChars);
    return {
      ok: true,
      url: snapshotResult.url,
      title: snapshotResult.title,
      revision: state.revision,
      nodes: snapshotResult.nodes,
      total: snapshotResult.total,
      truncated: snapshotResult.truncated || text.includes('…(truncated'),
      text,
    };
  }

  /** Act on a ref, then settle and report the effect. */
  async act(options: ActOptions): Promise<ActResult> {
    const source = await this.ensureReady();
    const docId = (await source.activity())?.docId ?? null;
    const check = this.refs.assertCurrent(options.ref, docId);
    if (!check.ok) {
      throw new ActionError(
        check.reason === 'invalid' ? 'E_REF_INVALID' : 'E_REF_STALE',
        `Ref ${options.ref} is ${check.reason}`,
        {
          hint: 'Call observe() again and use the new ref.',
          data: { revision: this.refs.current?.revision ?? null },
        },
      );
    }
    if (options.revision !== undefined && this.refs.current && options.revision !== this.refs.current.revision) {
      throw new ActionError('E_REF_STALE', `Revision ${options.revision} is stale (current ${this.refs.current.revision})`, {
        hint: 'Call observe() again; the page changed since that snapshot.',
      });
    }

    const selector = `[${REF_ATTRIBUTE}="${options.ref}"]`;
    const started = Date.now();
    const before = await snapshot(source, started, true);
    const timeoutMs = options.timeoutMs ?? 10_000;

    try {
      // Fast-fail path: if the element is not there and the page has gone quiet,
      // say so in ~0.5s instead of burning the full timeout.
      await waitForTarget(source, () => this.selectorVisible(selector), {
        timeoutMs: Math.min(timeoutMs, 5000),
        since: started,
        tuning: this.tuning,
      });
    } catch {
      throw new ActionError('E_TARGET_NOT_FOUND', `Ref ${options.ref} is not visible`, {
        hint: 'The element may be hidden or removed; call observe() again.',
      });
    }

    const navPromise = this.page.waitForNavigation(Math.min(timeoutMs, 2000));
    let navigated = false;
    try {
      await this.perform(options, selector, timeoutMs);
    } catch (err) {
      navPromise.catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      if (/not visible|not enabled|outside of the viewport|intercepts pointer events|element is not/i.test(message)) {
        throw new ActionError('E_NOT_INTERACTABLE', message, {
          hint: 'Scroll it into view, close overlays, or pick another ref.',
          cause: err,
        });
      }
      if (/Timeout/i.test(message)) {
        throw new ActionError('E_ACTION_TIMEOUT', message, { cause: err });
      }
      throw new ActionError('E_ACTION_FAILED', message, { cause: err });
    }

    // Watch for navigation and wait for settle concurrently, the way a responsive
    // tool must: navigation gets 300 ms to prove it started, the settle has its own
    // window, and the caller pays the larger of the two instead of their sum.
    const [navHit, settleResult] = await Promise.all([
      Promise.race([
        navPromise,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), NAV_CLASSIFY_MS)),
      ]),
      settle(source, started, options.settleMs ?? DEFAULT_SETTLE_MS, this.tuning),
    ]);
    navigated =
      navHit ||
      (await Promise.race([navPromise, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))]));

    const after = await snapshot(source, started, false);
    const effect = effectOf(before, after, navigated);

    return {
      ok: true,
      effect: effect.effect,
      ...(effect.url !== undefined ? { url: effect.url } : {}),
      revision: this.refs.current?.revision ?? 0,
      settled: settleResult.quiet,
      ...(settleResult.quiet ? {} : { pendingRequests: settleResult.pendingRequests }),
    };
  }

  /** True when the selector matches a visible element right now. */
  private async selectorVisible(selector: string): Promise<boolean> {
    return this.page.evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width >= 1 && r.height >= 1 && s.visibility !== 'hidden' && s.display !== 'none';
    })()`).catch(() => false);
  }

  private async perform(options: ActOptions, selector: string, timeoutMs: number): Promise<void> {
    switch (options.action) {
      case 'click':
        await this.page.click(selector, timeoutMs);
        return;
      case 'fill':
        if (options.value === undefined) throw new ActionError('E_BAD_ARGUMENT', 'fill requires a value');
        await this.page.fill(selector, options.value, timeoutMs);
        return;
      case 'press':
        await this.page.press(selector, options.value ?? 'Enter', timeoutMs);
        return;
      case 'select':
        if (options.value === undefined) throw new ActionError('E_BAD_ARGUMENT', 'select requires a value');
        await this.page.selectOption(selector, options.value, timeoutMs);
        return;
      case 'hover':
        await this.page.hover(selector, timeoutMs);
        return;
      case 'scroll':
        await this.page.scrollIntoView(selector, timeoutMs);
        return;
      default:
        throw new ActionError('E_BAD_ARGUMENT', `Unknown action "${(options as { action: string }).action}"`);
    }
  }

  /** Read page text, or one element's text, bounded. */
  async read(options: ReadOptions = {}): Promise<ReadResult> {
    await this.ensureReady();
    const maxChars = options.maxChars ?? 12_000;
    const target = options.target ?? 'page';
    const format = options.format ?? 'text';

    let raw: string;
    if (target === 'page') {
      const text = await this.page.evaluate<string>(`(() => {
        const root = document.body || document.documentElement;
        return root ? (root.innerText || '') : '';
      })()`);
      raw = format === 'html' ? await this.page.evaluate<string>('document.documentElement.outerHTML') : text;
    } else {
      const docId = (await readActivityInPage(this.page, false))?.docId ?? null;
      const check = this.refs.assertCurrent(target, docId);
      if (!check.ok) {
        throw new ActionError(
          check.reason === 'invalid' ? 'E_REF_INVALID' : 'E_REF_STALE',
          `Ref ${target} is ${check.reason}`,
          { hint: 'Call observe() again and read the new ref.' },
        );
      }
      const selector = `[${REF_ATTRIBUTE}="${target}"]`;
      try {
        await this.page.waitForSelector(selector, 3000, 'attached');
      } catch {
        throw new ActionError('E_TARGET_NOT_FOUND', `Ref ${target} is not present`, {
          hint: 'Call observe() again; the element was removed.',
        });
      }
      raw = await this.page.evaluate<string>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return '';
        return ${format === 'html' ? 'el.outerHTML' : "(el.innerText || el.textContent || '')"};
      })()`);
    }

    const normalised = format === 'html' ? raw : raw.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
    const text = clip(normalised, maxChars);
    return {
      ok: true,
      url: await this.page.url().catch(() => ''),
      title: await this.page.title().catch(() => ''),
      text,
      truncated: text.length < normalised.length,
      target,
    };
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    await this.ensureReady();
    const format = options.format ?? 'png';
    const buffer = await this.page.screenshot({ ...options, format });
    return {
      ok: true,
      base64: buffer.toString('base64'),
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      bytes: buffer.byteLength,
    };
  }
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(truncated ${text.length - maxChars} chars)`;
}

export { TargetNotFound };


