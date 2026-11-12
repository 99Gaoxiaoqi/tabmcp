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

const MAX_BODY_CHARS = 64_000;
const MAX_ENTRIES = 500;

function matchesPattern(url: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/');
    try {
      return new RegExp(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1)).test(url);
    } catch {
      return url.includes(pattern);
    }
  }
  return url.includes(pattern);
}

export class NetworkJournal {
  private readonly entries: JournalEntry[] = [];
  private sequence = 0;
  private readonly pending = new Map<string, { method: string; url: string; at: number }>();

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
    this.entries.push({ ...entry, sequence: ++this.sequence });
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
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
  if (text.length === 0) return 'empty';
  const LOADING = /(^|\\s)(loading|请稍候|加载中|正在加载)(\\s|$)/i;
  if (text.length < 80 && LOADING.test(text)) return 'placeholder';
  // A single heading is content. Only truly blank pages count as empty.
  const nodes = document.body ? document.body.querySelectorAll('*').length : 0;
  if (nodes === 0) return 'empty';
  return 'ready';
})()`;
