/**
 * RuntimePage: the small surface the API layer needs from a browser.
 *
 * Deliberately narrower than Playwright's Page. Two implementations exist:
 *   - PlaywrightPage: attach over CDP (`--connect`)
 *   - ExtensionPage: drive Chrome through the MV3 extension over native messaging
 *
 * Keeping this interface small is what lets the extension transport exist
 * without reimplementing Playwright.
 */

import type { NetworkInfo } from '../core/activity.js';

export interface NavigationResult {
  url: string;
  status: number | null;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  format?: 'png' | 'jpeg';
  quality?: number;
  /** Draw numbered boxes over interactive elements so a vision model can point at them. */
  annotate?: boolean;
}

export interface EvaluateOptions {
  /** Treat the value as untrusted; callers must not rely on element handles. */
  timeoutMs?: number;
}

export interface FindTarget {
  role?: string;
  name?: string;
  text?: string;
  css?: string;
  limit?: number;
}

export interface FindHit {
  ref: string;
  role: string;
  name: string;
  value?: string;
}

export interface Expectation {
  /** Selector that must exist (and be visible unless `state: 'attached'`). */
  selector?: string;
  /** Page text that must contain this substring. */
  text?: string;
  /** URL that must contain this substring. */
  url?: string;
}

export interface ExpectResult {
  ok: boolean;
  waitedMs: number;
  /** Which expectation failed, when ok is false. */
  detail?: string;
}

export interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Absolute URL to fetch; relative paths resolve against the page origin. */
  timeoutMs?: number;
}

export interface FrameInfo {
  index: number;
  frameId: string;
  url: string;
  name: string;
  /** True when the frame is a different origin and therefore not scriptable. */
  crossOrigin?: boolean;
}

/**
 * What happens to a tab when the session ends.
 *   - 'deliverable': keep it, the result is meant to be looked at
 *   - 'handoff': keep it, a person will continue
 *   - null: agent-owned scratch, close it
 */
export type Retention = 'deliverable' | 'handoff' | null;

export interface RuntimePage {
  /** Stable identity for logs and errors. */
  readonly id: string;
  url(): Promise<string>;
  title(): Promise<string>;
  goto(url: string, options: { timeoutMs: number; waitUntil: 'load' | 'domcontentloaded' | 'commit' }): Promise<NavigationResult>;
  /** Evaluate a self-contained expression/IIFE string in the page, by value. */
  evaluate<T = unknown>(script: string, options?: EvaluateOptions): Promise<T>;
  click(selector: string, timeoutMs: number): Promise<void>;
  fill(selector: string, value: string, timeoutMs: number): Promise<void>;
  press(selector: string, key: string, timeoutMs: number): Promise<void>;
  selectOption(selector: string, value: string, timeoutMs: number): Promise<void>;
  hover(selector: string, timeoutMs: number): Promise<void>;
  scrollIntoView(selector: string, timeoutMs: number): Promise<void>;
  /** Resolves when the selector matches a visible element; throws on timeout. */
  waitForSelector(selector: string, timeoutMs: number, state?: 'visible' | 'attached'): Promise<void>;
  /** Resolves true if a navigation committed before the timeout. */
  waitForNavigation(timeoutMs: number): Promise<boolean>;
  screenshot(options: ScreenshotOptions): Promise<Buffer>;
  /** Read one cookie visible to the page; adapters need it for CSRF tokens. */
  cookie(name: string, options?: { domain?: string }): Promise<string | undefined>;
  /**
   * Fetch JSON from the page context so the request carries the user's session.
   * Relative URLs resolve against the current origin, which is what site APIs need.
   */
  fetchJson<T = unknown>(url: string, options?: FetchJsonOptions): Promise<T>;
  /** Locate elements by accessible role/name/text and return refs. */
  find(target: FindTarget): Promise<FindHit[]>;
  /** Wait until an expectation holds, then report whether it did. */
  expect(what: Expectation, options?: { timeoutMs?: number }): Promise<ExpectResult>;
  /** In-flight request accounting for settle. */
  networkInfo(since: number): Promise<NetworkInfo>;
  /** Frames of the current page, outermost first. */
  frames(): Promise<FrameInfo[]>;
  reload(): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  /** All cookies visible to the page for a domain. */
  cookies(domain: string): Promise<Array<{ name: string; value: string; domain: string; path?: string }>>;
  /** Click something that downloads, and wait for the file to arrive. */
  download(options: { selector: string; timeoutMs?: number }): Promise<{ filename?: string; bytes?: number; path?: string }>;
  /** Whether the page actually has content, not just a title. */
  contentState(): Promise<'ready' | 'empty' | 'placeholder' | 'unknown'>;
  /** Read the page's own JSON traffic recorded so far. */
  networkRead(options?: {
    pattern?: string;
    limit?: number;
    afterSequence?: number;
    includeStatic?: boolean;
  }): Promise<{ cursor: number; entries: Array<Record<string, unknown>>; hasMore: boolean }>;
  /**
   * Evaluate inside a specific frame.
   * `index` works on both transports; `frameId` comes from frames().
   */
  evaluateInFrame(target: { index?: number; frameId?: string }, script: string): Promise<unknown>;
  /** Keep this tab after the session ends (result is meant to be looked at). */
  markDeliverable(): Promise<void>;
  /** Keep this tab after the session ends and hand it to a person. */
  markHandoff(): Promise<void>;
  /** Forget any retention request; the tab becomes scratch again. */
  clearRetention(): Promise<void>;
  /** Current retention request. */
  readonly retention?: Retention;
  isClosed(): boolean;
  close(): Promise<void>;
}

