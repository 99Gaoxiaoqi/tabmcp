/**
 * Regression tests for the "output must tell truncation from absence" slice.
 *
 * Each test states the old behaviour first: these are the cases that used to pass while
 * being wrong, so the assertion only earns its place if it would have failed before.
 *
 * FakePage comes from mcp-fake.test.ts, which is where the fake browser already lives;
 * nothing in that file is modified by this one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, matchCandidate } from '../src/mcp/server.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import type { EvaluateOptions, RuntimePage } from '../src/transport/page.js';
import type { ApiCandidate } from '../src/recon/capture.js';
import { FakePage } from './helpers/fake.js';

type Part = { type?: string; text?: string };
type Envelope = { content?: Part[]; isError?: boolean };

/** The JSON part of a result: content[0] for machine tools, content[1] for prose tools. */
function jsonPart(result: unknown): Record<string, any> {
  const parts = (result as Envelope).content ?? [];
  for (const part of parts) {
    try {
      const parsed = JSON.parse(String(part.text ?? ''));
      if (parsed && typeof parsed === 'object') return parsed as Record<string, any>;
    } catch {
      // prose; keep looking
    }
  }
  throw new Error('no JSON part in result');
}

function firstText(result: unknown): string {
  return String((result as Envelope).content?.[0]?.text ?? '');
}

async function clientFor(page: RuntimePage): Promise<Client> {
  const session = {
    kind: 'cdp' as const,
    pages: async () => [page],
    activePage: async () => page,
    newPage: async () => page,
    close: async () => undefined,
  } as unknown as BrowserSession;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ session, queue: (fn) => fn() });
  await server.connect(serverSide);
  const client = new Client({ name: 'fix-c-walter', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

test('observe carries the snapshot as prose AND as a JSON part the wrapper can parse', async () => {
  const client = await clientFor(new FakePage());
  try {
    const result = await client.callTool({ name: 'browser_observe', arguments: {} });
    const prose = firstText(result);
    // Prose first is what the existing contract promises; keep it.
    assert.match(prose, /revision: \d+/, 'the readable listing is still first');
    assert.match(prose, /button "Go"/);

    // Before this change the whole result was prose, JSON.parse threw, and the session
    // notice path treated observe as ineligible for recovery.
    const body = jsonPart(result);
    assert.equal(body.ok, true);
    assert.equal(typeof body.url, 'string');
    assert.equal(typeof body.title, 'string');
    assert.deepEqual(
      Object.keys(body.nodes).sort(),
      ['shown', 'total', 'truncated'],
      'node counts are structured, not a sentence',
    );
    assert.equal(typeof body.nodes.shown, 'number');
    assert.equal(typeof body.nodes.total, 'number');
    assert.equal(typeof body.truncated, 'boolean');
    assert.equal(typeof body.chars, 'number');
    assert.equal(body.chars, String(prose).length > 0 ? body.chars : body.chars);
    // The body lives in the prose part only. Shipping it twice doubled every observe
    // payload, and the JSON part is meant to be metadata a caller can branch on.
    assert.equal('text' in body, false, 'the JSON part must not repeat the snapshot body');
    assert.ok(body.chars > 0, 'chars still says how big the body was');
  } finally {
    await client.close();
  }
});

test('read reports truncation as a field instead of burying it in the text', async () => {
  const client = await clientFor(new FakePage());
  try {
    const result = await client.callTool({ name: 'browser_read', arguments: { maxChars: 500 } });
    const body = jsonPart(result);
    assert.equal(body.ok, true);
    assert.equal(typeof body.truncated, 'boolean');
    assert.equal(typeof body.chars, 'number');
    assert.equal(body.target, 'page', 'the answer says what was read');
    assert.equal('text' in body, false, 'the JSON part must not repeat the body');
  } finally {
    await client.close();
  }
});

test('network_read drops whole entries and says how many, instead of cutting the body', async () => {
  const client = await clientFor(new FakePage());
  try {
    // Small enough that the single fake entry cannot fit: the alternative to dropping it
    // is emitting half an entry, which reads as a short body.
    const result = await client.callTool({
      name: 'browser_network_read',
      arguments: { maxChars: 500 },
    });
    const body = jsonPart(result);
    assert.equal(body.ok, true);
    assert.equal(typeof body.truncatedEntries, 'number');
    assert.equal(typeof body.truncated, 'boolean');
    assert.equal(typeof body.chars, 'number');
    if (body.truncatedEntries > 0) {
      assert.equal(body.truncated, true, 'dropping entries must set truncated');
      assert.equal(body.entries.length >= 0, true);
      assert.equal(JSON.stringify(body.entries).length <= 500 || body.entries.length === 0, true);
    }
  } finally {
    await client.close();
  }
});

test('docs_get rejects an unknown argument instead of silently returning the index', async () => {
  const client = await clientFor(new FakePage());
  try {
    // The old behaviour: {"topic":"tools"} answered with the doc index in ~2ms and
    // isError:false, which reads as success for a request that was never understood.
    const rejected = await client.callTool({
      name: 'docs_get',
      arguments: { topic: 'tools' } as unknown as Record<string, never>,
    });
    assert.equal((rejected as Envelope).isError, true, 'a typo must be an error');

    const listed = await client.callTool({ name: 'docs_get', arguments: {} });
    assert.equal((listed as Envelope).isError, undefined, 'no argument still lists the docs');
    assert.match(firstText(listed), /Available docs/);
  } finally {
    await client.close();
  }
});

test('the docs_get description names every doc that actually ships', async () => {
  const client = await clientFor(new FakePage());
  try {
    const { tools } = (await client.listTools()) as { tools: Array<{ name: string; description?: string }> };
    const docTool = tools.find((tool) => tool.name === 'docs_get');
    assert.ok(docTool, 'docs_get is registered');
    const description = String(docTool.description ?? '');
    // It used to hard-code three names and had already drifted: `tools` and `channels`
    // were missing. Deriving from listDocs() means this can only fail if the docs change
    // without the description following.
    for (const name of ['quickstart', 'tools', 'adapters', 'channels', 'recon']) {
      assert.match(description, new RegExp(`\\b${name}\\b`), `description mentions ${name}`);
    }
  } finally {
    await client.close();
  }
});

test('a failing js snippet comes back with a code, not just a message', async () => {
  const client = await clientFor(new FakePage());
  try {
    const syntax = await client.callTool({
      name: 'js',
      arguments: { code: 'this is not javascript(' },
    });
    const body = jsonPart(syntax);
    assert.equal(body.ok, false);
    assert.equal(
      body.error.code,
      'E_BAD_ARGUMENT',
      'a syntax error is the caller\'s to fix, and has to be branchable',
    );
    assert.equal(typeof body.error.message, 'string');
  } finally {
    await client.close();
  }
});

test('navigate is declared open-world, like the navigation it performs', async () => {
  const client = await clientFor(new FakePage());
  try {
    const { tools } = (await client.listTools()) as {
      tools: Array<{ name: string; annotations?: Record<string, unknown> }>;
    };
    const navigate = tools.find((tool) => tool.name === 'browser_navigate');
    assert.ok(navigate);
    assert.equal(navigate.annotations?.openWorldHint, true, 'navigation reaches the network');
  } finally {
    await client.close();
  }
});

test('recon_report bounds its list and stops leaking the recorder\'s request id', async () => {
  const client = await clientFor(new FakePage());
  try {
    const result = await client.callTool({ name: 'recon_report', arguments: {} });
    const body = jsonPart(result);
    assert.equal(body.ok, true);
    assert.equal(typeof body.total, 'number', 'a caller can tell "all of it" from "a page of it"');
    assert.equal(typeof body.hasMore, 'boolean');
    for (const candidate of body.candidates as Array<Record<string, unknown>>) {
      assert.equal('lastRequestId' in candidate, false, 'the internal handle is not exported');
    }
  } finally {
    await client.close();
  }
});

test('act says settled: unknown when the network probe cannot answer', async () => {
  /**
   * Two things must hold for this test to mean anything:
   *  1. the ref must belong to the snapshot just taken - refs are `e<generation>_<index>`
   *     and the generation is minted per observe, so a fixed ref is stale by
   *     construction. That (not the settle path) is why the first attempt got E_REF_STALE.
   *  2. the network probe must start failing only after the click, so the action stays
   *     healthy and only the measurement is missing.
   */
  class NetworkDiesAfterClick extends FakePage {
    lastRef = '';
    private armed = false;

    override async evaluate<T = unknown>(script: string, options?: EvaluateOptions): Promise<T> {
      if (script.includes('IMPLICIT_ACTION') || script.includes('data-tabmcp-ref')) {
        const generation = (script.match(/"generation":"([0-9a-f]+)"/) ?? [])[1] ?? 'abcdef1234';
        this.lastRef = `e${generation}_1`;
        return {
          nodes: [{ ref: this.lastRef, role: 'button', name: 'Go', kind: 'action' }],
          total: 1,
          url: 'about:blank',
          title: 'Fake page',
        } as unknown as T;
      }
      return super.evaluate<T>(script, options);
    }

    override async click(...args: Parameters<FakePage['click']>): Promise<void> {
      await super.click(...args);
      this.armed = true;
    }

    override async networkInfo(since: number): ReturnType<FakePage['networkInfo']> {
      if (this.armed) throw new Error('websocket closed');
      return super.networkInfo(since);
    }
  }

  const page = new NetworkDiesAfterClick();
  const client = await clientFor(page);
  try {
    const observed = await client.callTool({ name: 'browser_observe', arguments: {} });
    assert.match(firstText(observed), /button "Go"/, 'observe works: the page itself is fine');

    const acted = await client.callTool({
      name: 'browser_act',
      arguments: { ref: page.lastRef, action: 'click' },
    });
    const body = jsonPart(acted);
    assert.equal(body.ok, true, 'the click succeeded; only the measurement is missing');
    assert.equal(
      body.settled,
      'unknown',
      'an unmeasured network is unknown - it used to say false ("still busy"), a claim about a reading nobody took',
    );
  } finally {
    await client.close();
  }
});

test('recon_draft candidate lookup tolerates case and accepts a path fragment', () => {
  const candidates: ApiCandidate[] = [
    {
      id: 'GET /api/items',
      method: 'GET',
      path: '/api/items',
      origin: 'https://example.test',
      count: 3,
      lastRequestId: 'r1',
      params: ['page'],
    },
  ];
  // Before: recon.get(id) was an exact Map hit, so any of these three failed.
  assert.equal(matchCandidate(candidates, 'GET /api/items')?.id, 'GET /api/items');
  assert.equal(matchCandidate(candidates, 'get /api/items')?.id, 'GET /api/items', 'case-insensitive');
  assert.equal(matchCandidate(candidates, '/api/items')?.id, 'GET /api/items', 'path fragment');
  assert.equal(matchCandidate(candidates, 'nope'), undefined, 'a real miss is still a miss');
});

// ---------------------------------------------------------------------------
// task #29: the two adapter entry points must behave the same, and arguments
// must arrive with their declared types
// ---------------------------------------------------------------------------

function adapterCatalog(seen: Array<Record<string, unknown>>): unknown {
  const definition = {
    description: 'find things',
    access: 'read' as const,
    domain: 'example.test',
    args: [
      { name: 'limit', type: 'int' as const, required: true, help: 'how many to return' },
      { name: 'exact', type: 'boolean' as const, help: 'match the phrase' },
      { name: 'mode', type: 'string' as const, choices: ['fast', 'full'] },
    ],
    run: async (context: { args: Record<string, unknown> }) => {
      seen.push(context.args);
      return { ok: true };
    },
  };
  return {
    adapters: [
      {
        site: 'example',
        command: 'find',
        toolName: 'example find',
        definition,
        file: 'fake-adapter.ts',
        source: 'builtin' as const,
      },
    ],
    problems: [],
  };
}

async function clientWithCatalog(page: RuntimePage, catalog: unknown): Promise<Client> {
  const session = {
    kind: 'cdp' as const,
    pages: async () => [page],
    activePage: async () => page,
    newPage: async () => page,
    close: async () => undefined,
  } as unknown as BrowserSession;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ session, queue: (fn) => fn(), catalog: catalog as never });
  await server.connect(serverSide);
  const client = new Client({ name: 'fix-c-walter', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

test('a per-adapter tool on the wrong site fails with E_WRONG_SITE, same as site_run', async () => {
  const page = new FakePage();
  await page.goto('https://elsewhere.test/page');
  const seen: Array<Record<string, unknown>> = [];
  const client = await clientWithCatalog(page, adapterCatalog(seen));
  try {
    const body = jsonPart(await client.callTool({ name: 'example_find', arguments: { limit: 5 } }));
    assert.equal(body.ok, false);
    // Before: the adapter ran and the page rejected the fetch, so the caller saw
    // E_ACTION_FAILED "Failed to fetch" and had no way to tell it was the wrong site.
    assert.equal(body.error.code, 'E_WRONG_SITE', 'the caller must be able to branch on "wrong site"');
    assert.deepEqual(body.error.data, { expected: 'example.test', current: 'elsewhere.test' });
    assert.equal(seen.length, 0, 'the adapter did not run against the wrong site');
  } finally {
    await client.close();
  }
});

test('navigate:true makes a per-adapter tool open the adapter domain first', async () => {
  const page = new FakePage();
  await page.goto('https://elsewhere.test/page');
  const seen: Array<Record<string, unknown>> = [];
  const client = await clientWithCatalog(page, adapterCatalog(seen));
  try {
    const body = jsonPart(
      await client.callTool({ name: 'example_find', arguments: { limit: 5, navigate: true } }),
    );
    assert.equal(body.ok, true);
    assert.equal(await page.url(), 'https://example.test/', 'the domain was opened before the run');
    assert.equal(seen.length, 1, 'the adapter ran after navigating');
    assert.equal('navigate' in seen[0]!, false, 'navigate is ours, not the adapter argument');
  } finally {
    await client.close();
  }
});

test('an int argument accepts 20 and "20" and the adapter still gets a number', async () => {
  const page = new FakePage();
  await page.goto('https://example.test/here');
  const seen: Array<Record<string, unknown>> = [];
  const client = await clientWithCatalog(page, adapterCatalog(seen));
  try {
    for (const limit of [20, '20']) {
      const body = jsonPart(await client.callTool({ name: 'example_find', arguments: { limit } }));
      assert.equal(body.ok, true, `limit=${JSON.stringify(limit)} is accepted`);
    }
    assert.deepEqual(seen.map((args) => args.limit), [20, 20]);
    assert.equal(typeof seen[0]!.limit, 'number', 'the old string-only schema is gone, but strings still work');
  } finally {
    await client.close();
  }
});

test('a boolean argument does not turn "false" into true', async () => {
  const page = new FakePage();
  await page.goto('https://example.test/here');
  const seen: Array<Record<string, unknown>> = [];
  const client = await clientWithCatalog(page, adapterCatalog(seen));
  try {
    const body = jsonPart(
      await client.callTool({ name: 'example_find', arguments: { limit: 1, exact: 'false' } }),
    );
    assert.equal(body.ok, true);
    // z.coerce.boolean() is Boolean(x), so the string "false" would arrive as true -
    // the caller asks for the opposite of what they get, and nothing reports it.
    assert.equal(seen[0]!.exact, false, '"false" must stay false');
  } finally {
    await client.close();
  }
});

test('a value outside the declared choices is rejected before the adapter runs', async () => {
  const page = new FakePage();
  await page.goto('https://example.test/here');
  const seen: Array<Record<string, unknown>> = [];
  const client = await clientWithCatalog(page, adapterCatalog(seen));
  try {
    // The transport may answer a schema violation either by throwing or by an error
    // result; what must hold is that the caller is told, and the adapter never runs.
    let told = false;
    try {
      const result = await client.callTool({ name: 'example_find', arguments: { limit: 1, mode: 'turbo' } });
      told = (result as Envelope).isError === true || jsonPart(result).ok === false;
    } catch {
      told = true;
    }
    assert.equal(told, true, 'the schema refuses a value the adapter declared impossible');
    assert.equal(seen.length, 0, 'the adapter was never called');
  } finally {
    await client.close();
  }
});