import assert from 'node:assert/strict';
import test from 'node:test';
import { DeferredSession } from '../src/transport/deferred.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import type { RuntimePage } from '../src/transport/page.js';

const HINT = 'Start a browser with a debugging port first: Start-Process ...';
const TARGET = 'http://127.0.0.1:9222';

function deferred(open: () => Promise<BrowserSession>, retryAfterMs = 0): DeferredSession {
  return new DeferredSession({ kind: 'cdp', target: TARGET, hint: HINT, open, retryAfterMs });
}

const page = { id: 'p1', retention: 'user' } as unknown as RuntimePage;

function fake(): BrowserSession {
  return {
    kind: 'cdp',
    pages: async () => [page],
    activePage: async () => page,
    newPage: async () => page,
    close: async () => undefined,
  };
}

test('unreachable browser: E_NO_BROWSER carries the reason, not just a message', async () => {
  const session = deferred(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:9222');
  });
  assert.equal(session.connected, false);

  const error = (await session.pages().catch((err: unknown) => err)) as {
    code?: string;
    hint?: string;
    data?: Record<string, unknown>;
  };
  assert.equal(error.code, 'E_NO_BROWSER');
  assert.match(String(error.hint), /Start-Process/);
  // "wrong port" must stay distinguishable from "not started".
  assert.match(String(error.data?.reason), /ECONNREFUSED/);
});

test('browser appears later: the same object attaches without a restart', async () => {
  let up = false;
  let attempts = 0;
  const session = deferred(async () => {
    attempts += 1;
    if (!up) throw new Error('ECONNREFUSED');
    return fake();
  });

  assert.equal(((await session.pages().catch((err: unknown) => err)) as { code?: string }).code, 'E_NO_BROWSER');
  up = true;
  assert.equal((await session.pages()).length, 1);
  assert.equal(session.connected, true);
  assert.equal(attempts, 2);
});

test('concurrent callers share one connection attempt', async () => {
  let attempts = 0;
  const session = deferred(async () => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return fake();
  });
  const results = await Promise.all([session.pages(), session.pages(), session.pages()]);
  assert.deepEqual(results.map((pages) => pages.length), [1, 1, 1]);
  assert.equal(attempts, 1);
});

test('a restarted browser is picked up instead of reporting a closed tab', async () => {
  let generation = 1;
  const deadBrowser = {
    kind: 'cdp',
    activePage: async (): Promise<RuntimePage> => {
      throw Object.assign(new Error('The tab is closed'), { code: 'E_NO_TAB' });
    },
    pages: async () => [page],
    newPage: async () => page,
    close: async () => undefined,
  } as unknown as BrowserSession;
  const freshBrowser = fake();

  const session = deferred(async () => (generation === 1 ? deadBrowser : freshBrowser));
  await session.pages(); // attaches generation 1
  generation = 2;

  assert.equal((await session.activePage()).id, 'p1');
  assert.equal(session.current(), freshBrowser);
});

test('a request error stays a request error (no reconnect storm)', async () => {
  let attempts = 0;
  const picky = {
    kind: 'cdp',
    pages: async () => [page],
    activePage: async (): Promise<RuntimePage> => {
      throw Object.assign(new Error('element is not interactable'), { code: 'E_NOT_INTERACTABLE' });
    },
    newPage: async () => page,
    close: async () => undefined,
  } as unknown as BrowserSession;
  const session = deferred(async () => {
    attempts += 1;
    return picky;
  });

  await assert.rejects(session.activePage(), /not interactable/);
  assert.equal(attempts, 1, 'a wrong request must not trigger a reconnect');
  assert.equal(session.connected, true);
});

test('network listeners reach a session that attaches later', async () => {
  const seen: string[] = [];
  let listener: ((event: { method: string }) => void) | null = null;
  const watcher = {
    kind: 'cdp',
    onNetworkEvent(fn: (event: { method: string }) => void) {
      listener = fn;
    },
    pages: async () => [],
    activePage: async (): Promise<RuntimePage> => {
      throw new Error('none');
    },
    newPage: async (): Promise<RuntimePage> => {
      throw new Error('none');
    },
    close: async () => undefined,
  } as unknown as BrowserSession;

  const session = deferred(async () => watcher);
  session.onNetworkEvent((event) => seen.push(event.method));
  assert.equal(listener, null);

  await session.attach();
  assert.notEqual(listener, null);
  (listener as unknown as (event: { method: string }) => void)({ method: 'Network.responseReceived' });
  assert.deepEqual(seen, ['Network.responseReceived']);
});
