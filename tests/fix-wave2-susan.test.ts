/**
 * #30: `DeferredSession.newPage()` must not be repeated after a dead session.
 *
 * Same family as the `selectTab` bug fixed earlier today, with a worse consequence:
 * a repeated `selectTab` only sets the same default target twice, while a repeated
 * `newPage` opens a second tab that nothing owns or closes.
 *
 * Latent, not live: no MCP tool calls `DeferredSession.newPage()` today (only a
 * manual probe in `src/main.ts`), so nobody has hit this. These tests pin the
 * behaviour before someone does.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DeferredSession } from '../src/transport/deferred.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import type { RuntimePage } from '../src/transport/page.js';

const HINT = 'Start a browser with a debugging port first: Start-Process ...';
const TARGET = 'http://127.0.0.1:9222';
const page = { id: 'p1', retention: 'user' } as unknown as RuntimePage;

function deferred(open: () => Promise<BrowserSession>): DeferredSession {
  return new DeferredSession({ kind: 'cdp', target: TARGET, hint: HINT, open, retryAfterMs: 0 });
}

test('newPage is not repeated when the session dies mid-call', async () => {
  let opened = 0;
  let created = 0;
  const session = deferred(async () => {
    opened += 1;
    return {
      kind: 'cdp',
      pages: async () => [page],
      activePage: async () => page,
      newPage: async () => {
        created += 1;
        throw new Error('Target closed');
      },
      close: async () => undefined,
    } as unknown as BrowserSession;
  });

  const error = (await session.newPage().catch((err: unknown) => err)) as Error;
  assert.equal(error.message, 'Target closed');
  // A retry would have opened a second tab and reported success, leaving the first
  // tab orphaned with no record that it exists.
  assert.equal(created, 1, 'newPage must not be retried');
  assert.equal(opened, 1, 'no silent re-attach: the caller has to learn the attempt failed');
});

test('newPage still opens one page on a healthy session', async () => {
  let created = 0;
  const session = deferred(async () => ({
    kind: 'cdp',
    pages: async () => [page],
    activePage: async () => page,
    newPage: async () => {
      created += 1;
      return page;
    },
    close: async () => undefined,
  } as unknown as BrowserSession));

  const opened = await session.newPage();
  assert.equal(opened.id, 'p1');
  assert.equal(created, 1);
});
