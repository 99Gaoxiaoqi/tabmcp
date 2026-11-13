import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { placeDownload } from '../src/core/downloads.js';

async function capturedFile(): Promise<{ captured: { filename: string; bytes: number; path: string }; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabmcp-err-'));
  const file = path.join(dir, 'e32eb654-0cb3-4fe0-bca2-ee9dbc3a2020');
  await fs.writeFile(file, 'tabmcp download probe: 1234567890\n');
  return { dir, captured: { filename: 'probe.txt', bytes: 34, path: file } };
}

test('a too-long file name is reported as a length problem, not a permission problem', async () => {
  const { captured } = await capturedFile();
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'tabmcp-long-'));

  const error = (await placeDownload(captured, { dir: target, filename: 'a'.repeat(296) + '.txt' }).catch(
    (err: unknown) => err,
  )) as { message: string; hint?: string; data?: Record<string, unknown> };

  // The message must not be the file name.
  assert.ok(error.message.length < 200, `message is ${error.message.length} chars: ${error.message.slice(0, 80)}`);
  assert.match(error.message, /\(300 chars\)/);
  assert.match(String(error.hint), /characters|length/);
  assert.match(String(error.hint), /shorter/);
  assert.equal(error.data?.stage, 'copy');
  assert.equal(error.data?.filenameLength, 300);
});

test('an unusable directory is reported as a directory problem, and the hint differs', async () => {
  const { captured } = await capturedFile();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tabmcp-blocked-'));
  // A file where the directory should be: mkdir cannot succeed.
  const blocker = path.join(root, 'file');
  await fs.writeFile(blocker, 'not a directory');

  const error = (await placeDownload(captured, { dir: path.join(blocker, 'deeper') }).catch(
    (err: unknown) => err,
  )) as { hint?: string; data?: Record<string, unknown> };

  assert.equal(error.data?.stage, 'mkdir');
  assert.match(String(error.hint), /could not be created/i);

  const longName = (await placeDownload(captured, {
    dir: root,
    filename: 'b'.repeat(296) + '.txt',
  }).catch((err: unknown) => err)) as { hint?: string };

  // The whole point: two different causes must not give the same instruction.
  assert.notEqual(error.hint, longName.hint);
});

test('a copy failure after a good mkdir is its own stage', async () => {
  const { captured } = await capturedFile();
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'tabmcp-copy-'));
  const missingSource = { ...captured, path: path.join(target, 'not-there') };

  const error = (await placeDownload(missingSource, { dir: target }).catch((err: unknown) => err)) as {
    hint?: string;
    data?: Record<string, unknown>;
  };
  assert.equal(error.data?.stage, 'copy');
  assert.match(String(error.hint), /writable/);
});
