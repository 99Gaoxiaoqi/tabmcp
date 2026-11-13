import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ActionError } from '../src/core/errors.js';
import { install } from '../src/host/install.js';
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from '../src/protocol.js';

/**
 * Regression tests for task #26 ("a pass must be able to tell itself apart from
 * not looking"). Each case is written to fail against the previous version and pass
 * against this one; the two gate scripts are exercised as subprocesses inside a
 * throwaway git repository, because their surface comes from `git ls-files` and the
 * point is to prove what they do to a repository, not what a helper returns.
 */

const REPO_ROOT = process.cwd();

interface TempRepo {
  dir: string;
  run: (script: string) => { status: number | null; stdout: string; stderr: string };
}

/** A throwaway repository: the script under test, plus the files the case needs. */
const makeRepo = (script: string, files: Record<string, string>): TempRepo => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixd-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts', script), path.join(dir, 'scripts', script));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  // No commit, no branch: `git add` alone puts the files in the index, which is
  // exactly the set leak-scan reads. Never touches the shared workspace.
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['add', '-A']);
  return {
    dir,
    run: (name: string) => {
      const result = spawnSync(process.execPath, [path.join(dir, 'scripts', name)], {
        cwd: dir,
        encoding: 'utf8',
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
};

// ---------------------------------------------------------------- leak-scan

const LEAK = 'leak-scan.mjs';
const BASE_FILES = { 'package.json': '{}\n', 'src/app.ts': 'export const x = 1;\n' };

test('leak-scan: a clean repository exits 0 and reports what it scanned', () => {
  const repo = makeRepo(LEAK, BASE_FILES);
  const result = repo.run(LEAK);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local paths: 0 hits in \d+ files/);
  assert.match(result.stdout, /scan surface: \d+ candidates/);
});

test('leak-scan: lowercase drive letter is caught (matching used to be case-sensitive)', () => {
  const repo = makeRepo(LEAK, {
    ...BASE_FILES,
    'src/app.ts': 'export const p = "d:' + String.fromCharCode(92) + 'work' + String.fromCharCode(92) + 'x";\n',
  });
  const result = repo.run(LEAK);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /absolute drive path/);
});

test('leak-scan: a drive nobody thought of is caught (the old needle named three folders)', () => {
  const repo = makeRepo(LEAK, {
    ...BASE_FILES,
    'src/app.ts': 'export const p = "' + 'E:' + String.fromCharCode(92) + 'data' + String.fromCharCode(92) + 'y";\n',
  });
  assert.equal(repo.run(LEAK).status, 1);
});

test('leak-scan: .yml and .cmd are scanned (they were outside the extension allow-list)', () => {
  const bs = String.fromCharCode(92);
  const yml = makeRepo(LEAK, {
    ...BASE_FILES,
    '.github/workflows/verify.yml': `run: node ${'C:' + bs}Users${bs}maria${bs}x.js\n`,
  });
  assert.equal(yml.run(LEAK).status, 1, 'a tracked .yml was silently outside the scan');

  const cmd = makeRepo(LEAK, { ...BASE_FILES, 'scripts/build.cmd': `node ${'D:' + bs}work${bs}x.exe\n` });
  assert.equal(cmd.run(LEAK).status, 1, 'a tracked .cmd was silently outside the scan');
});

test('leak-scan: a URL is not a drive path', () => {
  const repo = makeRepo(LEAK, {
    ...BASE_FILES,
    'src/app.ts': 'export const a = "https://example.com/x"; export const b = "chrome://settings";\n',
  });
  assert.equal(repo.run(LEAK).status, 0);
});

test('leak-scan: an unclassified extension is an error, not a silent skip', () => {
  const repo = makeRepo(LEAK, { ...BASE_FILES, 'src/blob.zzz': `x = ${'D:'}${String.fromCharCode(92)}work` });
  const result = repo.run(LEAK);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /unclassified extensions/);
  assert.match(result.stderr, /\.zzz/);
});

test('leak-scan: a directory that contributes no candidate is an error', () => {
  const repo = makeRepo(LEAK, {
    ...BASE_FILES,
    '.gitignore': 'ignored-dir/\n',
    'ignored-dir/notes.md': 'nothing to see\n',
  });
  const result = repo.run(LEAK);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /ignored-dir.*contributes no candidate/s);
});

// ---------------------------------------------------------------- tool-count

const COUNT = 'tool-count.mjs';
const countFiles = (claim: number, source: string) => ({
  'README.md': `# t\n\n<!-- tool-count: ${claim} -->\n`,
  'src/mcp/server.ts': source,
});

test('tool-count: double quotes and backticks count as registrations', () => {
  // The old matcher was /registerTool\(\s*'([^']+)'/ - single quotes only, so this
  // repository reported "1 == 1" while the code registered two tools.
  const source = [
    "server.registerTool('one', {});",
    'server.registerTool("two", {});',
    'server.registerTool(`three`, {});',
  ].join('\n');
  const repo = makeRepo(COUNT, countFiles(3, source));
  const result = repo.run(COUNT);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /README\.md 3 == 3 literal registerTool names/);
});

test('tool-count: a mismatched count exits 1', () => {
  const repo = makeRepo(COUNT, countFiles(1, "server.registerTool('one', {});\nserver.registerTool('two', {});"));
  const result = repo.run(COUNT);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tool count mismatch/);
});

test('tool-count: an unexpected computed registration is an error, not a silent gap', () => {
  const source = [
    "server.registerTool('one', {});",
    'server.registerTool(toolName, {});',
    'server.registerTool(otherName, {});',
  ].join('\n');
  const repo = makeRepo(COUNT, countFiles(1, source));
  const result = repo.run(COUNT);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /unaccounted computed registrations: otherName/);
});

// ---------------------------------------------------------------- test-count

const TESTCOUNT = 'test-count.mjs';

test('test-count: a built test with no source is caught (it still runs)', () => {
  const repo = makeRepo(TESTCOUNT, {
    ...BASE_FILES,
    'tests/a.test.ts': "import test from 'node:test';\n",
    'dist/tests/a.test.js': "import test from 'node:test';\n",
    'dist/tests/orphan.test.js': "import test from 'node:test';\n",
  });
  const result = repo.run(TESTCOUNT);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /orphan\.test\.js has no source/);
});

test('test-count: a source with no built file is caught (it would silently not run)', () => {
  const repo = makeRepo(TESTCOUNT, {
    ...BASE_FILES,
    'tests/a.test.ts': "import test from 'node:test';\n",
    'tests/b.test.ts': "import test from 'node:test';\n",
    'dist/tests/a.test.js': "import test from 'node:test';\n",
  });
  const result = repo.run(TESTCOUNT);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /b\.test\.js/);
});

test('test-count: agreeing sides exit 0 and print both numbers', () => {
  const repo = makeRepo(TESTCOUNT, {
    ...BASE_FILES,
    'tests/a.test.ts': "import test from 'node:test';\n",
    'dist/tests/a.test.js': "import test from 'node:test';\n",
  });
  const result = repo.run(TESTCOUNT);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 sources == 1 built test files/);
});

// ---------------------------------------------------------------- frame errors

test('protocol: a frame over the limit carries a branchable code, not E_INTERNAL', () => {
  assert.throws(
    () => encodeFrame({ blob: 'x'.repeat(64) }, 16),
    (error: unknown) => {
      assert.ok(error instanceof ActionError);
      assert.equal(error.code, 'E_FRAME_TOO_LARGE');
      assert.equal((error.data as { direction?: string }).direction, 'encode');
      return true;
    },
  );
});

test('protocol: a peer announcing an oversized frame is distinguishable from a bug', () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
  assert.throws(
    () => new FrameDecoder().push(header),
    (error: unknown) => {
      assert.ok(error instanceof ActionError);
      assert.equal(error.code, 'E_FRAME_TOO_LARGE');
      assert.equal((error.data as { direction?: string }).direction, 'decode');
      return true;
    },
  );
});

// ---------------------------------------------------------------- install

test('install: a node path that does not exist fails here, not at first use', () => {
  const missing = path.join(os.tmpdir(), `no-such-node-${process.pid}-${Date.now()}.exe`);
  assert.throws(
    () =>
      install({
        extensionDir: path.join(os.tmpdir(), 'no-such-extension'),
        hostScript: path.join(os.tmpdir(), 'no-such-host.js'),
        extensionId: 'x'.repeat(32),
        nodePath: missing,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ActionError);
      assert.equal(error.code, 'E_BAD_ARGUMENT');
      assert.match(error.message, /does not exist/);
      return true;
    },
  );
});
