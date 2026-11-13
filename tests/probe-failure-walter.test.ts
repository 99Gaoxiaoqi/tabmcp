/**
 * task #41: `--probe` must fail like a diagnosis, not like a crash.
 *
 * The old behaviour, measured: `node dist/src/main.js --probe` with nothing listening on
 * the debugging port printed 18 lines beginning `node:internal/modules/run_main:123`,
 * with the actual fact ("connect ECONNREFUSED") on line 4 and no hint. A reader sees a
 * crashed program; the truth is "start a browser first".
 *
 * The anchor is this file, not `process.cwd()`: a test whose subject is the shell's
 * current directory reports a different result depending on where it was started.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs compiled, from dist/tests, so two levels up is the repository root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(REPO_ROOT, 'dist', 'src', 'main.js');

function runProbe(endpoint: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [ENTRY, '--probe'], {
    // Port 1 is closed on any normal machine, so this is a refused connection rather than
    // a slow one; the timeout only guards against the case where it is not.
    env: { ...process.env, BROWSER_ENDPOINT: endpoint },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('--probe names the missing browser instead of printing a stack', () => {
  const { status, output } = runProbe('http://127.0.0.1:1');
  assert.equal(status, 1, 'a failed probe still exits non-zero');
  assert.match(output, /E_BROWSER_DISCONNECTED/, 'the failure carries a code a caller can branch on');
  assert.match(output, /no browser is listening on http:\/\/127\.0\.0\.1:1/, 'it names the endpoint it tried');
  assert.match(output, /^hint: /m, 'it names the command that starts a browser');
});

test('--probe does not leak an uncaught-exception stack', () => {
  const { output } = runProbe('http://127.0.0.1:1');
  // Before the fix the output began with node's own frames.
  assert.equal(/node:internal/.test(output), false, 'no interpreter frames in a handled failure');
  assert.equal(/triggerUncaughtException/.test(output), false, 'the exception is caught, not thrown');
  assert.equal(/\n\s+at /.test(output), false, 'no stack frames');
});
