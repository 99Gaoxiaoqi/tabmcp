/**
 * Tests for scripts/build-completeness.mjs.
 *
 * The positive case is cheap: the real tree is green. The interesting half is the
 * negative control - a tree where an artifact has been deleted. Without that, a
 * script that only stat()s the dist directory would pass these tests too, and the
 * gate would be decoration.
 *
 * Fixtures are built in %TEMP% and thrown away, so nothing here touches the shared
 * working tree.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-completeness.mjs');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A minimal build output: each entry is a path under dist/, mapped to its contents. */
function makeTree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildcomplete-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return dir;
}

// ------------------------------------------------------------------ the real tree

test('the real build output has no unresolved relative imports', () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /build completeness: \d+ compiled modules, \d+ relative imports, 0 unresolved/);
});

// -------------------------------------------------------------- negative controls

test('an artifact deleted from the output is reported, not tolerated', () => {
  // This is the failure that motivated the gate: install.js is present, the module it
  // imports is not, and tsc was happy.
  const tree = makeTree({
    'dist/src/host/install.js': "import { a } from '../shared/hostname.mjs';\nexport const x = a;\n",
  });
  const result = run(['--root', tree]);
  assert.equal(result.status, 1, 'a missing artifact is a finding, not an inability to check');
  assert.match(result.stderr, /1 relative import\(s\) point at files that are not in the build output/);
  assert.match(result.stderr, /dist[\\/]src[\\/]host[\\/]install\.js -> \.\.\/shared\/hostname\.mjs/);
});

test('deleting the file that the import needs turns the same tree green or red, and nothing else', () => {
  // Paired with the test above: add the missing file and the identical tree must pass.
  // Without this pair, the red could be caused by anything in the fixture.
  const present = makeTree({
    'dist/src/host/install.js': "import { a } from '../shared/hostname.mjs';\nexport const x = a;\n",
    'dist/src/shared/hostname.mjs': 'export const a = 1;\n',
  });
  const missing = makeTree({
    'dist/src/host/install.js': "import { a } from '../shared/hostname.mjs';\nexport const x = a;\n",
  });
  assert.equal(run(['--root', present]).status, 0);
  assert.equal(run(['--root', missing]).status, 1);
});

test('every entry that goes missing is named, not just the first', () => {
  const tree = makeTree({
    'dist/src/a.js': "import './b.js';\nimport './c.js';\n",
  });
  const result = run(['--root', tree]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /-> \.\/b\.js/);
  assert.match(result.stderr, /-> \.\/c\.js/);
  assert.match(result.stderr, /2 relative import\(s\)/);
});

test('a tree with no dist at all is "could not check", not "found nothing"', () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'buildcomplete-'));
  const result = run(['--root', tree]);
  assert.equal(result.status, 2, 'nothing to check is not the same as nothing wrong');
  assert.match(result.stderr, /does not exist/);
  assert.match(result.stderr, /npm run build/);
});

test('an output directory with no compiled modules is exit 2, never a pass', () => {
  // An empty dist/ would otherwise print "0 unresolved" and exit 0 - the exact shape
  // of a check that reports success without looking at anything.
  const tree = makeTree({ 'dist/src/.keep': '' });
  const result = run(['--root', tree]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no compiled \.js or \.mjs files/);
});

test('scratch files at the dist root are out of scope', () => {
  // dist/ collects local probe scripts that the compiler never emits. A gate that
  // scanned them could be turned red by debris nobody shipped, and a gate that cries
  // wolf gets ignored.
  const tree = makeTree({
    'dist/src/ok.js': 'export const a = 1;\n',
    'dist/probe-scratch.mjs': "import './a-file-that-does-not-exist.mjs';\n",
  });
  const result = run(['--root', tree]);
  assert.equal(result.status, 0, 'only the compiler output is in scope');
});

// ------------------------------------------------------------ the matcher itself

test('the matcher finds relative specifiers and ignores everything else', async () => {
  // A gate is only as good as what it looks at. If this matcher missed a form, the
  // gate would report "0 unresolved" while never having looked at that import.
  const module = (await import(pathToFileURL(SCRIPT).href)) as {
    relativeSpecifiers: (source: string) => string[];
  };
  const source = [
    "import { a } from './a.js';",
    "export { b } from './b.js';",
    "import './c.js';",
    "const d = require('./d.js');",
    "import fs from 'node:fs';",
    "import pkg from '@scope/pkg';",
    "import type { T } from './types.js';",
    "const dynamic = await import('./e.js');",
  ].join('\n');
  const found = module.relativeSpecifiers(source);
  for (const expected of ['./a.js', './b.js', './c.js', './d.js', './types.js']) {
    assert.ok(found.includes(expected), `expected ${expected} in ${JSON.stringify(found)}`);
  }
  assert.ok(!found.includes('node:fs'), 'builtins are not files to resolve');
  assert.ok(!found.includes('@scope/pkg'), 'packages are not files to resolve');
});
