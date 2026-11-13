/**
 * #35 A: characterisation of `DeferredSession.connected` after a failed write.
 *
 * The observation from the review: `selectTab` / `newPage` deliberately do not go
 * through `retryOnDead`, so a dead session that fails one of them leaves `live`
 * pointing at the corpse — and `connected` keeps answering `true` until the next
 * call that goes through `retryOnDead`.
 *
 * A characterisation test, not a bug fix. Before changing behaviour the question is
 * "does any caller act on this reading?" — see the note at the bottom of this file.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DeferredSession } from '../src/transport/deferred.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import type { RuntimePage } from '../src/transport/page.js';

const HINT = 'Start a browser with a debugging port first: Start-Process ...';
const TARGET = 'http://127.0.0.1:9222';
const page = { id: 'p1', retention: 'user' } as unknown as RuntimePage;

/** A session whose write operations fail the way a closed target does. */
function dyingSession(): BrowserSession {
  const dead = async (): Promise<never> => {
    throw new Error('Target closed');
  };
  return {
    kind: 'cdp',
    // Reads fail too: that is what a closed target does, and it is what lets the
    // next call notice and re-attach.
    pages: dead,
    activePage: async () => page,
    newPage: dead,
    selectTab: dead,
    close: async () => undefined,
  } as unknown as BrowserSession;
}

test('characterisation: connected still reads true after a failed selectTab', async () => {
  let opened = 0;
  const session = new DeferredSession({
    kind: 'cdp',
    target: TARGET,
    hint: HINT,
    retryAfterMs: 0,
    open: async () => {
      opened += 1;
      return dyingSession();
    },
  });

  await session.activePage();
  assert.equal(session.connected, true, 'attached means connected before anything fails');

  const error = (await session.selectTab('pw-1').catch((err: unknown) => err)) as Error;
  assert.equal(error.message, 'Target closed', 'the dead error reaches the caller');
  assert.equal(opened, 1, 'and it is not retried, so no silent re-attach');
  // This is the behaviour being pinned: the corpse is still "live" for connected.
  assert.equal(session.connected, true, 'characterisation: live is not cleared by a failed write');
});

test('characterisation: connected still reads true after a failed newPage', async () => {
  const session = new DeferredSession({
    kind: 'cdp',
    target: TARGET,
    hint: HINT,
    retryAfterMs: 0,
    open: async () => dyingSession(),
  });

  await session.activePage();
  await session.newPage().catch(() => undefined);
  assert.equal(session.connected, true, 'same shape as selectTab: newPage does not clear live either');
});

test('the next read that goes through retryOnDead clears the stale session', async () => {
  let attempt = 0;
  const session = new DeferredSession({
    kind: 'cdp',
    target: TARGET,
    hint: HINT,
    retryAfterMs: 0,
    open: async () => {
      attempt += 1;
      if (attempt === 1) return dyingSession();
      return {
        kind: 'cdp',
        pages: async () => [page],
        activePage: async () => page,
        newPage: async () => page,
        selectTab: async () => undefined,
        close: async () => undefined,
      } as unknown as BrowserSession;
    },
  });

  await session.activePage();
  await session.selectTab('pw-1').catch(() => undefined);
  assert.equal(session.connected, true);

  // A read re-attaches on the dead error, so the stale flag corrects itself.
  const pages = await session.pages();
  assert.equal(pages.length, 1);
  assert.equal(attempt, 2, 'the read re-attached');
  assert.equal(session.connected, true, 'and now it is true for the right reason');
});

/*
 * Why this is a characterisation and not a fix: `connected` is read by no product
 * code. `src/mcp/server.ts:433-436` builds doctor's own `connected` from whether
 * `pages()` succeeded; the getter itself is used only by these tests. So the stale
 * reading cannot make any tool do the wrong thing today, and "clearing live" here
 * would mean inventing a lifecycle rule for a value nobody consults. The honest
 * change is to say what it measures — see the note on the getter in deferred.ts.
 */

// ---------------------------------------------------------------------------
// Network listeners must reach a session that was attached *before* the listener
// arrived. That is the real tool order: navigate first, then `recon_start`.
// ---------------------------------------------------------------------------

type NetworkListener = (event: { method: string; params?: Record<string, unknown> }) => void;

/** A session that records the listeners it was given and can replay an event. */
function eventfulSession(): BrowserSession & {
  listeners: NetworkListener[];
  emit: (event: { method: string; params?: Record<string, unknown> }) => void;
} {
  const listeners: NetworkListener[] = [];
  const session = {
    kind: 'cdp',
    pages: async () => [page],
    activePage: async () => page,
    newPage: async () => page,
    close: async () => undefined,
    onNetworkEvent(listener: NetworkListener) {
      listeners.push(listener);
    },
    listeners,
    emit(event: { method: string; params?: Record<string, unknown> }) {
      for (const listener of listeners) listener(event);
    },
  };
  return session as unknown as BrowserSession & typeof session;
}

test('a listener registered after attach still receives events', async () => {
  const session = new DeferredSession({
    kind: 'cdp',
    target: TARGET,
    hint: HINT,
    retryAfterMs: 0,
    open: async () => eventfulSession(),
  });

  // The tool order: the first call attaches, `recon_start` only comes later.
  await session.activePage();
  const seen: string[] = [];
  session.onNetworkEvent((event) => seen.push(event.method));

  const live = session.current() as unknown as ReturnType<typeof eventfulSession>;
  assert.equal(live.listeners.length, 1, 'the listener must reach the attached session');
  live.emit({ method: 'Network.requestWillBeSent' });
  assert.deepEqual(seen, ['Network.requestWillBeSent'], 'and it must actually receive traffic');
});

test('a listener registered before attach still receives events', async () => {
  const session = new DeferredSession({
    kind: 'cdp',
    target: TARGET,
    hint: HINT,
    retryAfterMs: 0,
    open: async () => eventfulSession(),
  });

  const seen: string[] = [];
  session.onNetworkEvent((event) => seen.push(event.method)); // no live session yet
  await session.activePage();

  const live = session.current() as unknown as ReturnType<typeof eventfulSession>;
  assert.equal(live.listeners.length, 1, 'attach() still forwards pre-existing listeners');
  live.emit({ method: 'Network.responseReceived' });
  assert.deepEqual(seen, ['Network.responseReceived']);
});

test('registering the same listener twice does not double-deliver', async () => {
  const session = new DeferredSession({
    kind: 'cdp',
    target: TARGET,
    hint: HINT,
    retryAfterMs: 0,
    open: async () => eventfulSession(),
  });

  await session.activePage();
  let calls = 0;
  const listener = (): void => {
    calls += 1;
  };
  session.onNetworkEvent(listener);
  session.onNetworkEvent(listener);

  const live = session.current() as unknown as ReturnType<typeof eventfulSession>;
  assert.equal(live.listeners.length, 1, 'one session registration for one listener');
  live.emit({ method: 'Network.loadingFinished' });
  assert.equal(calls, 1);
});
