import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { DeferredSession } from '../src/transport/deferred.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import type { RuntimePage } from '../src/transport/page.js';

type ToolResult = { content?: Array<{ type?: string; text?: string }> };

function bodyOf(result: unknown): Record<string, unknown> {
  const first = (result as ToolResult).content?.[0];
  return JSON.parse(String(first?.text ?? '{}')) as Record<string, unknown>;
}

function pageWith(id: string): RuntimePage {
  return {
    id,
    retention: 'user',
    url: async () => `https://example.com/${id}`,
    title: async () => `page ${id}`,
    frames: async () => [],
  } as unknown as RuntimePage;
}

function sessionOf(id: string): BrowserSession {
  return {
    kind: 'cdp',
    pages: async () => [pageWith(id)],
    activePage: async () => pageWith(id),
    newPage: async () => pageWith(id),
    close: async () => undefined,
  } as BrowserSession;
}

async function connected(open: () => Promise<BrowserSession>): Promise<Client> {
  const session = new DeferredSession({
    kind: 'cdp',
    target: 'http://127.0.0.1:9222',
    hint: 'Start-Process chrome',
    retryAfterMs: 0,
    open,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ session, queue: (fn) => fn() });
  await server.connect(serverSide);
  const client = new Client({ name: 'notice', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

test('a result that came from another tab says so, with both ids', async () => {
  let alive = true;
  let generation = 1;
  const first = sessionOf('pw-1111');
  const dying = {
    ...first,
    pages: async () => {
      if (!alive) throw Object.assign(new Error('Target page, context or browser has been closed'), {});
      return [pageWith('pw-1111')];
    },
    activePage: async () => {
      if (!alive) throw Object.assign(new Error('Target page, context or browser has been closed'), {});
      return pageWith('pw-1111');
    },
  } as BrowserSession;

  const client = await connected(async () => {
    if (generation === 1) return dying;
    return sessionOf('pw-2222');
  });

  const before = bodyOf(await client.callTool({ name: 'doctor', arguments: {} }));
  assert.equal(before.connected, true);
  assert.equal(before.sessionReplaced, undefined, 'a normal result must not carry the marker');

  alive = false;
  generation = 2;
  const after = bodyOf(await client.callTool({ name: 'doctor', arguments: {} }));
  assert.equal(after.connected, true, 'the replacement answered');
  assert.equal(after.sessionReplaced, true);
  assert.equal(after.previousTabId, 'pw-1111');
  assert.equal(after.currentTabId, 'pw-2222');
  assert.match(String(after.replaceCause), /closed/);
  await client.close();
});

test('the marker does not leak into the following call', async () => {
  let alive = true;
  let generation = 1;
  const dying = {
    kind: 'cdp',
    pages: async () => {
      if (!alive) throw Object.assign(new Error('Target closed'), {});
      return [pageWith('pw-1111')];
    },
    activePage: async () => {
      if (!alive) throw Object.assign(new Error('Target closed'), {});
      return pageWith('pw-1111');
    },
    newPage: async () => pageWith('pw-1111'),
    close: async () => undefined,
  } as BrowserSession;

  const client = await connected(async () => (generation === 1 ? dying : sessionOf('pw-9999')));
  await client.callTool({ name: 'doctor', arguments: {} });
  alive = false;
  generation = 2;
  assert.equal(bodyOf(await client.callTool({ name: 'doctor', arguments: {} })).sessionReplaced, true);
  const next = bodyOf(await client.callTool({ name: 'doctor', arguments: {} }));
  assert.equal(next.sessionReplaced, undefined);
  await client.close();
});

test('a dead-sounding but unmatched error is tied to its own envelope', async () => {
  const client = await connected(async () => ({
    kind: 'cdp',
    pages: async () => [],
    activePage: async (): Promise<RuntimePage> => {
      throw new Error('Target closd of the page');
    },
    newPage: async (): Promise<RuntimePage> => {
      throw new Error('Target closd of the page');
    },
    close: async () => undefined,
  }));

  const body = bodyOf(await client.callTool({ name: 'doctor', arguments: {} }));
  // doctor keeps ok:true (it ran) and reports the underlying failure it saw.
  const browserError = body.browserError as Record<string, unknown>;
  const data = browserError.data as Record<string, unknown> | undefined;
  assert.match(String(data?.deadLikeTextUnmatched ?? ''), /Target closd/);
  await client.close();
});
