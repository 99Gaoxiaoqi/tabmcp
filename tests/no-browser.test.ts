import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { DeferredSession } from '../src/transport/deferred.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import type { RuntimePage } from '../src/transport/page.js';

/**
 * The state a user hits before anything works: the MCP client connects, the browser
 * is not running. The connection must survive and every browser tool must say why.
 */
type ToolResult = { content?: Array<{ type?: string; text?: string }> };

/** The JSON body of a tool result, whatever shape the SDK types it as. */
function bodyOf(result: unknown): string {
  const first = (result as ToolResult).content?.[0];
  return String(first?.text ?? '{}');
}

async function refused(): Promise<Client> {
  const session = new DeferredSession({
    kind: 'cdp',
    target: 'http://127.0.0.1:9222',
    hint: 'Start-Process chrome ... --remote-debugging-port=9222',
    retryAfterMs: 0,
    open: async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9222');
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ session, queue: (fn) => fn() });
  await server.connect(serverSide);
  const client = new Client({ name: 'no-browser', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

test('no browser: the client still lists every tool', async () => {
  const client = await refused();
  const tools = await client.listTools();
  // Eighteen built-ins, plus one tool per installed adapter.
  assert.ok(tools.tools.length >= 18, `expected at least 18 tools, got ${tools.tools.length}`);
  for (const required of ['browser_goto', 'docs_get', 'doctor', 'js']) {
    assert.ok(tools.tools.some((tool) => tool.name === required), `${required} missing`);
  }
  await client.close();
});

test('no browser: docs_get still answers — the tool that explains the problem', async () => {
  const client = await refused();
  const result = await client.callTool({ name: 'docs_get', arguments: { topic: 'channels' } });
  const body = bodyOf(result);
  assert.ok(!body.includes('"ok": false'), body.slice(0, 200));
  assert.ok(body.length > 100, 'channels doc is empty');
  await client.close();
});

test('no browser: doctor reports the state instead of failing', async () => {
  const client = await refused();
  const result = await client.callTool({ name: 'doctor', arguments: {} });
  const body = JSON.parse(bodyOf(result));
  assert.equal(body.ok, true, 'doctor itself ran');
  assert.equal(body.connected, false, 'doctor must say the browser is missing');
  assert.equal(body.transport, 'cdp');
  assert.equal(body.browserError.code, 'E_NO_BROWSER');
  assert.match(String(body.browserError.hint), /remote-debugging-port/);
  await client.close();
});

test('no browser: a browser tool answers E_NO_BROWSER with a hint', async () => {
  const client = await refused();
  const result = await client.callTool({ name: 'browser_goto', arguments: { url: 'https://example.com/' } });
  const body = JSON.parse(bodyOf(result));
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_NO_BROWSER');
  assert.match(String(body.error.hint), /remote-debugging-port/);
  assert.equal(body.error.data.target, 'http://127.0.0.1:9222');
  await client.close();
});

test('no browser: adapter and site tools answer E_NO_BROWSER, not a crash', async () => {
  const client = await refused();
  // site_run is deliberately absent: with no adapters installed it answers
  // E_TARGET_NOT_FOUND before it ever asks for a browser, so it cannot prove this.
  for (const [name, args] of [
    ['browser_network_read', {}],
    ['browser_cookies', { domain: 'example.com' }],
    ['browser_screenshot', {}],
  ] as const) {
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
    const body = JSON.parse(bodyOf(result));
    assert.equal(body.ok, false, `${name} should fail without a browser`);
    assert.equal(body.error.code, 'E_NO_BROWSER', `${name} should report E_NO_BROWSER`);
  }

  // Neither of these touches the page: catalogue lookup and pure expressions work
  // with no browser at all, and must keep working.
  const pure = JSON.parse(bodyOf(await client.callTool({ name: 'js', arguments: { code: '1 + 1' } })));
  assert.equal(pure.ok, true, 'a pure expression should not need a browser');
  const search = JSON.parse(
    bodyOf(await client.callTool({ name: 'sites_search', arguments: { query: 'juejin' } })),
  );
  assert.equal(search.ok, true, 'sites_search should not need a browser');
  await client.close();
});

test('no browser: once a browser appears the same client works', async () => {
  let up = false;
  const page = {
    id: 'late-1',
    retention: 'user',
    url: async () => 'https://example.com/',
    title: async () => 'Late page',
    goto: async (url: string) => ({ url, status: 200, requestedUrl: url, landedElsewhere: false }),
    evaluate: async () => ({ docId: 'doc-late', url: 'https://example.com/', ready: 'complete', mutations: 0, idleMs: 500 }),
    frames: async () => [],
    close: async () => undefined,
  } as unknown as RuntimePage;

  const late: BrowserSession = {
    kind: 'cdp',
    pages: async () => [page],
    activePage: async () => page,
    newPage: async () => page,
    close: async () => undefined,
  };

  const session = new DeferredSession({
    kind: 'cdp',
    target: 'http://127.0.0.1:9222',
    hint: 'Start-Process chrome ...',
    retryAfterMs: 0,
    open: async () => {
      if (!up) throw new Error('ECONNREFUSED');
      return late;
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ session, queue: (fn) => fn() });
  await server.connect(serverSide);
  const client = new Client({ name: 'late-browser', version: '1.0.0' });
  await client.connect(clientSide);

  const missing = JSON.parse(bodyOf(await client.callTool({ name: 'doctor', arguments: {} })));
  assert.equal(missing.connected, false);

  up = true;
  const ok = JSON.parse(bodyOf(await client.callTool({ name: 'doctor', arguments: {} })));
  assert.equal(ok.connected, true);
  assert.equal(ok.activeTab.id, 'late-1');
  await client.close();
});
