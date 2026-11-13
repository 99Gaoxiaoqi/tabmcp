/**
 * task #28: the small ones - retry allow-list, foreground naming, and the test split.
 *
 * Two things are pinned here that a careless change would quietly undo:
 *
 *  - `foregroundSignal` must come from the channel, not from a default. If a third
 *    channel is ever added, it has to answer this question instead of inheriting a
 *    label that belongs to one of the two existing ones.
 *  - `focusDifference()` speaks only when exactly one tab qualifies, **on both
 *    channels**. The CDP side got this rule in `7ed0e10`; the extension side kept
 *    picking the first `active` tab, which with two windows open is a guess - and a
 *    guess that can point the wrong way, which is worse than saying nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { ExtensionSession } from '../src/transport/extension.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import type { RuntimePage } from '../src/transport/page.js';

function bodyOf(result: unknown): Record<string, any> {
  const blocks = ((result as { content?: unknown }).content ?? []) as Array<{ text?: string }>;
  for (const block of blocks) {
    try {
      return JSON.parse(String(block.text ?? ''));
    } catch {
      continue;
    }
  }
  return {};
}

function page(id: string): RuntimePage {
  return { id, retention: 'user', url: async () => `https://example.test/${id}`, title: async () => id } as unknown as RuntimePage;
}

async function clientFor(session: BrowserSession): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ session, queue: (fn) => fn() });
  await server.connect(serverSide);
  const client = new Client({ name: 'fix-small', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

// ---------------------------------------------------------------------------
// foregroundSignal comes from the channel
// ---------------------------------------------------------------------------

test('foregroundSignal says what the channel actually measured: cdp -> visibility', async () => {
  const session: BrowserSession = {
    kind: 'cdp',
    pages: async () => [page('pw-1')],
    activePage: async () => page('pw-1'),
    newPage: async () => page('pw-1'),
    close: async () => undefined,
    tabList: async () => [{ id: 'pw-1', url: 'https://example.test/', title: 'one', currentTarget: true, foreground: true }],
  };
  const client = await clientFor(session);
  const body = bodyOf(await client.callTool({ name: 'browser_tabs', arguments: {} }));
  assert.equal(body.foregroundSignal, 'visibility', 'CDP infers foreground from document.visibilityState');
  await client.close();
});

test('foregroundSignal follows the channel, not a default: extension -> active', async () => {
  const session: BrowserSession = {
    kind: 'extension',
    pages: async () => [page('ext-1')],
    activePage: async () => page('ext-1'),
    newPage: async () => page('ext-1'),
    close: async () => undefined,
    tabList: async () => [{ id: 'ext-1', url: 'https://example.test/', title: 'one', currentTarget: true, foreground: true }],
  };
  const client = await clientFor(session);
  const body = bodyOf(await client.callTool({ name: 'browser_tabs', arguments: {} }));
  assert.equal(body.foregroundSignal, 'active', 'the extension asks chrome.tabs.active');
  await client.close();
});

// ---------------------------------------------------------------------------
// Both channels: speak only when exactly one tab qualifies
// ---------------------------------------------------------------------------

function extensionWith(tabs: Array<{ tabId: number; url: string; active: boolean }>, currentTabId: number): ExtensionSession {
  const client = {
    on: () => undefined,
    request: async (request: { method: string }) => (request.method === 'tabs' ? tabs : { value: null }),
  };
  // The constructor is private because it wires a real broker; the fields focusDifference
  // reads are these two, so a prototype instance is the honest way to test it.
  const session = Object.create(ExtensionSession.prototype) as ExtensionSession;
  const internals = session as unknown as {
    client: unknown;
    listeners: unknown[];
    pageCache: Map<number, unknown>;
    active: unknown;
  };
  internals.client = client;
  internals.listeners = [];
  internals.pageCache = new Map();
  internals.active = { id: `ext-${currentTabId}`, isClosed: () => false };
  return session;
}

test('extension: two windows each with an active tab is a draw, so it stays silent', async () => {
  // Old behaviour: `tabs.find(tab => tab.active)` returned whichever came first, so it
  // named a tab the user may not have been looking at. `chrome.tabs.query({})` spans all
  // windows, so two windows really do mean two active tabs.
  const session = extensionWith(
    [
      { tabId: 11, url: 'https://example.test/a', active: true },
      { tabId: 22, url: 'https://example.test/b', active: true },
    ],
    11,
  );
  assert.equal(await session.focusDifference(), null, 'two active tabs cannot say which window is in front');
});

test('extension: it still names the one active tab when the target is elsewhere', async () => {
  // Without this the previous test passes by writing `return null` and never speaking.
  const session = extensionWith(
    [
      { tabId: 11, url: 'https://example.test/a', active: false },
      { tabId: 22, url: 'https://example.test/b', active: true },
    ],
    11,
  );
  const diff = await session.focusDifference();
  assert.ok(diff, 'the active tab is a real difference from the target');
  assert.deepEqual(diff, { current: 'ext-11', foreground: 'ext-22' });
});

test('extension: no marker when the target is the active tab', async () => {
  const session = extensionWith(
    [
      { tabId: 11, url: 'https://example.test/a', active: true },
      { tabId: 22, url: 'https://example.test/b', active: false },
    ],
    11,
  );
  assert.equal(await session.focusDifference(), null, 'nothing to report when they agree');
});
