import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostConfigCandidates, readHostName } from '../src/host/install.js';

/**
 * Where the host name is read from decides whether the answer is the package's value
 * or an invention. Two failure shapes are pinned here:
 *
 *  1. A cwd-relative lookup lets a stray `host.config.json` in an unrelated directory
 *     win over the repository's own - one checkout, two host names, depending on where
 *     the command was run.
 *  2. A hardcoded fallback when nothing is readable. Nothing errors, so the host gets
 *     registered under a name no caller uses, and the symptom is the one this
 *     repository keeps meeting: the extension is listed, nothing reports a problem, and
 *     every call fails.
 *
 * The walk and the reading are tested as functions of their inputs - a URL, a list of
 * paths - so a path containing spaces, CJK or a UNC prefix can be exercised on any CI
 * without building such a checkout. Only the wiring to this module's own location needs
 * the real filesystem, and that is the last test.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL_JS = path.join(REPO_ROOT, 'dist', 'src', 'host', 'install.js');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tabmcp-hostname-'));
}

test('the walk is decided by the module URL, including paths a URL keeps encoded', () => {
  // Percent-encoding and UNC are ordinary on the machines this ships to, and neither
  // shows up on an ASCII CI unless it is stated here. The URLs are built from parts so
  // this file contains no absolute local path: there is no real one to point at, and
  // leak-scan is right to treat a bare drive path as suspicious.
  const drive = 'D:';
  const cjk = hostConfigCandidates(pathToFileURL(path.join(drive, '我的项目', 'dist', 'src', 'host', 'install.js')).href);
  assert.deepEqual(cjk, [
    path.join(drive, '我的项目', 'host.config.json'),
    path.join(drive, '我的项目', 'dist', 'host.config.json'),
  ]);

  const spaced = hostConfigCandidates(pathToFileURL(path.join('C:', 'Users', 'me', 'My Work', 'tabmcp', 'dist', 'src', 'host', 'install.js')).href);
  assert.equal(spaced[0], path.join('C:', 'Users', 'me', 'My Work', 'tabmcp', 'host.config.json'));

  const unc = hostConfigCandidates('file://server/share/tabmcp/dist/src/host/install.js');
  assert.equal(unc[0], path.join('\\\\server\\share', 'tabmcp', 'host.config.json'));
});

test('a valid config is used and the walk stops there', () => {
  const dir = tempDir();
  try {
    const good = path.join(dir, 'host.config.json');
    fs.writeFileSync(good, JSON.stringify({ hostName: 'com.acme.CUSTOM' }), 'utf8');
    const { name, looked } = readHostName([path.join(dir, 'nope.json'), good]);
    assert.equal(name, 'com.acme.CUSTOM');
    // Looking is reported in the order it happened, not as a design-time list.
    assert.deepEqual(looked, [{ path: path.join(dir, 'nope.json'), result: 'missing' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('"found but unusable" is a different sentence from "not found"', () => {
  const dir = tempDir();
  try {
    const broken = path.join(dir, 'broken.json');
    const empty = path.join(dir, 'empty.json');
    const missing = path.join(dir, 'missing.json');
    fs.writeFileSync(broken, '{ not json', 'utf8');
    fs.writeFileSync(empty, JSON.stringify({ other: 1 }), 'utf8');

    assert.throws(
      () => readHostName([missing, broken]),
      (error: unknown) => {
        const err = error as { message: string; data?: { looked?: unknown } };
        assert.match(err.message, /could not be parsed/, 'a broken file must not be reported as missing');
        assert.deepEqual(err.data?.looked, [
          { path: missing, result: 'missing' },
          { path: broken, result: 'unreadable' },
        ]);
        return true;
      },
    );

    assert.throws(
      () => readHostName([empty]),
      (error: unknown) => {
        const err = error as { message: string; data?: { looked?: unknown } };
        assert.match(err.message, /no hostName/);
        assert.deepEqual(err.data?.looked, [{ path: empty, result: 'no-hostName' }]);
        return true;
      },
    );

    assert.throws(
      () => readHostName([missing]),
      (error: unknown) => {
        assert.match((error as Error).message, /was not found/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the package reports its own name whatever directory the process started in', () => {
  const expected = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'host.config.json'), 'utf8')) as { hostName: string })
    .hostName;
  const code = `import(${JSON.stringify(pathToFileURL(INSTALL_JS).href)}).then((m) => process.stdout.write(m.hostName()));`;

  const decoyDir = tempDir();
  fs.writeFileSync(path.join(decoyDir, 'host.config.json'), JSON.stringify({ hostName: 'com.example.DECOY' }), 'utf8');
  try {
    const fromDecoy = execFileSync(process.execPath, ['-e', code], { cwd: decoyDir, encoding: 'utf8' }).trim();
    assert.equal(fromDecoy, expected, 'a config in the working directory must not rename the host');
  } finally {
    fs.rmSync(decoyDir, { recursive: true, force: true });
  }

  const fromRoot = execFileSync(process.execPath, ['-e', code], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const fromDist = execFileSync(process.execPath, ['-e', code], { cwd: path.join(REPO_ROOT, 'dist'), encoding: 'utf8' }).trim();
  assert.equal(fromDist, fromRoot, 'the name must not depend on where the process started');
});
