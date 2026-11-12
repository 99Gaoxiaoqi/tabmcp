/**
 * Broker tests: a fake extension link stands in for Chrome, so the socket
 * handshake, request routing and event fan-out are verified without a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Broker, type ExtensionLink } from '../src/host/broker.js';
import { encodeFrame, FrameDecoder, type HostEvent, type HostRequest } from '../src/protocol.js';

class FakeExtension implements ExtensionLink {
  readonly requests: HostRequest[] = [];
  private listeners: Array<(event: HostEvent) => void> = [];
  private id = 0;

  request(request: Omit<HostRequest, 'id'> | HostRequest): Promise<unknown> {
    this.requests.push(request as HostRequest);
    switch ((request as HostRequest).method) {
      case 'tabs.list':
        return Promise.resolve([{ tabId: 7, url: 'https://example.test/', title: 'Example', active: true }]);
      case 'tab.create':
        return Promise.resolve({ tabId: 8 });
      case 'cdp.send':
        return Promise.resolve({ echoed: (request as { params: { method: string } }).params.method });
      default:
        return Promise.resolve({ ok: true });
    }
  }

  on(_event: 'cdp', listener: (event: HostEvent) => void): void {
    this.listeners.push(listener);
  }

  emit(event: HostEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  nextId(): number {
    return ++this.id;
  }
}

interface Client {
  socket: net.Socket;
  request: (message: Record<string, unknown>) => Promise<unknown>;
  events: HostEvent[];
  close: () => void;
}

async function connectClient(port: number, token: string): Promise<Client> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const conn = net.createConnection({ host: '127.0.0.1', port }, () => resolve(conn));
    conn.once('error', reject);
  });
  const decoder = new FrameDecoder();
  const pending = new Map<number, (value: unknown) => void>();
  const events: HostEvent[] = [];
  socket.on('data', (chunk: Buffer) => {
    for (const raw of decoder.push(chunk)) {
      const message = raw as { id?: number } & HostEvent;
      if (message.event === 'cdp') {
        events.push(message);
        continue;
      }
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    }
  });
  socket.write(encodeFrame({ id: 0, method: 'auth', token }));
  let counter = 0;
  return {
    socket,
    request: (message) =>
      new Promise((resolve) => {
        const id = ++counter;
        pending.set(id, resolve);
        socket.write(encodeFrame({ ...message, id }));
      }),
    events,
    close: () => socket.destroy(),
  };
}

test('broker: handshake, tab listing, cdp relay and event fan-out', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmcp-broker-'));
  const broker = new Broker({ stateDir });
  const { port, token } = await broker.start();
  const extension = new FakeExtension();
  broker.attachExtension(extension);

  assert.ok(fs.existsSync(broker.stateFilePath), 'state file written');
  const state = JSON.parse(fs.readFileSync(broker.stateFilePath, 'utf8')) as { port: number; token: string };
  assert.equal(state.port, port);
  assert.equal(state.token, token);

  const client = await connectClient(port, token);
  try {
  const tabs = (await client.request({ method: 'tabs', params: {} })) as { id: number; result: Array<{ tabId: number }> };
  assert.equal(tabs.result[0]?.tabId, 7);

  const cdp = (await client.request({ method: 'cdp', params: { tabId: 7, method: 'Page.navigate' } })) as {
    result: { echoed: string };
  };
  assert.equal(cdp.result.echoed, 'Page.navigate');
  assert.ok(
    extension.requests.some((request) => request.method === 'cdp.send'),
    'extension received the cdp send',
  );

  extension.emit({ event: 'cdp', tabId: 7, method: 'Network.requestWillBeSent', params: { requestId: 'r1' } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(client.events.length, 1);
  assert.equal(client.events[0]?.method, 'Network.requestWillBeSent');
  } finally {
    client.close();
    await broker.close();
  }
});

test('broker: rejects a client with a wrong token', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmcp-broker-'));
  const broker = new Broker({ stateDir });
  const { port } = await broker.start();
  broker.attachExtension(new FakeExtension());

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const conn = net.createConnection({ host: '127.0.0.1', port }, () => resolve(conn));
    conn.once('error', reject);
  });
  socket.write(encodeFrame({ id: 1, method: 'auth', token: 'wrong' }));
  const closed = await new Promise<boolean>((resolve) => {
    socket.once('close', () => resolve(true));
    setTimeout(() => resolve(false), 1500);
  });
  assert.equal(closed, true, 'socket should be destroyed');
  await broker.close();
});

test('broker: reports missing extension instead of hanging', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmcp-broker-'));
  const broker = new Broker({ stateDir });
  const { port, token } = await broker.start();
  const client = await connectClient(port, token);
  const response = (await client.request({ method: 'tabs', params: {} })) as { error?: { code: string } };
  assert.equal(response.error?.code, 'E_BROKER');
  client.close();
  await broker.close();
});


test('broker: two sessions cannot interleave work on the same tab', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmcp-broker-'));
  const broker = new Broker({ stateDir });
  const { port, token } = await broker.start();

  const timeline: string[] = [];
  let active = 0;
  let maxActive = 0;
  broker.attachExtension({
    request: async (request) => {
      if ((request as { method: string }).method !== 'cdp.send') return { ok: true };
      active++;
      maxActive = Math.max(maxActive, active);
      timeline.push(`start:${(request as { params: { method: string } }).params.method}`);
      await new Promise((resolve) => setTimeout(resolve, 60));
      active--;
      timeline.push(`end:${(request as { params: { method: string } }).params.method}`);
      return { ok: true };
    },
    on: () => undefined,
  });

  const clientA = await connectClient(port, token);
  const clientB = await connectClient(port, token);
  try {
    await Promise.all([
      clientA.request({ method: 'cdp', params: { tabId: 42, method: 'A.first' } }),
      clientB.request({ method: 'cdp', params: { tabId: 42, method: 'B.second' } }),
    ]);
    assert.equal(maxActive, 1, `work overlapped: ${timeline.join(' ')}`);
    // Order between the two sessions is not defined; what matters is that each
    // operation finished before the next one started.
    assert.equal(timeline.length, 4, timeline.join(' '));
    for (let i = 0; i < timeline.length; i += 2) {
      assert.ok(timeline[i]!.startsWith('start:'), timeline.join(' '));
      assert.ok(timeline[i + 1]!.startsWith('end:'), timeline.join(' '));
      assert.equal(timeline[i]!.slice('start:'.length), timeline[i + 1]!.slice('end:'.length), timeline.join(' '));
    }
  } finally {
    clientA.close();
    clientB.close();
    await broker.close();
  }
});

test('broker: different tabs still run in parallel', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmcp-broker-'));
  const broker = new Broker({ stateDir });
  const { port, token } = await broker.start();
  let active = 0;
  let maxActive = 0;
  broker.attachExtension({
    request: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 60));
      active--;
      return { ok: true };
    },
    on: () => undefined,
  });
  const client = await connectClient(port, token);
  try {
    await Promise.all([
      client.request({ method: 'cdp', params: { tabId: 1, method: 'A' } }),
      client.request({ method: 'cdp', params: { tabId: 2, method: 'B' } }),
    ]);
    assert.equal(maxActive, 2, 'different tabs should not block each other');
  } finally {
    client.close();
    await broker.close();
  }
});

