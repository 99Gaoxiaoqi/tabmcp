/**
 * MV3 service worker: the bridge between Chrome tabs and the native host.
 *
 * Responsibilities, deliberately narrow:
 *   - keep one native messaging port open, reconnecting if it drops;
 *   - forward CDP commands to chrome.debugger and their events back;
 *   - answer tab listing/creation.
 *
 * No page logic lives here: the service worker can be killed at any time, so
 * all state that matters belongs to the host.
 */

const HOST_NAME = 'com.local.browsermcp_core';

let port = null;
let nextFrameId = 1;
const attached = new Set();

function encodeFrame(message) {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, true);
  frame.set(payload, 4);
  return frame;
}

function decodeFrames(buffer) {
  const bytes = new Uint8Array(buffer);
  const messages = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
    if (offset + 4 + length > bytes.length) break;
    const payload = bytes.subarray(offset + 4, offset + 4 + length);
    messages.push(JSON.parse(new TextDecoder().decode(payload)));
    offset += 4 + length;
  }
  return { messages, rest: bytes.subarray(offset) };
}

let leftover = new Uint8Array(0);

function ensurePort() {
  if (!port) connect();
  return Boolean(port);
}

function send(message) {
  if (!port && !ensurePort()) return false;
  port.postMessage(message);
  return true;
}

function connect() {
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    console.error('[bmcp] connectNative failed', err);
    port = null;
    return;
  }
  port.onMessage.addListener((message) => {
    void handleFromHost(message);
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    if (error) console.warn('[bmcp] native port closed:', error.message);
    port = null;
    attached.clear();
  });
  send({ id: 0, method: 'hello', params: { extensionVersion: chrome.runtime.getManifest().version } });
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// Keep the worker warm while a debugger session is attached: MV3 idles out after
// 30s, which would otherwise drop long agent operations.
chrome.alarms.create('bmcp-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  ensurePort();
  if (attached.size > 0) void chrome.runtime.getPlatformInfo();
});

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    // The service worker can be recycled while Chrome keeps the debugger
    // session; that is "already attached", not a failure.
    const message = err instanceof Error ? err.message : String(err);
    if (!/already attached|another debugger/i.test(message)) throw err;
  }
  attached.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => undefined);
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable').catch(() => undefined);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable').catch(() => undefined);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== 'number') return;
  if (!/^(Network\.|Page\.frame|Page\.loadEvent|Runtime\.executionContext)/.test(method)) return;
  send({ event: 'cdp', tabId: source.tabId, method, params });
});

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === 'number') attached.delete(source.tabId);
});

async function handleFromHost(message) {
  if (!message || typeof message.id !== 'number' || typeof message.method !== 'string') return;
  const { id, method, params } = message;
  try {
    switch (method) {
      case 'hello':
        send({ id, result: { ok: true } });
        return;
      case 'tabs.list': {
        const tabs = await chrome.tabs.query({});
        send({
          id,
          result: tabs
            .filter((tab) => typeof tab.id === 'number' && !tab.url?.startsWith('chrome-extension://'))
            .map((tab) => ({ tabId: tab.id, url: tab.url ?? '', title: tab.title ?? '', active: Boolean(tab.active) })),
        });
        return;
      }
      case 'tab.create': {
        const tab = await chrome.tabs.create({ url: params?.url ?? 'about:blank', active: params?.active ?? true });
        // Group agent-created tabs so a person can see which tabs the agent owns.
        // Best-effort: grouping is unavailable on some Chrome builds and profiles.
        if (tab.id !== undefined) {
          try {
            const existing = await chrome.tabGroups.query({ title: 'BrowserMCP' });
            const groupId = existing.length
              ? await chrome.tabs.group({ tabIds: [tab.id], groupId: existing[0].id })
              : await chrome.tabs.group({ tabIds: [tab.id] });
            await chrome.tabGroups.update(groupId, { title: 'BrowserMCP', color: 'blue', collapsed: false });
          } catch {
            /* cosmetic only */
          }
        }
        send({ id, result: { tabId: tab.id } });
        return;
      }
      case 'tab.close': {
        await chrome.tabs.remove(params.tabId);
        attached.delete(params.tabId);
        send({ id, result: { closed: true } });
        return;
      }
      case 'cdp.send': {
        await ensureAttached(params.tabId);
        const result = await chrome.debugger.sendCommand({ tabId: params.tabId }, params.method, params.params ?? {});
        send({ id, result: result ?? {} });
        return;
      }
      case 'tab.attach': {
        await ensureAttached(params.tabId);
        send({ id, result: { attached: true } });
        return;
      }
      case 'tab.detach': {
        await chrome.debugger.detach({ tabId: params.tabId }).catch(() => undefined);
        attached.delete(params.tabId);
        send({ id, result: { attached: false } });
        return;
      }
      default:
        send({ id, error: { code: 'E_UNKNOWN_METHOD', message: `unknown method ${method}` } });
        return;
    }
  } catch (err) {
    send({ id, error: { code: 'E_EXTENSION', message: err instanceof Error ? err.message : String(err) } });
  }
}

export const __internal = { encodeFrame, decodeFrames, nextFrameId, leftover };

