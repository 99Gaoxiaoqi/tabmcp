import { ActionError } from './errors.js';
/**
 * Network journal: the page's own JSON traffic, kept for cursor reads.
 *
 * An adapter often wants the data behind the page rather than the text on it.
 * Recording responses as they arrive means `networkRead()` can hand back entries
 * in order, with a cursor, instead of re-fetching and guessing.
 *
 * Bodies are capped and only JSON-ish responses are kept: a journal that holds
 * every image would grow without bound and answer the wrong question.
 */

export interface JournalEntry {
  /** Monotonic sequence; also the cursor for paging. */
  sequence: number;
  method: string;
  url: string;
  status?: number;
  mimeType?: string;
  /** Parsed JSON when possible, otherwise a truncated string. */
  body?: unknown;
  /** Set when the body was too large or not parseable. */
  note?: string;
  at: number;
}

export interface NetworkReadResult {
  cursor: number;
  entries: JournalEntry[];
  hasMore: boolean;
}

export interface NetworkReadOptions {
  /** Substring or /regex/ matched against the URL. */
  pattern?: string;
  /** Max entries returned (default 20). */
  limit?: number;
  /** Only entries after this sequence. */
  afterSequence?: number;
  /** Include static assets (default false). */
  includeStatic?: boolean;
}

// A single large JSON response (a search API, a feed) must still be readable: dropping
// it because it exceeded a small per-entry cap made `network_read` silently report
// nothing for exactly the requests worth reading. Size is bounded in aggregate
// instead, by evicting the oldest entries.
const MAX_BODY_CHARS = 4_000_000;
const MAX_TOTAL_CHARS = 24_000_000;
const MAX_ENTRIES = 500;

function matchesPattern(url: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/');
    const source = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1);
    try {
      return new RegExp(source, flags).test(url);
    } catch (cause) {
      // Falling back to a substring search turned a typo into a different filter, and
      // the caller got results that looked like a match. Say the pattern is broken.
      throw new ActionError('E_BAD_ARGUMENT', `invalid regex pattern ${pattern}`, {
        hint: 'Pass either plain text or /regex/flags with valid syntax.',
        data: { pattern, reason: cause instanceof Error ? cause.message : String(cause) },
        cause,
      });
    }
  }
  return url.includes(pattern);
}

function JournalEntry_chars(entry: JournalEntry): number {
  const body = entry.body;
  return typeof body === 'string' ? body.length : body === undefined ? 0 : JSON.stringify(body).length;
}

export class NetworkJournal {
  private readonly entries: JournalEntry[] = [];
  private sequence = 0;
  private readonly pending = new Map<string, { method: string; url: string; at: number }>();
  /** Running total of body characters, so eviction does not re-serialise everything. */
  private chars = 0;
  /** A request whose response was never recorded (non-JSON, failed, or dropped). */
  private static readonly PENDING_TTL_MS = 120_000;

  constructor(private readonly capacity = MAX_ENTRIES) {}

  /** Records the start of a request so the response can be attributed. */
  requestStarted(requestId: string, method: string, url: string): void {
    this.pending.set(requestId, { method: method.toUpperCase(), url, at: Date.now() });
  }

  requestFinished(requestId: string): void {
    this.pending.delete(requestId);
  }

  /**
   * Stores a response body. Called after the transport fetched it, because only
   * the transport knows how to read a body for its protocol.
   */
  record(requestId: string, status: number | undefined, mimeType: string | undefined, bodyText: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (bodyText.length > MAX_BODY_CHARS) {
      this.push({ ...pending, status, mimeType, note: `body truncated at ${MAX_BODY_CHARS} chars` });
      return;
    }
    let body: unknown = bodyText;
    if (/json/i.test(mimeType ?? '')) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
    this.push({ ...pending, status, mimeType, body });
  }

  private push(entry: Omit<JournalEntry, 'sequence'>): void {
    this.prunePending();
    const stored: JournalEntry = { ...entry, sequence: ++this.sequence };
    this.entries.push(stored);
    this.chars += JournalEntry_chars(stored);
    if (this.entries.length > this.capacity) {
      for (const dropped of this.entries.splice(0, this.entries.length - this.capacity)) {
        this.chars -= JournalEntry_chars(dropped);
      }
    }
    while (this.entries.length > 1 && this.chars > MAX_TOTAL_CHARS) {
      const dropped = this.entries.shift();
      if (dropped) this.chars -= JournalEntry_chars(dropped);
    }
    if (this.chars < 0) this.chars = 0;
  }

  /**
   * Responses that are not JSON never reach record(), so their requestId would sit in
   * pending forever. Prune by age instead of dropping the entries on sight: a slow JSON
   * body still needs its attribution.
   */
  private prunePending(): void {
    if (this.pending.size === 0) return;
    const cutoff = Date.now() - NetworkJournal.PENDING_TTL_MS;
    for (const [requestId, started] of this.pending) {
      if (started.at < cutoff) this.pending.delete(requestId);
    }
  }

  /** Number of requests started but never attributed; visible for tests and doctor. */
  get pendingCount(): number {
    this.prunePending();
    return this.pending.size;
  }

  /** Rough size of what the entries hold, measured as they arrive. */
  private bodyChars(): number {
    return this.chars;
  }

  read(options: NetworkReadOptions = {}): NetworkReadResult {
    const limit = options.limit ?? 20;
    const after = options.afterSequence ?? 0;
    const filtered = this.entries.filter((entry) => {
      if (entry.sequence <= after) return false;
      if (!options.includeStatic && /^(image|font|stylesheet|media)/i.test(entry.mimeType ?? '')) return false;
      return matchesPattern(entry.url, options.pattern);
    });
    const page = filtered.slice(0, limit);
    const cursor = page.length ? page[page.length - 1]!.sequence : after;
    return { cursor, entries: page, hasMore: filtered.length > page.length };
  }

  get size(): number {
    return this.entries.length;
  }
}

/** Content judgement after navigation: a title and URL can be fine while the page is empty. */
export type ContentState = 'ready' | 'empty' | 'placeholder' | 'unknown';

/**
 * Inspects the page in-page and decides whether it actually has content.
 *
 * "Empty" matters because a redirect or a blocked request can leave a page that
 * looks loaded but has nothing on it — reporting that is far more useful than a
 * successful navigation with silent emptiness.
 */
export const CONTENT_STATE_SCRIPT = `(() => {
  const text = (document.body ? (document.body.innerText || '') : '').replace(/\\s+/g, ' ').trim();
  const nodes = document.body ? document.body.querySelectorAll('*').length : 0;
  if (text.length === 0) {
    // Text is empty: nothing rendered is empty, an empty element tree is a skeleton.
    return nodes === 0 ? 'empty' : 'placeholder';
  }
  const LOADING = /(^|\\s)(loading|\u6b63\u5728\u52a0\u8f7d|\u52a0\u8f7d\u4e2d)(\\s|$)/i;
  if (text.length < 80 && LOADING.test(text)) return 'placeholder';
  // Text exists, so the page is not empty regardless of how many elements it uses.
  return 'ready';
})()`;
