/**
 * fix-b: regression tests for the ten fixes in task #24.
 *
 * Each test states the old behaviour in a comment, so a future reader can tell what it
 * is protecting. Red-before-green for the ones that can be reproduced against HEAD is
 * recorded in reports/fix-susan.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NetworkJournal, CONTENT_STATE_SCRIPT } from '../src/core/journal.js';
import { cookieMatchesDomain } from '../src/core/cookie.js';
import { placeDownload } from '../src/core/downloads.js';
import { DeferredSession } from '../src/transport/deferred.js';
import { ActionError } from '../src/core/errors.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import type { RuntimePage } from '../src/transport/page.js';
import { BrokerClient, ExtensionSession } from '../src/transport/extension.js';

// ---------------------------------------------------------------------------
// ① pages() must hand out one object per tab (a new one each call wiped the journal)
// ---------------------------------------------------------------------------

function stubClient(tabs: Array<{ tabId: number; url: string; active: boolean }>) {
  const calls: Array<{ method: string; timeoutMs?: number }> = [];
  return {
    calls,
    on: () => undefined,
    request: async (request: { method: string; params?: Record<string, unknown> }, timeoutMs?: number) => {
      calls.push({ method: request.method, timeoutMs });
      if (request.method === 'tabs') return tabs;
      if (request.method === 'auth') return {};
      return { value: null };
    },
  };
}

type SessionInternals = {
  client: unknown;
  listeners: unknown[];
  pageCache: Map<number, unknown>;
};

function sessionWith(client: unknown): ExtensionSession {
  // The constructor is private (it wires a real broker); the fields it would initialise
  // are the three set below, so a prototype instance is enough to test pages().
  const session = Object.create(ExtensionSession.prototype) as ExtensionSession;
  const internals = session as unknown as SessionInternals;
  internals.client = client;
  internals.listeners = [];
  internals.pageCache = new Map();
  return session;
}

test('pages(): the same tab yields the same page object (old: a new one every call)', async () => {
  const client = stubClient([{ tabId: 11, url: 'https://example.test/', active: true }]);
  const session = sessionWith(client);

  const first = await session.pages();
  const second = await session.pages();

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0], second[0], 'a new object here would reset that page own journal');
});

test('pages(): a tab that disappears is dropped from the cache', async () => {
  const client = stubClient([{ tabId: 11, url: 'https://example.test/', active: true }]);
  const session = sessionWith(client);
  const first = await session.pages();

  (client as unknown as { request: unknown }).request = async (request: { method: string }) =>
    request.method === 'tabs' ? [] : { value: null };
  const second = await session.pages();

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

// ---------------------------------------------------------------------------
// ⑤ content state: text is what decides "empty"; node count only separates placeholder
// ---------------------------------------------------------------------------

function runContentScript(body: { innerText: string; elementCount: number } | null): string {
  const document = body
    ? {
        body: {
          innerText: body.innerText,
          querySelectorAll: () => ({ length: body.elementCount }),
        },
      }
    : {};
  // The script is a self-invoking expression over the page globals.
  return new Function('document', `return ${CONTENT_STATE_SCRIPT}`)(document) as string;
}

test('contentState: a body of plain text with no element children is ready, not empty', () => {
  // Old: `nodes === 0` returned empty, so 200 KB of text was reported as `content:"empty"`.
  assert.equal(runContentScript({ innerText: 'x'.repeat(2000), elementCount: 0 }), 'ready');
});

test('contentState: no text and no elements is empty; no text with elements is a skeleton', () => {
  assert.equal(runContentScript({ innerText: '   ', elementCount: 0 }), 'empty');
  assert.equal(runContentScript({ innerText: '   ', elementCount: 4 }), 'placeholder');
});

// ---------------------------------------------------------------------------
// ⑥ a malformed /regex/ must be refused, not silently matched as a substring
// ---------------------------------------------------------------------------

test('network_read: an invalid /regex/ is E_BAD_ARGUMENT, not a substring fallback', () => {
  const journal = new NetworkJournal();
  journal.requestStarted('r1', 'GET', 'https://example.test/api/items');
  journal.record('r1', 200, 'application/json', '{"ok":true}');

  // Old: the catch returned url.includes('/(/') = false, so the caller saw "no matches".
  assert.throws(
    () => journal.read({ pattern: '/(/' }),
    (err: unknown) => err instanceof ActionError && err.code === 'E_BAD_ARGUMENT',
  );
});

// ---------------------------------------------------------------------------
// ④ pending requests must not accumulate; size is tracked as entries arrive
// ---------------------------------------------------------------------------

test('journal: a request whose response never arrives does not stay pending forever', () => {
  const journal = new NetworkJournal();
  journal.requestStarted('never-answered', 'GET', 'https://example.test/image.png');
  assert.equal(journal.pendingCount, 1);

  const internal = journal as unknown as { pending: Map<string, { at: number }> };
  for (const record of internal.pending.values()) record.at = Date.now() - 5 * 60_000;

  assert.equal(journal.pendingCount, 0, 'an old unattributed request must be pruned');
});

test('journal: eviction keeps the total under the cap as entries are added', () => {
  const journal = new NetworkJournal(3);
  for (let i = 0; i < 6; i++) {
    journal.requestStarted(`r${i}`, 'GET', `https://example.test/${i}`);
    journal.record(`r${i}`, 200, 'application/json', JSON.stringify({ i }));
  }
  const read = journal.read({ limit: 100 });
  assert.equal(journal.size, 3);
  assert.deepEqual(read.entries.map((entry) => entry.url.slice(-1)), ['3', '4', '5']);
});

// ---------------------------------------------------------------------------
// ⑦ filename without dir cannot be honoured
// ---------------------------------------------------------------------------

test('download: filename without dir is refused instead of silently ignored', async () => {
  await assert.rejects(
    placeDownload({ filename: 'report.csv', bytes: 3, path: os.tmpdir() }, { filename: 'renamed.csv' }),
    (err: unknown) => err instanceof ActionError && err.code === 'E_BAD_ARGUMENT',
  );
});

// ---------------------------------------------------------------------------
// ⑧ cookie domain matching needs a boundary
// ---------------------------------------------------------------------------

test('cookies: notexample.com does not match example.com, subdomains still do', () => {
  // Old: `endsWith('example.com')` matched notexample.com as well.
  assert.equal(cookieMatchesDomain({ domain: 'notexample.com' }, 'example.com'), false);
  assert.equal(cookieMatchesDomain({ domain: 'example.com' }, 'example.com'), true);
  assert.equal(cookieMatchesDomain({ domain: '.example.com' }, 'example.com'), true);
  assert.equal(cookieMatchesDomain({ domain: 'api.example.com' }, 'example.com'), true);
});

// ---------------------------------------------------------------------------
// ⑨ broker timeouts carry a code the caller can branch on
// ---------------------------------------------------------------------------

test('broker: a request that never gets an answer fails with E_ACTION_TIMEOUT', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tabmcp-broker-')), 'broker.json');
  const server = net.createServer((socket) => {
    socket.on('data', () => undefined); // accept the frame, never answer
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  fs.writeFileSync(stateFile, JSON.stringify({ port, token: 'test-token' }));

  const client = await BrokerClient.connect({ stateFile, waitMs: 2_000 });
  try {
    await assert.rejects(client.request({ method: 'tabs', params: {} }, 150), (err: unknown) => {
      assert.ok(err instanceof ActionError, `expected ActionError, got ${String(err)}`);
      assert.equal((err as ActionError).code, 'E_ACTION_TIMEOUT');
      return true;
    });
  } finally {
    client.close();
    server.close();
  }
});
