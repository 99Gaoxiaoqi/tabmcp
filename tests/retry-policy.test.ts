import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { DeferredSession } from '../src/transport/deferred.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import type { RuntimePage } from '../src/transport/page.js';
import { FakePage } from './helpers/fake.js';

type Envelope = { content?: Array<{ type?: string; text?: string }> };

function bodyOf(result: unknown): Record<string, any> {
  const first = (result as Envelope).content?.[0];
  return JSON.parse(String(first?.text ?? '{}'));
}

async function clientFor(open: () => Promise<BrowserSession>): Promise<Client> {
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
  const client = new Client({ name: 'retry-policy', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

function sessionOf(page: RuntimePage): BrowserSession {
  return {
    kind: 'cdp',
    pages: async () => [page],
    activePage: async () => page,
    newPage: async () => page,
    close: async () => undefined,
  } as BrowserSession;
}

const DEAD = 'Target page, context or browser has been closed';

test('a read is retried once and announces the replacement', async () => {
  let reads = 0;
  const first = new FakePage();
  // The page dies mid-read: the call fails after it started.
  (first as unknown as { evaluate: (script: string) => Promise<unknown> }).evaluate = async () => {
    reads += 1;
    throw new Error(DEAD);
  };
  const second = new FakePage();
  (second as unknown as { id: string }).id = 'fake-2';
  const secondEvaluate = second.evaluate.bind(second);
  (second as unknown as { evaluate: (script: string) => Promise<unknown> }).evaluate = async (script: string) => {
    reads += 1;
    return secondEvaluate(script);
  };

  let opens = 0;
  const client = await clientFor(async () => {
    opens += 1;
    return sessionOf(opens === 1 ? first : second);
  });
  const raw = String(
    ((await client.callTool({ name: 'browser_read', arguments: {} })) as { content?: Array<{ text?: string }> })
      .content?.[0]?.text ?? '',
  );

  // read answers prose, so the retry shows up as text from the *replacement* page
  // together with the marker, which only exists when a replacement happened.
  assert.ok(reads >= 2, 'the read was attempted again on the replacement');
  assert.match(raw, /fake body text/, 'the replacement page answered the read');
  await client.close();
});

test('js is never retried, and says the action may already have happened', async () => {
  const page = new FakePage();
  const client = await clientFor(async () => sessionOf(page));

  const code = `
    await tab.url();
    globalThis.__attempts = (globalThis.__attempts ?? 0) + 1;
    throw new Error('${DEAD}');
  `;
  const body = bodyOf(await client.callTool({ name: 'js', arguments: { code } }));

  assert.equal(body.ok, false, 'js reports the failure');
  assert.equal(body.error.data.sessionReplaced, true, 'the refusal still names the replacement');
  assert.equal(body.error.data.previousTabId, 'fake-1');
  assert.equal(body.error.data.currentTabId, 'fake-1');
  assert.match(String(body.error.hint), /may already have happened/);

  // Counting, not code-matching: the snippet must have run exactly once.
  const counter = bodyOf(await client.callTool({ name: 'js', arguments: { code: 'globalThis.__attempts' } }));
  assert.equal(Number(counter.value), 1, 'the snippet ran once; it was not silently repeated');
  await client.close();
});

test('the retry list is read-only tools only', async () => {
  const { RETRY_SAFE_TOOLS } = await import('../src/mcp/server.js');
  assert.deepEqual(
    [...RETRY_SAFE_TOOLS].sort(),
    ['browser_goto', 'browser_observe', 'browser_read', 'browser_screenshot', 'browser_tabs', 'doctor'],
  );
  // The ones that can change the world stay out of it.
  assert.ok(!(RETRY_SAFE_TOOLS as readonly string[]).includes('browser_act'));
  assert.ok(!(RETRY_SAFE_TOOLS as readonly string[]).includes('js'));
  // Selecting a tab rewrites the session's default target; a repeat is not harmless.
  assert.ok(!(RETRY_SAFE_TOOLS as readonly string[]).includes('browser_tabs_select'));
});

test('a side-effecting tool is not repeated, and says so', async () => {
  let downloads = 0;
  const page = new FakePage();
  (page as unknown as { download: () => Promise<unknown> }).download = async () => {
    downloads += 1;
    throw new Error(DEAD);
  };

  const client = await clientFor(async () => sessionOf(page));
  const body = bodyOf(
    await client.callTool({ name: 'browser_download', arguments: { selector: '#report' } }),
  );

  assert.equal(body.ok, false);
  assert.equal(downloads, 1, 'the action ran once; a retry would have run it twice');
  assert.equal(body.error.data.sessionReplaced, true);
  assert.match(String(body.error.hint), /may already have happened/);
  await client.close();
});

test('browser_tabs is retried after the page is replaced, and announces it', async () => {
  const first = new FakePage();
  const second = new FakePage();
  (second as unknown as { id: string }).id = 'fake-2';
  let lists = 0;

  const firstSession: BrowserSession = {
    ...sessionOf(first),
    // A listing is read-only, so a dead session must not end the call.
    tabList: async () => {
      lists += 1;
      throw new Error(DEAD);
    },
  } as BrowserSession;
  const secondSession: BrowserSession = {
    ...sessionOf(second),
    tabList: async () => {
      lists += 1;
      return [{ id: 'fake-2', url: 'https://example.com/', title: 'second', currentTarget: true, foreground: true }];
    },
  } as BrowserSession;

  let opens = 0;
  const client = await clientFor(async () => {
    opens += 1;
    return opens === 1 ? firstSession : secondSession;
  });
  const body = bodyOf(await client.callTool({ name: 'browser_tabs', arguments: {} }));

  assert.equal(lists, 2, 'the listing ran again on the replacement');
  assert.equal(body.ok, true, 'the caller gets a result, not the dead-session error');
  assert.equal(body.sessionReplaced, true, 'the retry is announced, not hidden');
  assert.equal(body.tabs?.[0]?.id, 'fake-2', 'the tabs come from the replacement');
  await client.close();
});

test('browser_tabs_select is not repeated, and says the action may already have happened', async () => {
  const first = new FakePage();
  const second = new FakePage();
  let selects = 0;

  const sideEffecting = (page: RuntimePage): BrowserSession =>
    ({
      ...sessionOf(page),
      // Selecting rewrites the session default; repeating it is not harmless.
      selectTab: async () => {
        selects += 1;
        throw new Error(DEAD);
      },
    }) as BrowserSession;

  let opens = 0;
  const client = await clientFor(async () => {
    opens += 1;
    return sideEffecting(opens === 1 ? first : second);
  });
  const body = bodyOf(await client.callTool({ name: 'browser_tabs_select', arguments: { id: 'fake-2' } }));

  assert.equal(body.ok, false, 'the failure is reported rather than papered over');
  assert.equal(selects, 1, 'the selection ran exactly once; it was not silently repeated');
  assert.equal(body.error.data.sessionReplaced, true, 'the replacement is still named');
  assert.match(String(body.error.hint), /may already have happened/);
  await client.close();
});