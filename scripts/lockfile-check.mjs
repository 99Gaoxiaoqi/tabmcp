#!/usr/bin/env node
/**
 * package.json and package-lock.json must describe the same dependency set.
 *
 * Why this is a gate and not a habit: local `npm install` silently repairs a stale
 * lockfile, so a developer never sees the mismatch. CI runs `npm ci`, which refuses
 * to repair anything and fails on the mismatch instead. The result is a commit that
 * passes every local check and fails on the first machine that installs from scratch.
 *
 * Read-only by design: it parses two JSON files. It never runs npm, so it cannot
 * touch node_modules - an earlier incident in this repository emptied a shared
 * node_modules directory, and no verification step should have that power.
 *
 * Three exit codes, three meanings:
 *   0  the two files describe the same set
 *   1  they disagree, and the message names what disagrees
 *   2  the check cannot vouch for the result (a file is missing or unparseable)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(REPO_ROOT);

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const MIN_LOCKFILE_VERSION = 2;

const fail = (lines, code = 2) => {
  for (const line of lines) console.error(line);
  process.exit(code);
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail([`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`]);
  }
};

/** Sorted [name, spec] pairs, so a comparison cannot depend on key order. */
const specMap = (manifest, field) => {
  const value = manifest?.[field] ?? {};
  return Object.keys(value)
    .sort()
    .map((name) => [name, String(value[name])]);
};

/**
 * Compare one dependency field's [name, spec] pairs and return the names that differ:
 * present on one side only, or carrying a different spec on each side.
 */
const comparePairs = (a, b) => {
  const left = new Map(a);
  const right = new Map(b);
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  return names.filter((name) => left.get(name) !== right.get(name));
};
const probe = comparePairs(
  [
    ['same', '1.0.0'],
    ['changed', '1.0.0'],
    ['only-left', '1.0.0'],
  ],
  [
    ['same', '1.0.0'],
    ['changed', '2.0.0'],
    ['only-right', '1.0.0'],
  ],
);
if (probe.join(',') !== 'changed,only-left,only-right') {
  fail([
    'lockfile check self-check FAILED: the comparator does not see a difference',
    `  got: ${probe.join(',') || '(nothing)'}`,
    'a comparator that sees no difference reports every repository as consistent',
  ]);
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');

const lockVersion = Number(lock.lockfileVersion);
if (!Number.isFinite(lockVersion) || lockVersion < MIN_LOCKFILE_VERSION) {
  fail([
    `package-lock.json has lockfileVersion ${lock.lockfileVersion ?? '(absent)'}, expected >= ${MIN_LOCKFILE_VERSION}`,
    'an old-format lockfile cannot express the dependency graph this repository installs',
  ]);
}

const lockRoot = lock.packages?.[''];
if (!lockRoot) {
  fail([
    `package-lock.json has no root entry (packages[""])`,
    'every dependency field lives there; without it there is nothing to compare against',
  ]);
}

const problems = [];
let compared = 0;
for (const field of DEP_FIELDS) {
  const fromPackage = specMap(pkg, field);
  const fromLock = specMap(lockRoot, field);
  compared += fromPackage.length;
  const differ = comparePairs(fromPackage, fromLock);
  for (const name of differ) {
    const inPackage = new Map(fromPackage).get(name);
    const inLock = new Map(fromLock).get(name);
    problems.push(
      `  ${field}.${name}: package.json ${inPackage ?? '(absent)'} vs package-lock.json ${inLock ?? '(absent)'}`,
    );
  }
}

// Every declared dependency must have a resolved entry, or `npm ci` has nothing to
// install for it. This is the half a "same specs" comparison does not cover.
const resolved = (name) => Boolean(lock.packages?.[`node_modules/${name}`]);
const unresolved = [];
for (const field of DEP_FIELDS) {
  for (const [name] of specMap(pkg, field)) {
    if (!resolved(name)) unresolved.push(`  ${field}.${name}: no node_modules/${name} entry in the lockfile`);
  }
}

if (problems.length || unresolved.length) {
  console.error('package.json and package-lock.json disagree:');
  for (const line of [...problems, ...unresolved]) console.error(line);
  console.error('run `npm install` and commit both files together; `npm ci` would fail on this');
  process.exit(1);
}

console.log(
  `lockfile: ${compared} declared dependencies agree with package.json (lockfileVersion ${lockVersion})`,
);
