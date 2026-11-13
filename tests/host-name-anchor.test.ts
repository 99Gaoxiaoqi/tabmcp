import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The host name is read from host.config.json, and where that file is looked up
 * decides whether the answer is the repository's value or an invention.
 *
 * Two failure shapes are pinned here:
 *
 *  1. A cwd-relative lookup lets a stray `host.config.json` in an unrelated
 *     directory win over the repository's own - same checkout, two host names,
 *     depending on where the command was run.
 *  2. A hardcoded fallback ("com.local.tabmcp") when nothing is readable. Nothing
 *     errors, so the host gets registered under a name no caller uses, and the
 *     symptom is the one this repository keeps meeting: the extension is listed,
 *     nothing reports a problem, and every call fails.
 *
 * The first test makes the disagreement visible: it runs the built module with a
 * decoy config in the cwd and asserts the package's own value wins.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL_JS = path.join(REPO_ROOT, 'dist', 'src', 'host', 'install.js');

function readName(cwd: string): string {
  // A Windows path is not an import specifier: ESM wants a file:// URL, and a bare
  // drive-letter path gives ERR_UNSUPPORTED_ESM_URL_SCHEME instead of the value under test.
  const code = `import(${JSON.stringify(pathToFileURL(INSTALL_JS).href)}).then((m) => process.stdout.write(m.HOST_NAME));`;
  return execFileSync(process.execPath, ['-e', code], { cwd, encoding: 'utf8' }).trim();
}

test('the host name comes from the package, not from a host.config.json in the cwd', () => {
  const expected = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'host.config.json'), 'utf8')) as { hostName: string })
    .hostName;
  const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmcp-hostname-decoy-'));
  fs.writeFileSync(
    path.join(decoyDir, 'host.config.json'),
    JSON.stringify({ hostName: 'com.example.DECOY' }),
    'utf8',
  );
  try {
    assert.equal(readName(decoyDir), expected, 'a config in the working directory must not rename the host');
  } finally {
    fs.rmSync(decoyDir, { recursive: true, force: true });
  }
});

test('the same name is reported from the repository root and from a subdirectory', () => {
  const fromRoot = readName(REPO_ROOT);
  const fromDist = readName(path.join(REPO_ROOT, 'dist'));
  assert.equal(fromDist, fromRoot, 'the name must not depend on where the process started');
});
