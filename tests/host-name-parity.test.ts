import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isValidHostName } from '../src/host/install.js';

/**
 * One value, two readers: `src/host/install.ts` writes the registry key and the host
 * manifest, `scripts/generate-host-config.mjs` writes the extension's copy. If they
 * disagree about what a valid name is, a name gets installed and then refused by Chrome
 * at `connectNative` time - or `--check` fails on a config the installer happily used.
 *
 * The script has to run before the build, so its rule is inlined. This test is what keeps
 * the two copies from drifting: it feeds the same fixtures to both and requires the same
 * accept/reject decision, whatever the rule becomes.
 */

// Anchored to this file, not to the cwd: process.cwd() makes the same test run from
// the repository root and fail from dist/, and the failure reads as a disagreement
// between the two readers when the real cause is that the script was never found.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIXTURES: Array<{ value: unknown; why: string }> = [
  { value: 'com.local.tabmcp', why: 'the value this repository ships' },
  { value: 'acme.custom', why: 'two segments' },
  { value: 'com_acme', why: 'underscore' },
  { value: 'Com.Local', why: 'uppercase is not accepted by Chrome' },
  { value: 'com..local', why: 'consecutive dots' },
  { value: '.com.local', why: 'leading dot' },
  { value: 'com.local.', why: 'trailing dot' },
  { value: '   ', why: 'whitespace only' },
  { value: '', why: 'empty string' },
  { value: 'com local', why: 'a space' },
  { value: 123, why: 'a number' },
  { value: { a: 1 }, why: 'an object' },
  { value: null, why: 'null' },
];

test('the installer and the generator agree on every fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmcp-hostname-parity-'));
  // The script writes extension/host-config.js next to the config it reads.
  fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
  try {
    for (const fixture of FIXTURES) {
      fs.writeFileSync(path.join(dir, 'host.config.json'), JSON.stringify({ hostName: fixture.value }), 'utf8');
      let status: number;
      try {
        execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'generate-host-config.mjs')], {
          cwd: dir,
          stdio: 'pipe',
        });
        status = 0;
      } catch (error) {
        // "Could not run it" and "it rejected the value" are different facts. Folding the
        // first into the second makes the failure accuse a correct value of disagreeing
        // with the installer, when what actually failed was the fixture.
        const failure = error as { code?: string; status?: number; message?: string };
        if (failure.code === 'ENOENT' || typeof failure.status !== 'number') {
          assert.fail(`could not run the generator at ${path.join(REPO_ROOT, 'scripts', 'generate-host-config.mjs')}: ${failure.message}`);
        }
        status = failure.status;
      }
      // The script's contract: 0 accepts, 2 rejects as invalid, anything else is neither.
      assert.ok(
        status === 0 || status === 2,
        `the generator exited ${status} for ${JSON.stringify(fixture.value)}; expected 0 (accepted) or 2 (rejected)`,
      );
      const accepted = status === 0;
      assert.equal(
        accepted,
        isValidHostName(fixture.value),
        `the two readers disagree about ${JSON.stringify(fixture.value)} (${fixture.why})`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
