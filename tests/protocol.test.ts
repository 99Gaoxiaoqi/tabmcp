/**
 * Protocol tests: framing is where native messaging silently breaks (partial
 * reads, merged messages, oversized frames), so it gets its own coverage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from '../src/protocol.js';

test('round-trips one frame', () => {
  const decoder = new FrameDecoder();
  const messages = decoder.push(encodeFrame({ id: 1, method: 'hello' }));
  assert.deepEqual(messages, [{ id: 1, method: 'hello' }]);
});

test('reassembles a frame split across chunks', () => {
  const frame = encodeFrame({ id: 2, method: 'tabs.list', params: {} });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(frame.subarray(3, 10)), []);
  assert.deepEqual(decoder.push(frame.subarray(10)), [{ id: 2, method: 'tabs.list', params: {} }]);
});

test('decodes two frames arriving in one chunk', () => {
  const decoder = new FrameDecoder();
  const chunk = Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 })]);
  assert.deepEqual(decoder.push(chunk), [{ id: 1 }, { id: 2 }]);
});

test('decodes a frame plus a partial next frame', () => {
  const full = encodeFrame({ id: 1 });
  const partial = encodeFrame({ id: 2 }).subarray(0, 5);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(Buffer.concat([full, partial])), [{ id: 1 }]);
});

test('survives a multi-byte payload split mid-character', () => {
  const frame = encodeFrame({ text: '中文测试' });
  const decoder = new FrameDecoder();
  const cut = 5;
  assert.deepEqual(decoder.push(frame.subarray(0, cut)), []);
  assert.deepEqual(decoder.push(frame.subarray(cut)), [{ text: '中文测试' }]);
});

test('refuses an oversized frame instead of allocating it', () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
  assert.throws(() => new FrameDecoder().push(header), /frame too large/);
});
