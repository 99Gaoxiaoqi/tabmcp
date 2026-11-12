/**
 * MCP layer test with a fake transport.
 *
 * The browser-backed test is skipped when no Chrome is listening; that would
 * leave the MCP plumbing untested on a plain machine. This runs everywhere: a
 * FakePage answers the injected scripts, so tool registration, argument
 * validation, the response envelope and the error envelope are all exercised.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import type { EvaluateOptions, NavigationResult, RuntimePage, ScreenshotOptions } from '../src/transport/page.js';
import type { NetworkInfo } from '../src/core/activity.js';

class FakePage implements RuntimePage {
  readonly id = 'fake-1';
  private currentUrl = 'about:blank';
  private visible = true;
  private closed = false;

  async url(): Promise<string> {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return 'Fake page';
  }

  async goto(url: string): Promise<NavigationResult> {
    this.currentUrl = url;
    return { url, status: 200 };
  }

  async evaluate<T = unknown>(script: string, _options?: EvaluateOptions): Promise<T> {
    // The activity probe: a quiet, complete document.
    if (script.includes('__tabmcp_activity__')) {
      return { docId: 'doc-fake', url: this.currentUrl, ready: 'complete', mutations: 5, idleMs: 400 } as unknown as T;
    }
    // Snapshot collection: one interactive button.
    if (script.includes('IMPLICIT_ACTION') || script.includes('data-tabmcp-ref')) {
      return {
        nodes: [{ ref: 'eabcdef1234_1', role: 'button', name: 'Go', kind: 'action' }],
        total: 1,
        url: this.currentUrl,
        title: 'Fake page',
      } as unknown as T;
    }
    // Page text.
    if (script.includes('innerText')) {
      return 'fake body text' as unknown as T;
    }
    return true as unknown as T;
  }

  async click(): Promise<void> {
    this.visible = true;
  }
  async fill(): Promise<void> {}
  async press(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async hover(): Promise<void> {}
  async scrollIntoView(): Promise<void> {}

  async waitForSelector(): Promise<void> {
    if (!this.visible) throw new Error('element is not visible');
  }

  async waitForNavigation(): Promise<boolean> {
    return false;
  }

  async screenshot(_options: ScreenshotOptions): Promise<Buffer> {
    return Buffer.from('fake-png');
  }

  async networkInfo(_since: number): Promise<NetworkInfo> {
    return { pending: 0, idleMs: 500 };
  }

  async cookie(name: string): Promise<string | undefined> {
    return name === 'csrf' ? 'token-123' : undefined;
  }

  async fetchJson<T = unknown>(url: string): Promise<T> {
    return { url, echoed: true } as unknown as T;
  }

  async find(target: { role?: string }): Promise<Array<{ ref: string; role: string; name: string }>> {
    const hit = [{ ref: 'eabcdef1234_1', role: 'button', name: 'Go' }];
    return target.role ? hit.filter((entry) => entry.role === target.role) : hit;
  }

  async expect(): Promise<{ ok: boolean; waitedMs: number }> {
    return { ok: true, waitedMs: 0 };
  }

  isClosed(): boolean {
    return this.closed;
  }

  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>> {
    return [{ index: 0, frameId: 'main', url: this.currentUrl, name: '' }];
  }

  async evaluateInFrame(_target: { index?: number; frameId?: string }, script: string): Promise<unknown> {
    return this.evaluate(script);
  }

  async reload(): Promise<void> {}
  async back(): Promise<void> {}
  async forward(): Promise<void> {}
  async cookies(): Promise<Array<{ name: string; value: string; domain: string }>> {
    return [{ name: 'csrf', value: 'token-123', domain: 'example.test' }];
  }
  async download(): Promise<{ filename?: string }> {
    return { filename: 'report.csv' };
  }
  async contentState(): Promise<'ready' | 'empty' | 'placeholder' | 'unknown'> {
    return 'ready';
  }
  async networkRead(): Promise<{ cursor: number; entries: Array<Record<string, unknown>>; hasMore: boolean }> {
    return { cursor: 1, entries: [{ sequence: 1, method: 'GET', url: 'https://example.test/api/items', status: 200 }], hasMore: false };
  }

  retention: 'deliverable' | 'handoff' | null = null;
  async markDeliverable(): Promise<void> {
    this.retention = 'deliverable';
  }
  async markHandoff(): Promise<void> {
    this.retention = 'handoff';
  }
  async clearRetention(): Promise<void> {
    this.retention = null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSession implements BrowserSession {
  readonly kind = 'extension' as const;
  private readonly page = new FakePage();
  async pages(): Promise<RuntimePage[]> {
    return [this.page];
  }
  async activePage(): Promise<RuntimePage> {
    return this.page;
  }
  async newPage(): Promise<RuntimePage> {
    return this.page;
  }
  async close(): Promise<void> {}
}

async function connectFake(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({
    session: new FakeSession(),
    queue: (fn) => fn(),
  });
  await server.connect(serverSide);
  const client = new Client({ name: 'fake-client', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

function textOf(result: unknown): string {
  const content = ((result as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>;
  return content.find((part) => part.type === 'text')?.text ?? '';
}

test('fake transport: tools are registered with schemas', async () => {
  const client = await connectFake();
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        'browser_act',
        'browser_cookies',
        'browser_download',
        'browser_goto',
        'browser_navigate',
        'browser_network_read',
        'browser_observe',
        'browser_read',
        'browser_screenshot',
        'docs_get',
        'doctor',
        'js',
        'js_reset',
        'recon_draft',
        'recon_report',
        'recon_start',
        'site_run',
        'sites_search',
      ],
    );
    for (const tool of tools.tools) assert.ok(tool.inputSchema, `${tool.name} has an input schema`);
  } finally {
    await client.close();
  }
});

test('fake transport: goto and observe return the documented envelope', async () => {
  const client = await connectFake();
  try {
    const nav = await client.callTool({ name: 'browser_goto', arguments: { url: 'https://example.test/' } });
    const navText = textOf(nav);
    assert.match(navText, /"ok": true/);
    assert.match(navText, /example\.test/);

    const observed = await client.callTool({ name: 'browser_observe', arguments: { maxNodes: 50 } });
    const observedText = textOf(observed);
    assert.match(observedText, /revision: \d+/);
    assert.match(observedText, /button "Go"/);
  } finally {
    await client.close();
  }
});

test('fake transport: invalid arguments fail validation instead of crashing', async () => {
  const client = await connectFake();
  try {
    let rejected = false;
    try {
      await client.callTool({ name: 'browser_goto', arguments: { url: 42 as unknown as string } });
    } catch {
      rejected = true;
    }
    const result = await client.callTool({ name: 'browser_act', arguments: { ref: 'not-a-ref', action: 'click' } });
    const body = textOf(result);
    // A malformed ref must come back as a branchable error, not a thrown crash.
    assert.match(body, /E_REF_(INVALID|STALE)/);
    assert.ok(rejected || body.length > 0);
  } finally {
    await client.close();
  }
});




test('fake transport: js tool keeps bindings and returns the last expression', async () => {
  const client = await connectFake();
  try {
    const first = await client.callTool({ name: "js", arguments: { code: "const rows = [1,2,3]; rows.length" } });
    assert.match(textOf(first), /"value": 3/);

    const second = await client.callTool({ name: "js", arguments: { code: "rows.map((n) => n * 2)" } });
    assert.deepEqual(JSON.parse(textOf(second)).value, [2, 4, 6]);

    const reset = await client.callTool({ name: "js_reset", arguments: {} });
    assert.match(textOf(reset), /"cleared"/);

    const afterReset = await client.callTool({ name: "js", arguments: { code: "typeof rows" } });
    assert.match(textOf(afterReset), /undefined/);
  } finally {
    await client.close();
  }
});

test('fake transport: js tool can reach the tab facade', async () => {
  const client = await connectFake();
  try {
    const result = await client.callTool({ name: "js", arguments: { code: "await tab.title()" } });
    assert.match(textOf(result), /Fake page/);
  } finally {
    await client.close();
  }
});


test('fake transport: doctor reports transport, tab, adapters and repl', async () => {
  const client = await connectFake();
  try {
    await client.callTool({ name: "js", arguments: { code: "const x = 1;" } });
    const report = await client.callTool({ name: "doctor", arguments: {} });
    const body = JSON.parse(textOf(report));
    assert.equal(body.ok, true);
    assert.equal(body.transport, "extension");
    assert.equal(body.tabs, 1);
    assert.equal(body.activeTab.retention, null);
    assert.equal(body.repl.bound, 1);
    assert.ok(body.adapters && typeof body.adapters.count === "number");
  } finally {
    await client.close();
  }
});


