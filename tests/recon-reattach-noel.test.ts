/**
 * Recon across a full-page navigation.
 *
 * The failure this pins down: `Network.enable` and the three listeners belong to one
 * CDP session on one page target. A full navigation can replace the target, after
 * which the session never emits again - without throwing. The recorder downstream
 * then reports `requests: 0`, which reads exactly like "this page made no requests".
 *
 * Two things must hold, and they are tested separately:
 *   1. after a main-frame navigation, events flow again (a new session was opened);
 *   2. when re-attaching is impossible, the report says so (`attachLost`) instead of
 *      falling back to a quiet zero.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';
import { NetworkTap, type TapPage, type TapSession } from '../src/recon/network-tap.js';
import type { BrowserSession } from '../src/transport/cdp.js';
import type { RuntimePage } from '../src/transport/page.js';

type Event = { method: string; params?: Record<string, unknown> };

/** A CDP session that stops delivering the moment the page navigates, like the real one. */
class FlakySession implements TapSession {
  detached = false;
  private readonly handlers = new Map<string, (params: unknown) => void>();

  constructor(private readonly alive: () => boolean) {}

  async send(method: string): Promise<unknown> {
    if (!this.alive()) throw new Error(`session is dead (send ${method})`);
    return {};
  }

  on(method: string, handler: (params: unknown) => void): void {
    this.handlers.set(method, handler);
  }

  async detach(): Promise<void> {
    this.detached = true;
  }

  emit(method: string, params: Record<string, unknown>): void {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`no handler for ${method}`);
    handler(params);
  }
}

/** A page whose target is replaced by `navigate()`, killing whichever session was live. */
class FlakyPage implements TapPage {
  readonly sessions: FlakySession[] = [];
  /** Set before navigation to make the next attach throw. */
  failNextAttach = false;
  private generation = 0;
  private readonly navHandlers: Array<(frame: { parentFrame(): unknown | null }) => void> = [];

  constructor(private readonly onNewSession?: (session: FlakySession) => void) {}

  url(): string {
    return 'https://example.test/';
  }

  isClosed(): boolean {
    return false;
  }

  context(): { newCDPSession(page: never): Promise<TapSession> } {
    return {
      newCDPSession: async (): Promise<TapSession> => {
        if (this.failNextAttach) {
          this.failNextAttach = false;
          throw new Error('Target closed');
        }
        const generation = this.generation;
        const session = new FlakySession(() => generation === this.generation);
        this.sessions.push(session);
        this.onNewSession?.(session);
        return session;
      },
    };
  }

  on(event: 'framenavigated', handler: (frame: { parentFrame(): unknown | null }) => void): void {
    assert.equal(event, 'framenavigated');
    this.navHandlers.push(handler);
  }

  /** Replace the target: old sessions die, main-frame navigation fires. */
  async navigate(): Promise<void> {
    this.generation++;
    for (const handler of this.navHandlers) handler({ parentFrame: () => null });
    await settle();
  }

  /** A sub-frame navigation must not cost a new session. */
  async navigateSubframe(): Promise<void> {
    for (const handler of this.navHandlers) handler({ parentFrame: () => ({}) });
    await settle();
  }
}

async function settle(): Promise<void> {
  // Let queued attach work (promise chains) run to completion.
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
}

test('a main-frame navigation opens a new session and events resume', async () => {
  const page = new FlakyPage();
  const seen: Event[] = [];
  const tap = new NetworkTap((event) => seen.push(event));

  await tap.ensureAttached(page);
  assert.equal(page.sessions.length, 1, 'first attach opens one session');

  page.sessions[0].emit('Network.requestWillBeSent', { requestId: '1', request: { url: 'https://example.test/a' } });
  assert.equal(seen.length, 1);

  await page.navigate();
  assert.equal(page.sessions.length, 2, 'navigation must re-attach, not reuse the dead session');
  assert.equal(page.sessions[0].detached, true, 'the dead session is detached, not leaked');

  page.sessions[1].emit('Network.requestWillBeSent', { requestId: '2', request: { url: 'https://example.test/b' } });
  assert.equal(seen.length, 2, 'events after the navigation must still reach the listener');
  assert.deepEqual(tap.state(), { attachLost: false, lostAtSequence: null });
});

test('a sub-frame navigation does not open a second session', async () => {
  const page = new FlakyPage();
  const tap = new NetworkTap(() => undefined);

  await tap.ensureAttached(page);
  await page.navigateSubframe();
  assert.equal(page.sessions.length, 1);
});

test('when re-attaching fails the gap is reported with the sequence it started at', async () => {
  const page = new FlakyPage();
  const tap = new NetworkTap(() => undefined);

  await tap.ensureAttached(page);
  page.sessions[0].emit('Network.requestWillBeSent', { requestId: '1' });

  page.failNextAttach = true;
  await page.navigate();

  assert.deepEqual(tap.state(), { attachLost: true, lostAtSequence: 1 });
  const diagnostics = tap.diagnostics();
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].error, /Target closed/);

  // Recovery clears the flag but keeps the boundary: "the hole started at 1".
  await tap.reattach(page);
  assert.deepEqual(tap.state(), { attachLost: false, lostAtSequence: 1 });
});

// ---------------------------------------------------------------- the tool surface

class ReconSession implements BrowserSession {
  readonly kind = 'cdp' as const;
  private listener: ((event: Event) => void) | null = null;
  lost: { attachLost: boolean; lostAtSequence: number | null } | undefined = {
    attachLost: false,
    lostAtSequence: null,
  };

  onNetworkEvent(listener: (event: Event) => void): void {
    // Deliberately appends: a second registration here is a real double count, and
    // this fake is where that would show up.
    const previous = this.listener;
    this.listener = previous
      ? (event) => {
          previous(event);
          listener(event);
        }
      : listener;
  }

  networkTapState(): { attachLost: boolean; lostAtSequence: number | null } | undefined {
    return this.lost;
  }

  emit(event: Event): void {
    this.listener?.(event);
  }

  async pages(): Promise<RuntimePage[]> {
    throw new Error('not needed');
  }

  async activePage(): Promise<RuntimePage> {
    throw new Error('not needed');
  }

  async newPage(): Promise<RuntimePage> {
    throw new Error('not needed');
  }

  async close(): Promise<void> {}
}

async function connectWith(session: BrowserSession): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ session, queue: (fn) => fn() });
  await server.connect(serverSide);
  const client = new Client({ name: 'recon-test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

function bodyOf(result: unknown): Record<string, unknown> {
  const content = ((result as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.find((part) => part.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

test('recon_report always carries attachLost, and a lost stream never reads as a quiet zero', async () => {
  const session = new ReconSession();
  const client = await connectWith(session);
  try {
    await client.callTool({ name: 'recon_start', arguments: {} });
    session.emit({ method: 'Network.requestWillBeSent', params: { requestId: '1', request: { url: 'https://example.test/api/items', method: 'GET' }, type: 'Fetch' } });

    const healthy = bodyOf(await client.callTool({ name: 'recon_report', arguments: {} }));
    // The field is present on a healthy run: a caller must not have to branch on
    // "does this key exist" to find out whether the transport can tell it anything.
    assert.equal(healthy.attachLost, false);
    assert.equal(healthy.lostAtSequence, null);
    assert.equal(healthy.requests, 1);

    session.lost = { attachLost: true, lostAtSequence: 1 };
    const lost = bodyOf(await client.callTool({ name: 'recon_report', arguments: {} }));
    assert.equal(lost.attachLost, true);
    assert.equal(lost.lostAtSequence, 1);
    // The gap must not be laundered into "the page made no requests".
    assert.equal(lost.requests, 1);
  } finally {
    await client.close();
  }
});

test('a transport that cannot observe its own stream still reports the field', async () => {
  const session = new ReconSession();
  session.lost = undefined;
  const client = await connectWith(session);
  try {
    const body = bodyOf(await client.callTool({ name: 'recon_report', arguments: {} }));
    assert.equal(Object.hasOwn(body, 'attachLost'), true);
    assert.equal(body.attachLost, false);
    assert.equal(body.lostAtSequence, null);
  } finally {
    await client.close();
  }
});
