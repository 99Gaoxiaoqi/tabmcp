/**
 * Broker: the process that owns the browser connection.
 *
 * Chrome starts this as a native messaging host, so it lives as long as Chrome
 * wants to talk to it. MCP servers (spawned by an agent) connect to it over a
 * loopback socket instead of owning the browser themselves — that way several
 * agents can share one browser and the browser survives an agent restart.
 */

import { ActionError } from '../core/errors.js';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeFrame, FrameDecoder, type BrokerRequest, type BrokerResponse, type HostEvent, type HostRequest } from '../protocol.js';

export interface BrokerOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Directory for the port/token handshake file. */
  stateDir?: string;
  onLog?: (message: string) => void;
}

export interface ExtensionLink {
  request(request: HostRequest, timeoutMs?: number): Promise<unknown>;
  on(event: 'cdp', listener: (event: HostEvent) => void): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Owns the socket the MCP servers connect to, and forwards their requests to
 * the extension. One extension connection at a time; a reconnect replaces it.
 */
export class Broker {
  private server: net.Server | null = null;
  private link: ExtensionLink | null = null;
  private port = 0;
  private token = '';
  private readonly clients = new Set<net.Socket>();
  private readonly authorised = new Set<net.Socket>();
  /** One operation at a time per tab, across every connected session. */
  private readonly tabLocks = new Map<number, Promise<void>>();
  private readonly stateFile: string;
  private readonly log: (message: string) => void;
  private readonly onCdpListeners: Array<(event: HostEvent) => void> = [];

  constructor(private readonly options: BrokerOptions = {}) {
    this.log = options.onLog ?? (() => undefined);
    const dir = options.stateDir ?? path.join(os.tmpdir(), 'tabmcp');
    fs.mkdirSync(dir, { recursive: true });
    this.stateFile = path.join(dir, 'broker.json');
  }

  get listeningPort(): number {
    return this.port;
  }

  get stateFilePath(): string {
    return this.stateFile;
  }

  async start(): Promise<{ port: number; token: string }> {
    // Only one host may own the browser. After a service-worker restart Chrome
    // can spawn a second host while the first is still alive; a duplicate would
    // split the clients across two brokers, so the newcomer steps aside.
    if (await this.anotherHostIsLive()) {
      throw new DuplicateHostError(this.stateFile);
    }

    this.token = randomUUID();
    const server = net.createServer((socket) => this.handleClient(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    // The handshake file is the only way an MCP server learns port + token; it
    // is written 0600 so another local user cannot borrow the connection.
    fs.writeFileSync(this.stateFile, JSON.stringify({ port: this.port, token: this.token }), { mode: 0o600 });
    this.log(`broker listening on 127.0.0.1:${this.port}`);
    return { port: this.port, token: this.token };
  }

  attachExtension(link: ExtensionLink): void {
    this.link = link;
    link.on('cdp', (event) => {
      for (const listener of this.onCdpListeners) listener(event);
      // Events are how per-page network activity reaches MCP clients.
      const frame = encodeFrame({ event: 'cdp', tabId: event.tabId, method: event.method, params: event.params });
      for (const socket of this.authorised) {
        if (!socket.destroyed) socket.write(frame);
      }
    });
    this.log('extension attached');
  }

  detachExtension(): void {
    this.link = null;
    this.log('extension detached');
  }

  get hasExtension(): boolean {
    return this.link !== null;
  }

  onCdp(listener: (event: HostEvent) => void): void {
    this.onCdpListeners.push(listener);
  }

  /** Forwards one request to the extension, correlating by id and enforcing a timeout. */
  async call(request: HostRequest, timeoutMs = 30_000): Promise<unknown> {
    if (!this.link) throw new ActionError('E_BROWSER_DISCONNECTED', 'extension not connected', {
      hint: 'Open Chrome with the TabMCP extension loaded; it reconnects within a few seconds.',
    });
    return this.link.request(request, timeoutMs);
  }

  /**
   * Serialises work on one tab.
   *
   * Several agents can share one browser; without this two of them interleave
   * CDP commands on the same tab and each sees half of the other's action. User
   * tabs stay shared (they belong to the user), but work on them queues.
   */
  private async withTabLock<T>(tabId: number, work: () => Promise<T>): Promise<T> {
    const previous = this.tabLocks.get(tabId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.tabLocks.set(tabId, chained);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.tabLocks.get(tabId) === chained) this.tabLocks.delete(tabId);
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    this.authorised.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    fs.rmSync(this.stateFile, { force: true });
  }

  /** True only when another broker answers a request, not merely accepts a socket. */
  private async anotherHostIsLive(): Promise<boolean> {
    if (!fs.existsSync(this.stateFile)) return false;
    let port = 0;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { port?: number };
      port = parsed.port ?? 0;
    } catch {
      return false;
    }
    if (!port) return false;
    return await new Promise<boolean>((resolve) => {
      let answered = false;
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        // A live broker answers 'tabs' (possibly with an error). A socket left over
        // from a dead extension accepts the connection and never replies — that is a
        // stale port, and taking it over is the only way out.
        const payload = Buffer.from(JSON.stringify({ id: 1, method: 'tabs', params: {} }), 'utf8');
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32LE(payload.length, 0);
        socket.write(Buffer.concat([header, payload]));
      });
      socket.on('data', () => {
        answered = true;
        socket.destroy();
        resolve(true);
      });
      socket.setTimeout(700, () => {
        socket.destroy();
        resolve(answered);
      });
      socket.once('error', () => resolve(false));
    });
  }

  private handleClient(socket: net.Socket): void {
    this.clients.add(socket);
    const decoder = new FrameDecoder();
    let authorised = false;

    socket.on('data', (chunk) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        socket.destroy();
        return;
      }
      for (const raw of messages) {
        const message = raw as BrokerRequest & { token?: string };
        if (!authorised) {
          if (message.token !== this.token) {
            socket.destroy();
            return;
          }
          authorised = true;
          this.authorised.add(socket);
          if ((message as unknown as { method?: string }).method === 'auth') continue;
        }
        void this.handleBrokerRequest(socket, message);
      }
    });

    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.clients.delete(socket);
      this.authorised.delete(socket);
    });
  }

  private async handleBrokerRequest(socket: net.Socket, request: BrokerRequest): Promise<void> {
    const requestId = (request as { id: number }).id;
    const reply = (response: BrokerResponse) => {
      if (!socket.destroyed) socket.write(encodeFrame(response));
    };
    try {
      switch (request.method) {
        case 'tabs': {
          const tabs = await this.call({ id: nextId(), method: 'tabs.list', params: {} });
          reply({ id: request.id, result: tabs });
          return;
        }
        case 'create': {
          const tab = await this.call({ id: nextId(), method: 'tab.create', params: request.params });
          reply({ id: request.id, result: tab });
          return;
        }
        case 'close': {
          await this.call({ id: nextId(), method: 'tab.close', params: request.params });
          reply({ id: request.id, result: { closed: true } });
          return;
        }
        case 'cdp': {
          const result = await this.withTabLock(request.params.tabId, () =>
            this.call({
              id: nextId(),
              method: 'cdp.send',
              params: request.params,
            }),
          );
          reply({ id: request.id, result });
          return;
        }
        default: {
          reply({ id: requestId, error: { code: 'E_BAD_METHOD', message: `unknown method` } });
          return;
        }
      }
    } catch (err) {
      reply({ id: requestId, error: { code: 'E_BROKER', message: err instanceof Error ? err.message : String(err) } });
    }
  }
}

let counter = 0;
function nextId(): number {
  counter = (counter + 1) % 1_000_000;
  return counter;
}

/**
 * Extension side of the link, used by the native host process: correlates
 * responses to requests over the framed stdin/stdout pair.
 */
export class StdioExtensionLink implements ExtensionLink {
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: Array<(event: HostEvent) => void> = [];
  private readonly decoder = new FrameDecoder();

  constructor(
    private readonly write: (frame: Buffer) => void,
    private readonly timeoutMs = 30_000,
  ) {}

  on(_event: 'cdp', listener: (event: HostEvent) => void): void {
    this.listeners.push(listener);
  }

  request(request: HostRequest, timeoutMs = this.timeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`extension timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      this.write(encodeFrame(request));
    });
  }

  /** Feed chunks from the host's stdin. */
  ingest(chunk: Buffer): void {
    for (const raw of this.decoder.push(chunk)) {
      const message = raw as { id?: number; event?: string } & HostEvent;
      if (message.event === 'cdp') {
        for (const listener of this.listeners) listener(message as HostEvent);
        continue;
      }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        const response = message as unknown as { result?: unknown; error?: { message: string } };
        if (response.error) pending.reject(new Error(response.error.message));
        else pending.resolve(response.result);
      }
    }
  }
}

export { encodeFrame };

/** Thrown when a live broker already owns the browser. */
export class DuplicateHostError extends Error {
  constructor(stateFile: string) {
    super(`another host is already listening (state file: ${stateFile})`);
    this.name = 'DuplicateHostError';
  }
}


