import assert from 'node:assert/strict';
import test from 'node:test';
import { DeferredSession } from '../src/transport/deferred.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import type { RuntimePage } from '../src/transport/page.js';

const base = {
  kind: 'cdp' as const,
  target: 'http://127.0.0.1:9222',
  hint: 'Start-Process chrome',
  retryAfterMs: 0,
};

function pageWith(id: string): RuntimePage {
  return { id, retention: 'user', url: async () => `https://example.com/${id}` } as unknown as RuntimePage;
}

test('a normal call says nothing about sessions', async () => {
  const session = new DeferredSession({
    ...base,
    open: async () => ({
      kind: 'cdp',
      pages: async () => [pageWith('p1')],
      activePage: async () => pageWith('p1'),
      newPage: async () => pageWith('p1'),
      close: async () => undefined,
    }),
  });

  await session.activePage();
  assert.equal(session.takeNotice(), null);
});

test('a call served by another tab is reported with both ids', async () => {
  let generation = 1;
  const dead = {
    kind: 'cdp',
    pages: async () => [pageWith('p1')],
    activePage: async () => pageWith('p1'),
    newPage: async () => pageWith('p1'),
    close: async () => undefined,
  } as BrowserSession;
  const replacement = {
    kind: 'cdp',
    pages: async () => [pageWith('p2')],
    activePage: async () => pageWith('p2'),
    newPage: async () => pageWith('p2'),
    close: async () => undefined,
  } as BrowserSession;

  const session = new DeferredSession({
    ...base,
    open: async () => (generation === 1 ? dead : replacement),
  });

  await session.activePage(); // the caller is now talking to p1
  generation = 2;
  // p1 goes away: the next call has to come from the replacement.
  (dead as unknown as { activePage: () => Promise<RuntimePage> }).activePage = async () => {
    throw Object.assign(new Error('Target page, context or browser has been closed'), {});
  };

  const page = await session.activePage();
  assert.equal(page.id, 'p2');
  const notice = session.takeNotice();
  assert.equal(notice?.replaced?.previousTabId, 'p1');
  assert.equal(notice?.replaced?.currentTabId, 'p2');
  assert.match(String(notice?.replaced?.cause), /closed/);
});

test('notice is drained once, so the next call is not blamed for it', async () => {
  let generation = 1;
  const dead = {
    kind: 'cdp',
    pages: async () => [],
    activePage: async (): Promise<RuntimePage> => {
      throw Object.assign(new Error('Target closed'), {});
    },
    newPage: async (): Promise<RuntimePage> => {
      throw Object.assign(new Error('Target closed'), {});
    },
    close: async () => undefined,
  } as BrowserSession;
  const replacement = {
    kind: 'cdp',
    pages: async () => [pageWith('p2')],
    activePage: async () => pageWith('p2'),
    newPage: async () => pageWith('p2'),
    close: async () => undefined,
  } as BrowserSession;

  const session = new DeferredSession({ ...base, open: async () => (generation === 1 ? dead : replacement) });
  await session.activePage().catch(() => undefined);
  generation = 2;
  await session.activePage();
  assert.notEqual(session.takeNotice(), null);
  assert.equal(session.takeNotice(), null);
});

test('a dead-sounding message that matches nothing is surfaced, not swallowed', async () => {
  const session = new DeferredSession({
    ...base,
    open: async () =>
      ({
        kind: 'cdp',
        pages: async () => [],
        activePage: async (): Promise<RuntimePage> => {
          // Playwright changed a word: the synonym list no longer matches.
          throw new Error('Target closd of the page');
        },
        newPage: async (): Promise<RuntimePage> => {
          throw new Error('Target closd of the page');
        },
        close: async () => undefined,
      }) as BrowserSession,
  });

  await assert.rejects(session.activePage(), /Target closd/);
  const notice = session.takeNotice();
  assert.match(String(notice?.unmatchedDeadText), /Target closd/);
  assert.equal(notice?.replaced, undefined, 'nothing was replaced, so nothing should claim it was');
});

test('recover() drops a dead session and announces what replaced it', async () => {
  let generation = 1;
  const dead = {
    kind: 'cdp',
    pages: async () => [pageWith('p1')],
    activePage: async (): Promise<RuntimePage> => {
      throw Object.assign(new Error('Target page, context or browser has been closed'), {});
    },
    newPage: async (): Promise<RuntimePage> => {
      throw Object.assign(new Error('Target page, context or browser has been closed'), {});
    },
    close: async () => undefined,
  } as BrowserSession;
  const replacement = {
    kind: 'cdp',
    pages: async () => [pageWith('p2')],
    activePage: async () => pageWith('p2'),
    newPage: async () => pageWith('p2'),
    close: async () => undefined,
  } as BrowserSession;

  const session = new DeferredSession({ ...base, open: async () => (generation === 1 ? dead : replacement) });
  await session.pages(); // attach to p1; pages() names no page
  generation = 2; // the browser is back under a new session
  assert.equal(await session.recover('a page operation said the page was closed'), true);

  const page = await session.activePage();
  assert.equal(page.id, 'p2');
  const notice = session.takeNotice();
  assert.equal(notice?.replaced?.currentTabId, 'p2');
  assert.match(String(notice?.replaced?.cause), /closed/);
});

test('recover() reports failure instead of pretending the browser came back', async () => {
  const session = new DeferredSession({
    ...base,
    open: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(await session.recover('anything'), false);
});
