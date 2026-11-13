/**
 * Settle: decide when an action has actually taken effect.
 *
 * The contract this implements is behavioral, not copied:
 *   - an action counts as settled when the document is parsed, no request it
 *     started is still in flight, and the DOM has been quiet for QUIET_MS;
 *   - a wrong locator fails fast once the page is quiet, instead of burning the
 *     full timeout;
 *   - the action reports an effect so callers do not have to re-observe to find
 *     out whether anything happened.
 */

import type { ActivityInfo, ActivitySource, NetworkInfo } from './activity.js';

export interface SettleTuning {
  /** DOM + network must be quiet this long before an action counts as settled. */
  quietMs: number;
  /** A page quiet this long means a missing target is really missing. */
  notFoundQuietMs: number;
  /** Never answer "not found" faster than this, so freshly rendered pages get a chance. */
  notFoundMinWaitMs: number;
  /** Extra room while the document is still parsing. */
  loadingCapMs: number;
  /**
   * A request can stay in flight forever (long poll, analytics beacon). Once the
   * DOM has been quiet this long with a request still open, stop waiting on it.
   */
  pendingGraceMs: number;
}

export const DEFAULT_TUNING: SettleTuning = {
  quietMs: 120,
  notFoundQuietMs: 700,
  notFoundMinWaitMs: 300,
  loadingCapMs: 4000,
  pendingGraceMs: 1200,
};

/** Default window for waiting on a page to settle after an action. */
export const DEFAULT_SETTLE_MS = 1000;

/** How long a navigation has to prove it started before we stop watching for one. */
export const NAV_CLASSIFY_MS = 300;

export type ActionEffect = 'navigated' | 'changed' | 'none' | 'unknown';

export interface ActivitySnapshot {
  target: ActivityInfo | null;
  network: NetworkInfo;
  /** True when a probe threw or a transport declared itself unable to measure. */
  probeFailed?: boolean;
  /** The first probe error, kept verbatim so a diagnosis does not have to guess. */
  probeError?: string;
}

/** What settle() learned. `probeFailed` means the readings are not evidence. */
export interface SettleResult {
  quiet: boolean;
  pendingRequests: number;
  probeFailed?: boolean;
  probeError?: string;
}

/** A network reading that nobody took is not a quiet network. */
function isUnavailable(network: NetworkInfo): boolean {
  return network.unavailable === true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The optimistic zero that used to stand in for a failed measurement. */
const UNMEASURED: NetworkInfo = { pending: 0, idleMs: 0, unavailable: true };

export async function snapshot(source: ActivitySource, since: number, scan = false): Promise<ActivitySnapshot> {
  let probeError: string | undefined;
  const [target, network] = await Promise.all([
    source.activity({ scan }).catch((error: unknown) => {
      probeError = probeError ?? messageOf(error);
      return null;
    }),
    source.network(since).catch((error: unknown) => {
      probeError = probeError ?? messageOf(error);
      return UNMEASURED;
    }),
  ]);
  const failed = probeError !== undefined || isUnavailable(network);
  return {
    target,
    network,
    ...(failed ? { probeFailed: true } : {}),
    ...(probeError !== undefined
      ? { probeError }
      : network.error !== undefined
        ? { probeError: network.error }
        : {}),
  };
}

/**
 * Wait until the page has finished reacting.
 *
 * `since` is the timestamp the action started, so requests it triggered can be
 * told apart from background chatter that predates it.
 */
export async function settle(
  source: ActivitySource,
  since: number,
  capMs: number,
  tuning: SettleTuning = DEFAULT_TUNING,
): Promise<SettleResult> {
  const started = Date.now();
  let limit = capMs;
  let pendingRequests = 0;
  let pendingSince: number | undefined;
  let probeError: string | undefined;

  while (Date.now() - started < limit) {
    const [page, net] = await Promise.all([
      source.activity().catch((error: unknown) => {
        probeError = probeError ?? messageOf(error);
        return null;
      }),
      source.network(since).catch((error: unknown) => {
        probeError = probeError ?? messageOf(error);
        return UNMEASURED;
      }),
    ]);
    // A probe that threw, or a transport that says it cannot measure, is not a
    // quiet page. Answer immediately with the reason: the caller has to know
    // the readings are missing, and waiting out the cap would only delay that.
    if (probeError !== undefined || isUnavailable(net)) {
      return {
        quiet: false,
        pendingRequests,
        probeFailed: true,
        probeError: probeError ?? net.error ?? 'network activity could not be measured',
      };
    }
    pendingRequests = net.pending;
    if (pendingRequests > 0) pendingSince ??= Date.now();
    else pendingSince = undefined;
    // A document still parsing needs more room than an in-page update.
    if (page?.ready === 'loading') limit = Math.max(capMs, tuning.loadingCapMs);
    const idle = page ? Math.min(page.idleMs, Date.now() - since) : 0;
    const domQuiet = Boolean(page) && page!.ready !== 'loading' && idle >= tuning.quietMs;
    const netQuiet = net.pending === 0 && net.idleMs >= tuning.quietMs;
    // Long polls never finish: once the DOM has settled and the request has been
    // open past the grace window, it is not something the action is waiting for.
    const stalePending = pendingSince !== undefined && Date.now() - pendingSince >= tuning.pendingGraceMs;
    if (domQuiet && (netQuiet || stalePending)) {
      return { quiet: true, pendingRequests };
    }
    const wait = page && page.ready !== 'loading' ? Math.min(100, Math.max(20, tuning.quietMs - Math.min(idle, net.idleMs))) : 40;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return { quiet: false, pendingRequests };
}

/**
 * What did the action do?
 *
 * Comparing a snapshot taken just before input with one taken after the settle
 * is the only reliable way to tell "clicked and navigated" from "clicked and
 * nothing happened" on modern pages.
 */
export function effectOf(
  before: ActivitySnapshot,
  after: ActivitySnapshot,
  navigated: boolean,
): { effect: ActionEffect; url?: string } {
  if (navigated) return { effect: 'navigated' };
  const pairs: Array<[ActivityInfo | null, ActivityInfo | null]> = [
    [before.target, after.target],
  ];
  for (const [b, a] of pairs) {
    if (b && a && a.docId !== b.docId) return { effect: 'navigated', url: a.url };
    if (b && a && a.url !== b.url) return { effect: 'navigated', url: a.url };
  }
  if (!after.target || !before.target) return { effect: 'unknown' };
  if (after.target.mutations !== before.target.mutations) return { effect: 'changed' };
  return { effect: 'none' };
}

/**
 * Wait for a target that has not appeared yet.
 *
 * Returns as soon as the predicate matches. Fails fast when the page has gone
 * quiet for `notFoundQuietMs`, so a typo answers in ~0.5 s rather than at the
 * timeout.
 */
export async function waitForTarget<T>(
  source: ActivitySource,
  probe: () => Promise<T | null>,
  options: { timeoutMs: number; since: number; tuning?: SettleTuning },
): Promise<T> {
  const tuning = options.tuning ?? DEFAULT_TUNING;
  const started = Date.now();
  let firstQuietAt: number | undefined;

  while (Date.now() - started < options.timeoutMs) {
    const found = await probe().catch(() => null);
    if (found) return found;

    const page = await source.activity().catch(() => null);
    const quiet = page && page.ready !== 'loading' && page.idleMs >= tuning.notFoundQuietMs;
    if (quiet) {
      firstQuietAt ??= Date.now();
      if (Date.now() - firstQuietAt >= tuning.notFoundMinWaitMs) break;
    } else {
      firstQuietAt = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, firstQuietAt ? 50 : 120));
  }
  throw new TargetNotFound(options.timeoutMs, Date.now() - started, firstQuietAt !== undefined);
}

export class TargetNotFound extends Error {
  readonly fastFail: boolean;
  readonly elapsedMs: number;
  constructor(timeoutMs: number, elapsedMs: number, fastFail: boolean) {
    super(
      fastFail
        ? `Target not found; page was quiet, giving up after ${elapsedMs}ms (timeout ${timeoutMs}ms)`
        : `Target not found within ${timeoutMs}ms`,
    );
    this.name = 'TargetNotFound';
    this.fastFail = fastFail;
    this.elapsedMs = elapsedMs;
  }
}


