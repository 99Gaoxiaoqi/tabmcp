import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import { FakePage } from './helpers/fake.js';

type ToolResult = { content?: Array<{ type?: string; text?: string }> };

function bodyOf(result: unknown): Record<string, any> {
  return JSON.parse(String((result as ToolResult).content?.[0]?.text ?? '{}'));
}

async function clientFor(page: FakePage): Promise<Client> {
  const session: BrowserSession = {
    kind: 'cdp',
    pages: async () => [page],
    activePage: async () => page,
    newPage: async () => page,
    close: async () => undefined,
  } as unknown as BrowserSession;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ session, queue: (fn) => fn() });
  await server.connect(serverSide);
  const client = new Client({ name: 'navigate-status', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

test('reload on an error page reports status and pageError', async () => {
  const page = new FakePage();
  page.status = 404;
  const client = await clientFor(page);
  const body = bodyOf(await client.callTool({ name: 'browser_navigate', arguments: { action: 'reload' } }));
  assert.equal(body.ok, true);
  assert.equal(body.status, 404);
  assert.equal(body.pageError, true);
  await client.close();
});

test('reload on a healthy page carries no pageError field', async () => {
  const page = new FakePage();
  page.status = 200;
  const client = await clientFor(page);
  const body = bodyOf(await client.callTool({ name: 'browser_navigate', arguments: { action: 'reload' } }));
  assert.equal(body.status, 200);
  assert.equal('pageError' in body, false);
  await client.close();
});

test('back and forward report the status they landed on', async () => {
  for (const action of ['back', 'forward'] as const) {
    const page = new FakePage();
    page.status = 503;
    const client = await clientFor(page);
    const body = bodyOf(await client.callTool({ name: 'browser_navigate', arguments: { action } }));
    assert.equal(body.status, 503, `${action} status`);
    assert.equal(body.pageError, true, `${action} pageError`);
    await client.close();
  }
});

test('an unknown status stays null instead of being guessed as fine', async () => {
  const page = new FakePage();
  page.status = null;
  const client = await clientFor(page);
  const body = bodyOf(await client.callTool({ name: 'browser_navigate', arguments: { action: 'reload' } }));
  assert.equal(body.ok, true);
  assert.equal(body.status, null);
  assert.equal('pageError' in body, false, 'unknown is not fine, and it is not an error either');
  await client.close();
});
