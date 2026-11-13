import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The launcher must not outlive the host it starts.
 *
 * Chrome keeps the native messaging pipe open for as long as the launcher process
 * lives. So a launcher that stays blocked on `stdin.Read` after its node child dies
 * looks, from Chrome's side, like a perfectly healthy host - Chrome never respawns
 * one and the extension can never reconnect. The defect is invisible in the UI: the
 * extension is still listed, nothing errors, and every call simply fails.
 *
 * Seen on a real machine: two `native-host.exe` processes on an install that looked
 * connected, with zero node children between them.
 *
 * The premise below is the shape of the bug - stdin is a pipe nobody writes to and
 * nobody closes - so nothing except the child's own exit can end the process.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAUNCHER = path.join(REPO_ROOT, 'native-host.exe');
// The launcher is a build artifact and git-ignored, so a clean checkout has none.
// Skipping is honest here only because the skip message names the command that
// makes these tests real - and because the anchor is this file, not the process
// cwd: `process.cwd()` made the same command exit 0 with the test skipped from
// `dist/` and run from the repository root, which is the silent shape of a guard
// that has stopped guarding.
const NOT_BUILT = !fs.existsSync(LAUNCHER)
  ? 'native-host.exe is not built here; npm run build:launcher makes this test real'
  : false;

function run(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(LAUNCHER, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('launcher outlived its host: still running after 10s'));
    }, 10_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

test('the launcher exits when the host it started exits, rather than holding the pipe open', { skip: NOT_BUILT }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmcp-launcher-exit-'));
  const script = path.join(dir, 'exits-immediately.mjs');
  fs.writeFileSync(script, 'process.exit(0);\n');
  const result = await run([process.execPath, script]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.code, 0, 'a host that exited cleanly is not a launcher failure');
});
