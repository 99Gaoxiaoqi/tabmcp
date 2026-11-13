/**
 * Wire protocol between the Chrome extension and the native host.
 *
 * Chrome native messaging frames each message with its byte length as a 32-bit
 * little-endian integer, then JSON. We use the same shape on both ends so the
 * extension can forward frames without knowing about JSON boundaries.
 */

import { ActionError } from './core/errors.js';

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface StartFrame {
  byteLength: number;
}

/** Extension -> host. */
export type HostRequest =
  | { id: number; method: 'hello'; params: { extensionVersion: string } }
  | { id: number; method: 'tabs.list'; params: Record<string, never> }
  | { id: number; method: 'tab.create'; params: { url?: string; active?: boolean } }
  | { id: number; method: 'tab.close'; params: { tabId: number } }
  | { id: number; method: 'cdp.send'; params: { tabId: number; method: string; params?: Record<string, unknown> } }
  | { id: number; method: 'tab.attach'; params: { tabId: number } }
  | { id: number; method: 'tab.detach'; params: { tabId: number } };

/** Host -> extension. */
export type HostResponse =
  | { id: number; result: unknown }
  | { id: number; error: { code: string; message: string } };

/** Extension -> host, unsolicited. */
export interface HostEvent {
  event: 'cdp';
  tabId: number;
  method: string;
  params?: Record<string, unknown>;
}

/** Host -> MCP server over the local socket. */
export type BrokerRequest =
  | { id: number; method: 'tabs'; params: Record<string, never> }
  | { id: number; method: 'create'; params: { url?: string } }
  | { id: number; method: 'close'; params: { tabId: number } }
  | { id: number; method: 'cdp'; params: { tabId: number; method: string; params?: Record<string, unknown> } };

export type BrokerResponse =
  | { id: number; result: unknown }
  | { id: number; error: { code: string; message: string } };

export interface BrokerEvent {
  event: 'cdp';
  tabId: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
}

/** Encodes one native-messaging frame. */
export function encodeFrame(message: unknown, maxBytes: number = MAX_FRAME_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.byteLength > maxBytes) {
    throw new ActionError('E_FRAME_TOO_LARGE', `frame too large: ${payload.byteLength} bytes`, {
      hint: 'The payload exceeds the native-messaging limit. Send less per message, or split it.',
      data: { direction: 'encode', bytes: payload.byteLength, max: maxBytes },
    });
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Incremental frame parser: feed it whatever the stream produced, get whole
 * messages back. Never assume a chunk is a message.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages: unknown[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new ActionError('E_FRAME_TOO_LARGE', `frame too large: ${length} bytes`, {
          hint: 'The peer announced a frame beyond the limit. The stream is out of sync; reconnect it.',
          data: { direction: 'decode', bytes: length, max: MAX_FRAME_BYTES },
        });
      }
      if (this.buffer.length < 4 + length) break;
      const payload = this.buffer.subarray(4, 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);
      messages.push(JSON.parse(payload));
    }
    return messages;
  }
}
