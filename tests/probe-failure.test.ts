/**
 * Probe-failure contract.
 *
 * The failure mode these tests pin down: a dead instrument used to report the
 * most optimistic reading (zero requests in flight, infinitely quiet), which is
 * indistinguishable from a genuinely settled page. A probe that cannot answer
 * must never turn into "quiet".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { settle, snapshot } from '../src/core/settle.js';
import { installActivity, activityInstallError } from '../src/core/activity.js';
import type { ActivityInfo, ActivitySource, NetworkInfo, ScriptProbe } from '../src/core/activity.js';
import { PlaywrightPage } from '../src/transport/playwright-page.js';
import { CdpSession } from '../src/transport/cdp.js';

function info(partial: Partial<ActivityInfo> = {}): ActivityInfo {
  return {
    docId: 'doc-1',
    url: 'https://example.test/',
    ready: 'complete',
    mutations: 0,
    idleMs: 1000,
    ...partial,
  };
}

/** Activity works; the network probe throws, as a dropped CDP session does. */
function brokenNetworkSource(): ActivitySource {
  return {
    async activity() {
      return info({ idleMs: 5000 });
    },
    async network() {
      throw new Error('E_BROWSER_DISCONNECTED: websocket closed');
    },
  };
}

test('settle never reports quiet when the network probe throws', async () => {
  const started = Date.now();
  const result = await settle(brokenNetworkSource(), started, 500);
  assert.equal(result.quiet, false, 'a probe that cannot answer is not evidence of silence');
  assert.equal(result.probeFailed, true);
  assert.ok(result.probeError, 'the probe error must survive for diagnosis');
});

test('settle reports a probe failure quickly instead of burning the whole cap', async () => {
  const started = Date.now();
  const result = await settle(brokenNetworkSource(), started, 3000);
  const elapsed = Date.now() - started;
  assert.equal(result.probeFailed, true);
  assert.ok(elapsed < 1500, `elapsed ${elapsed}ms should not approach the 3000ms cap`);
});

test('settle treats a transport-declared unavailable network as a probe failure', async () => {
  const source: ActivitySource = {
    async activity() {
      return info({ idleMs: 5000 });
    },
    async network(): Promise<NetworkInfo> {
      return { pending: 0, idleMs: 0, unavailable: true, error: 'newCDPSession failed' };
    },
  };
  const result = await settle(source, Date.now(), 500);
  assert.equal(result.quiet, false);
  assert.equal(result.probeFailed, true);
});

test('settle still settles against a healthy source', async () => {
  const source: ActivitySource = {
    async activity() {
      return info({ idleMs: 5000 });
    },
    async network() {
      return { pending: 0, idleMs: 5000 };
    },
  };
  const result = await settle(source, Date.now(), 1000);
  assert.equal(result.quiet, true);
  assert.equal(result.probeFailed, undefined);
});

test('snapshot marks a failed probe instead of reporting a quiet network', async () => {
  const shot = await snapshot(brokenNetworkSource(), Date.now());
  assert.equal(shot.probeFailed, true);
  assert.ok(shot.probeError);
});

test('installActivity records why it failed instead of swallowing the error', async () => {
  const probe: ScriptProbe = {
    async evaluate<T>(): Promise<T> {
      throw new Error('Execution context was destroyed');
    },
  };
  await installActivity(probe);
  assert.match(activityInstallError(probe) ?? '', /Execution context was destroyed/);
});

test('installActivity clears a previous failure once it succeeds', async () => {
  let fail = true;
  const probe: ScriptProbe = {
    async evaluate<T>(): Promise<T> {
      if (fail) throw new Error('first attempt failed');
      return true as T;
    },
  };
  await installActivity(probe);
  assert.ok(activityInstallError(probe));
  fail = false;
  await installActivity(probe);
  assert.equal(activityInstallError(probe), undefined);
});

// ---------------------------------------------------------------------------
// Transport: the same rule one layer down.
// ---------------------------------------------------------------------------

type AnyFn = (...args: never[]) => unknown;

function fakePage(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, AnyFn[]>();
  const page = {
    url: () => 'https://example.test/',
    title: async () => 'example',
    isClosed: () => false,
    on: (name: string, fn: AnyFn) => {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
    },
    evaluate: async () => null,
    context: () => ({
      newCDPSession: async () => {
        throw new Error('session denied');
      },
      cookies: async () => [],
    }),
    ...overrides,
  };
  return page;
}

test('networkInfo reports unavailable rather than a fabricated quiet reading', async () => {
  const page = new PlaywrightPage(fakePage() as never);
  const network = await page.networkInfo(Date.now());
  assert.equal(network.unavailable, true, 'a failed attach is not zero pending requests');
  assert.ok(network.idleMs < 120, `idleMs ${network.idleMs} must not look like a quiet window`);
  assert.match(network.error ?? '', /session denied/);
});

test('networkInfo retries the attach on the next call instead of caching the failure', async () => {
  let attempts = 0;
  const session = {
    send: async () => undefined,
    on: () => undefined,
    detach: async () => undefined,
  };
  const page = new PlaywrightPage(
    fakePage({
      context: () => ({
        newCDPSession: async () => {
          attempts++;
          if (attempts === 1) throw new Error('transient');
          return session;
        },
        cookies: async () => [],
      }),
    }) as never,
  );
  const first = await page.networkInfo(Date.now());
  assert.equal(first.unavailable, true);
  const second = await page.networkInfo(Date.now());
  assert.equal(second.unavailable, undefined, 'second attempt must be allowed through');
  assert.equal(attempts, 2);
});

test('evaluate honours EvaluateOptions.timeoutMs', async () => {
  const page = new PlaywrightPage(
    fakePage({ evaluate: () => new Promise(() => undefined) }) as never,
  );
  const started = Date.now();
  await assert.rejects(
    () => page.evaluate('1', { timeoutMs: 40 }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'E_ACTION_TIMEOUT');
      return true;
    },
  );
  assert.ok(Date.now() - started < 1000);
});

test('evaluate without a timeout keeps the old passthrough behaviour', async () => {
  const page = new PlaywrightPage(fakePage({ evaluate: async (script: string) => `echo:${script}` }) as never);
  assert.equal(await page.evaluate('2 + 2'), 'echo:2 + 2');
});

// ---------------------------------------------------------------------------
// CDP session bookkeeping.
// ---------------------------------------------------------------------------

function fakeCdpPage(sessions: Array<{ send: () => Promise<void>; on: () => void; detach: () => Promise<void> }>) {
  return {
    isClosed: () => false,
    url: () => 'https://example.test/',
    context: () => ({
      newCDPSession: async () => {
        const session = {
          send: async () => undefined,
          on: () => undefined,
          detach: async () => undefined,
        };
        sessions.push(session);
        return session;
      },
    }),
  };
}

function cdpSessionOf(browser: unknown, context: unknown): CdpSession {
  // CdpSession's constructor is private by design (connect() is the front door),
  // but the bookkeeping under test is exactly what connect() would run.
  return new (CdpSession as unknown as new (b: unknown, c: unknown, p: unknown) => CdpSession)(browser, context, null);
}

test('onNetworkEvent hooks the context page-listener once for many listeners', () => {
  const sessions: Array<{ send: () => Promise<void>; on: () => void; detach: () => Promise<void> }> = [];
  const page = fakeCdpPage(sessions);
  let pageHooks = 0;
  const context = {
    pages: () => [page],
    on: (name: string) => {
      if (name === 'page') pageHooks++;
    },
  };
  const session = cdpSessionOf({ close: async () => undefined }, context);
  session.onNetworkEvent(() => undefined);
  session.onNetworkEvent(() => undefined);
  session.onNetworkEvent(() => undefined);
  assert.equal(pageHooks, 1, 'a context page-hook per listener is a leak that grows with reconnects');
});

test('close detaches the CDP sessions it opened', async () => {
  const sessions: Array<{ send: () => Promise<void>; on: () => void; detach: () => Promise<void> }> = [];
  const page = fakeCdpPage(sessions);
  let detached = 0;
  const context = {
    pages: () => [page],
    on: () => undefined,
  };
  const session = cdpSessionOf({ close: async () => undefined }, context);
  session.onNetworkEvent(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sessions.length, 1);
  sessions[0]!.detach = async () => {
    detached++;
  };
  await session.close();
  assert.equal(detached, 1, 'a CDP session left attached outlives the transport');
});

test('a failed network attach is retried on the next call', async () => {
  let attempts = 0;
  const page = {
    isClosed: () => false,
    context: () => ({
      newCDPSession: async () => {
        attempts++;
        if (attempts === 1) throw new Error('page vanished mid-navigation');
        return { send: async () => undefined, on: () => undefined, detach: async () => undefined };
      },
    }),
  };
  const context = { pages: () => [page], on: () => undefined };
  const session = cdpSessionOf({ close: async () => undefined }, context);
  session.onNetworkEvent(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 1, 'first attach fails');
  session.onNetworkEvent(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 2, 'the next registration must not inherit a permanent failure');
});
// ---------------------------------------------------------------------------
// Foreground signal: say nothing when the signal cannot decide.
// ---------------------------------------------------------------------------

function fakeTabPage(visible: boolean) {
  return {
    isClosed: () => false,
    url: () => 'https://example.test/',
    title: async () => 'tab',
    on: () => undefined,
    evaluate: async (script: string) =>
      script.includes('visibilityState') ? visible : true,
    context: () => ({ newCDPSession: async () => ({ send: async () => undefined, on: () => undefined, detach: async () => undefined }) }),
  };
}

test('focusDifference stays silent when two tabs are both visible', async () => {
  const pages = [fakeTabPage(true), fakeTabPage(true)];
  const context = { pages: () => pages, on: () => undefined };
  const session = cdpSessionOf({ close: async () => undefined }, context);
  await session.activePage(); // the last page becomes the current target
  assert.equal(
    await session.focusDifference(),
    null,
    'two visible windows cannot say which one the user is looking at; guessing points the wrong way',
  );
});

test('focusDifference still names the only visible tab when one is visible', async () => {
  const pages = [fakeTabPage(false), fakeTabPage(true)];
  const context = { pages: () => pages, on: () => undefined };
  const session = cdpSessionOf({ close: async () => undefined }, context);
  const current = await session.activePage(); // the second (visible) page
  assert.equal(await session.focusDifference(), null, 'current target equals the only visible tab');

  const otherSessionPages = [fakeTabPage(true), fakeTabPage(false)];
  const other = cdpSessionOf(
    { close: async () => undefined },
    { pages: () => otherSessionPages, on: () => undefined },
  );
  await other.activePage();
  const diff = await other.focusDifference();
  assert.ok(diff, 'the other visible tab is a real difference');
  assert.notEqual(diff!.foreground, diff!.current);
  assert.ok(current.id);
});
