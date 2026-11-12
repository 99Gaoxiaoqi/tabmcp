/**
 * Page activity: what the document is doing right now.
 *
 * The settle algorithm needs three facts it cannot get from a fixed sleep:
 *   - is the document still parsing?
 *   - how long since the last real DOM change?
 *   - are requests still in flight (started since we acted)?
 *
 * The DOM side is observed in-page; the network side comes from the transport
 * (CDP events on either the Playwright or the extension path).
 */

export type ReadyState = 'loading' | 'interactive' | 'complete';

export interface ActivityInfo {
  /** Document identity; changes on navigation. */
  docId: string;
  url: string;
  ready: ReadyState;
  /** Monotonic count of observed DOM mutations. */
  mutations: number;
  /** Milliseconds since the last observed mutation. */
  idleMs: number;
}

export interface NetworkInfo {
  /** Requests in flight that started at or after `since`. */
  pending: number;
  /** Milliseconds since the last network event. */
  idleMs: number;
}

/** Anything that can evaluate a self-contained script in the page. */
export interface ScriptProbe {
  evaluate<T = unknown>(script: string): Promise<T>;
}

/** Sources are swappable so the settle logic can be tested without a browser. */
export interface ActivitySource {
  activity(options?: { scan?: boolean }): Promise<ActivityInfo | null>;
  network(since: number): Promise<NetworkInfo>;
}

/**
 * Injected once per document. Records mutation counts plus a document id so a
 * navigation is detectable by comparing snapshots.
 */
const OBSERVER_SCRIPT = `(() => {
  const KEY = '__bmcp_activity__';
  const existing = window[KEY];
  if (existing) return true;

  const state = {
    docId: (crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
    mutations: 0,
    lastAt: Date.now(),
    watched: new WeakSet(),
    shadowScan: false
  };
  window[KEY] = state;

  const bump = () => { state.mutations++; state.lastAt = Date.now(); };

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList' || r.type === 'characterData' || r.type === 'attributes') { bump(); return; }
    }
  });

  const watchRoot = (root) => {
    if (!root || state.watched.has(root)) return;
    state.watched.add(root);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    });
  };

  watchRoot(document.documentElement || document);

  const scanShadow = () => {
    if (!state.shadowScan) return;
    const walk = (root) => {
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        if (el.shadowRoot) { watchRoot(el.shadowRoot); walk(el.shadowRoot); }
      }
    };
    walk(document);
  };

  const enableScan = () => {
    if (state.shadowScan) return;
    state.shadowScan = true;
    const proto = Element.prototype;
    const original = proto.attachShadow;
    if (original && !original.__bmcp_patched) {
      const patched = function (init) {
        const root = original.call(this, init);
        try { watchRoot(root); } catch (e) {}
        return root;
      };
      patched.__bmcp_patched = true;
      proto.attachShadow = patched;
    }
    scanShadow();
  };

  window.__bmcp_scan_shadow__ = enableScan;
  return true;
})()`;

export async function installActivity(probe: ScriptProbe): Promise<void> {
  await probe.evaluate(OBSERVER_SCRIPT).catch(() => undefined);
}

export async function readActivityInPage(probe: ScriptProbe, scan: boolean): Promise<ActivityInfo | null> {
  try {
    return await probe.evaluate<ActivityInfo | null>(`(() => {
      const w = window;
      const state = w['__bmcp_activity__'];
      if (!state) return null;
      if (${scan ? 'true' : 'false'} && typeof w['__bmcp_scan_shadow__'] === 'function') w['__bmcp_scan_shadow__']();
      return {
        docId: state.docId,
        url: location.href,
        ready: document.readyState,
        mutations: state.mutations,
        idleMs: Date.now() - state.lastAt
      };
    })()`);
  } catch {
    // Navigation tears the context down; treated as "unknown" by callers.
    return null;
  }
}

export function makeSource(
  probe: ScriptProbe,
  networkInfo: (since: number) => Promise<NetworkInfo>,
  onMissing?: () => Promise<void>,
): ActivitySource {
  return {
    activity: async (options) => {
      const scan = options?.scan ?? false;
      let info = await readActivityInPage(probe, scan);
      // A navigation replaces the document, taking the observer with it. Install
      // it again rather than reporting "unknown" and waiting out the timeout.
      if (!info && onMissing) {
        await onMissing().catch(() => undefined);
        info = await readActivityInPage(probe, scan);
      }
      return info;
    },
    network: async (since) => networkInfo(since),
  };
}

/** Tracks in-flight requests from a stream of CDP network events. */
export class NetworkCounter {
  private readonly inflight = new Map<string, number>();
  private lastEventAt = Date.now();

  started(requestId: string): void {
    this.inflight.set(requestId, Date.now());
    this.lastEventAt = Date.now();
  }

  finished(requestId: string): void {
    this.inflight.delete(requestId);
    this.lastEventAt = Date.now();
  }

  markEvent(): void {
    this.lastEventAt = Date.now();
  }

  info(since: number): NetworkInfo {
    let pending = 0;
    for (const startedAt of this.inflight.values()) if (startedAt >= since) pending++;
    return { pending, idleMs: Date.now() - this.lastEventAt };
  }
}
