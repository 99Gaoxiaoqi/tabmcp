import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { placeDownload } from '../src/core/downloads.js';

async function capturedFile(content = 'tabmcp download probe: 1234567890\n'): Promise<{ dir: string; captured: { filename: string; bytes: number; path: string } }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabmcp-dl-'));
  // What Playwright hands back: a random name, no extension.
  const file = path.join(dir, 'e32eb654-0cb3-4fe0-bca2-ee9dbc3a2020');
  await fs.writeFile(file, content);
  return { dir, captured: { filename: 'probe.txt', bytes: content.length, path: file } };
}

test('without dir the capture is returned untouched', async () => {
  const { captured } = await capturedFile();
  const result = await placeDownload(captured);
  assert.deepEqual(result, captured);
});

test('with dir the file lands under its real name, with the real bytes', async () => {
  const { captured } = await capturedFile();
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'tabmcp-dest-'));

  const result = await placeDownload(captured, { dir: target });
  assert.equal(result.filename, 'probe.txt');
  assert.equal(result.path, path.join(target, 'probe.txt'));
  assert.equal(result.bytes, 34);

  const written = await fs.readFile(String(result.path), 'utf8');
  assert.equal(written, 'tabmcp download probe: 1234567890\n');

  // The point of copying: it must not be the temporary file any more.
  assert.notEqual(result.path, captured.path);
  await fs.rm(String(captured.path));
  assert.equal((await fs.stat(String(result.path))).size, 34, 'the copy outlives the capture');
});

test('dir is created when it does not exist', async () => {
  const { captured } = await capturedFile();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tabmcp-new-'));
  const target = path.join(root, 'a', 'b');

  const result = await placeDownload(captured, { dir: target });
  assert.equal(result.path, path.join(target, 'probe.txt'));
  assert.equal((await fs.stat(String(result.path))).size, 34);
});

test('filename overrides the suggested name, and unsafe characters are replaced', async () => {
  const { captured } = await capturedFile();
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'tabmcp-name-'));

  const result = await placeDownload(captured, { dir: target, filename: '../bad:name?.csv' });
  assert.equal(result.filename, '.._bad_name_.csv'.replace(/^\.+/, ''));
  assert.equal(path.dirname(String(result.path)), target, 'the copy stays inside dir');
});

test('a capture with no temporary file says so instead of pretending', async () => {
  await assert.rejects(placeDownload({ filename: 'probe.txt', bytes: 34 }, { dir: os.tmpdir() }), /no temporary file/);
});
