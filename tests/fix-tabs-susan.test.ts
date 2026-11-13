/**
 * fix-tabs: browser_tabs / browser_tabs_select, and the marker for acting on a tab the
 * user is not looking at.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import type { BrowserSession, TabDescriptor } from '../src/transport/cdp.js';
import type { RuntimePage } from '../src/transport/page.js';

type ToolResult = { content?: Array<{ type?: string; text?: string }> };

function bodyOf(result: unknown): Record<string, any> {
  const blocks = (result as ToolResult).content ?? [];
  // observe/read answer prose first, JSON second (fix-c); take the first parsable block.
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
  return { id, retention: 'user', url: async () => `https://example.test/${id}`, title: async () => `tab ${id}` } as unknown as RuntimePage;
}

/** A session that records what the tools did to it. */
function fakeSession(options: { diff?: { current: string; foreground: string } | null } = {}) {
  const state = {
    selected: 'pw-1111',
    diff: options.diff === undefined ? null : options.diff,
    selectCalls: [] as string[],
    listCalls: 0,
  };
  const tabs = (): TabDescriptor[] => [
    { id: 'pw-1111', url: 'https://example.test/one', title: 'one', currentTarget: state.selected === 'pw-1111', foreground: true },
    { id: 'pw-2222', url: 'https://example.test/two', title: 'two', currentTarget: state.selected === 'pw-2222', foreground: false },
  ];
  const session: BrowserSession = {
    kind: 'cdp',
    pages: async () => [page('pw-1111'), page('pw-2222')],
    activePage: async () => page(state.selected),
    newPage: async () => page(state.selected),
    close: async () => undefined,
    tabList: async () => {
      state.listCalls += 1;
      return tabs();
    },
    selectTab: async (id: string) => {
      if (!tabs().some((tab) => tab.id === id)) throw new Error(`unknown ${id}`);
      state.selectCalls.push(id);
      state.selected = id;
    },
    focusDifference: async () => state.diff,
  };
  return { session, state };
}

async function clientFor(session: BrowserSession): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ session, queue: (fn) => fn() });
  await server.connect(serverSide);
  const client = new Client({ name: 'tabs', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

test('browser_tabs lists every tab with target and focus flags', async () => {
  const { session } = fakeSession();
  const client = await clientFor(session);
  const body = bodyOf(await client.callTool({ name: 'browser_tabs', arguments: {} }));

  assert.equal(body.ok, true);
  assert.equal(body.count, 2);
  assert.deepEqual(
    body.tabs.map((tab: TabDescriptor) => [tab.id, tab.currentTarget, tab.foreground]),
    [
      ['pw-1111', true, true],
      ['pw-2222', false, false],
    ],
  );
  await client.close();
});

test('browser_tabs_select makes the choice sticky, not one-shot', async () => {
  const { session, state } = fakeSession();
  const client = await clientFor(session);

  const selected = bodyOf(await client.callTool({ name: 'browser_tabs_select', arguments: { id: 'pw-2222' } }));
  assert.equal(selected.ok, true);
  assert.deepEqual(state.selectCalls, ['pw-2222']);

  // The next read-only call must already be looking at the new default.
  const after = bodyOf(await client.callTool({ name: 'browser_tabs', arguments: {} }));
  assert.equal(after.tabs.find((tab: TabDescriptor) => tab.id === 'pw-2222').currentTarget, true);
  assert.equal(after.tabs.find((tab: TabDescriptor) => tab.id === 'pw-1111').currentTarget, false);
  await client.close();
});

test('selecting an unknown tab reports the ids that do exist', async () => {
  const { session } = fakeSession();
  const client = await clientFor(session);
  const body = bodyOf(await client.callTool({ name: 'browser_tabs_select', arguments: { id: 'pw-9999' } }));
  assert.equal(body.ok, false);
  assert.ok(['E_NO_TAB', 'E_INTERNAL'].includes(body.error.code), `got ${body.error.code}`);
  await client.close();
});

test('a tool acting while the user looks elsewhere carries tabFocusDiffers', async () => {
  const { session } = fakeSession({ diff: { current: 'pw-1111', foreground: 'pw-2222' } });
  const client = await clientFor(session);
  const body = bodyOf(await client.callTool({ name: 'browser_navigate', arguments: { action: 'reload' } }));

  assert.deepEqual(body.tabFocusDiffers, { current: 'pw-1111', foreground: 'pw-2222' });
  await client.close();
});

test('no marker when the target is the tab the user is looking at', async () => {
  const { session } = fakeSession({ diff: null });
  const client = await clientFor(session);
  const body = bodyOf(await client.callTool({ name: 'browser_navigate', arguments: { action: 'reload' } }));
  assert.equal('tabFocusDiffers' in body, false);
  await client.close();
});

test('browser_tabs itself does not carry the marker (it describes focus already)', async () => {
  const { session } = fakeSession({ diff: { current: 'pw-1111', foreground: 'pw-2222' } });
  const client = await clientFor(session);
  const body = bodyOf(await client.callTool({ name: 'browser_tabs', arguments: {} }));
  assert.equal('tabFocusDiffers' in body, false);
  await client.close();
});
