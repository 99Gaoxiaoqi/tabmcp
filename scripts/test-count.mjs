#!/usr/bin/env node
/**
 * Guards the test suite's own surface.
 *
 * `node --test dist/tests/*.test.js` is a glob. A file that fails to compile simply
 * is not matched, so the suite gets smaller and still reports green: the number of
 * tests passing is the only signal, and nothing compares it to the number of tests
 * that were written. A stale artefact has the mirror problem - delete a test source
 * and `dist/` keeps running it until something cleans the directory.
 *
 * Three exit codes, three meanings:
 *   0  every test source has a built counterpart, and nothing else is built
 *   1  the two sides disagree (a test would silently not run, or would run from an
 *      orphaned artefact)
 *   2  the check cannot vouch for itself (a directory is missing, or is empty)
 *
 * No magic number: both sides are derived from the same tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(REPO_ROOT);

const TESTS_DIR = 'tests';
const DIST_DIR = path.join('dist', 'tests');
const TEST_SUFFIX = '.test.ts';
const BUILT_SUFFIX = '.test.js';

// Every failure goes to stderr, including a plain mismatch: a caller redirecting
// stdout should still see the reason on the failure path.
const fail = (code, lines) => {
  for (const line of lines) console.error(line);
  process.exit(code);
};

const listFiles = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    fail(2, [
      `cannot list ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      'run `npm run build` first - without a built suite there is nothing to count',
    ]);
  }
};

const sources = listFiles(TESTS_DIR);
const built = listFiles(DIST_DIR);

// A test written in anything but .test.ts never reaches dist/, so the runner never
// loads it. Saying so is the whole point: it is otherwise invisible.
const unrunnable = sources.filter((name) => !name.endsWith('.ts'));
if (unrunnable.length) {
  fail(1, [
    `not TypeScript, so it will never be compiled or run: ${unrunnable.join(', ')}`,
    `rename it to *${TEST_SUFFIX}, or move it out of ${TESTS_DIR}/ if it is a helper`,
  ]);
}

const testSources = sources.filter((name) => name.endsWith(TEST_SUFFIX));
if (testSources.length === 0) {
  fail(2, [`no *${TEST_SUFFIX} files in ${TESTS_DIR}/ - the check would otherwise pass on nothing`]);
}

const missing = testSources
  .map((name) => name.slice(0, -TEST_SUFFIX.length) + BUILT_SUFFIX)
  .filter((name) => !built.includes(name));
const empty = testSources
  .map((name) => name.slice(0, -TEST_SUFFIX.length) + BUILT_SUFFIX)
  .filter((name) => {
    if (!built.includes(name)) return false;
    try {
      return fs.statSync(path.join(DIST_DIR, name)).size === 0;
    } catch {
      return false;
    }
  });

const builtTests = built.filter((name) => name.endsWith(BUILT_SUFFIX));
const orphaned = builtTests.filter(
  (name) => !testSources.includes(name.slice(0, -BUILT_SUFFIX.length) + TEST_SUFFIX),
);

const problems = [
  ...missing.map((name) => `no ${path.join(DIST_DIR, name)} for its source (compile error, or not built)`),
  ...empty.map((name) => `${path.join(DIST_DIR, name)} is empty`),
  ...orphaned.map((name) => `${path.join(DIST_DIR, name)} has no source (stale: it still runs)`),
];
if (problems.length) fail(1, ['test surface mismatch:', ...problems.map((problem) => `  ${problem}`)]);

console.log(`test surface: ${testSources.length} sources == ${builtTests.length} built test files`);
