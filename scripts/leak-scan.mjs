#!/usr/bin/env node
/**
 * Leak scan: no absolute path that identifies this machine may reach a commit.
 *
 * Three exit codes, three meanings:
 *   0  clean
 *   1  a local path was found
 *   2  the scanner itself cannot vouch for the result (a control failed)
 *
 * Exit 2 exists because "0 hits" has two causes that look identical from the
 * outside: the repo is clean, or the scanner looked at nothing. Everything below
 * that can make the second cause happen is turned into a control that fails loudly:
 *
 *   1. MATCHER control - hand-written probe lines, including ones that must NOT
 *      match. A needle that silently stops matching is the failure this catches;
 *      it already caught one (a character class that lost its backslash).
 *   2. SURFACE control - the candidate set comes from git (what would be committed),
 *      and every top-level directory that exists must contribute at least one
 *      candidate. A directory that got gitignored wholesale, or a walker bug,
 *      shrinks the set to nothing and fails here instead of reporting clean.
 *   3. CLOSURE control - every extension present in the candidate set must be
 *      classified as text or binary. An unknown extension is an error, not a skip,
 *      so a new file type cannot quietly fall outside the scan.
 *
 * WHY git, and not a directory walk: the leak that matters is the one that gets
 * committed. A walk also visits build output that legitimately contains machine
 * paths (native-host.cmd does), which forces either a false positive or an
 * ignore-list to maintain. The tracked-or-untracked-but-not-ignored set is exactly
 * the publishable set, so it needs no such list.
 *
 * WHY one shape and no allow-list: an earlier version named this machine's three
 * folders and any user-profile path. That enumerated what someone remembered, so a
 * lowercase drive letter, a fourth drive, or a sibling directory all passed silently.
 * One shape - any absolute drive path - needs no list, and the whole repository has
 * no legitimate reason to contain one.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Scanning must not depend on where the command was typed: run from a subdirectory
// and a cwd-relative walk scans almost nothing and still reports clean.
process.chdir(REPO_ROOT);

const BS = String.fromCharCode(92);
const SELF = path.normalize('scripts/leak-scan.mjs');

// One shape: an absolute drive path. Both separators, any drive, any case.
// The leading group rejects a letter that is part of a word, which is what keeps
// `https://`, `chrome://` and `note: x` out while still matching inside quotes,
// after whitespace, and at the start of a line. The trailing (?!\/) keeps a URL's
// double slash from reading as a drive root.
const ABS_PATH = /(^|[^A-Za-z0-9])([A-Za-z]):([\\/])(?!\/)/;

// Directories the publishable set never contains. Kept for the surface control only;
// git is what actually decides membership.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'scratch']);

// Text we scan. Not an allow-list of what exists today: an extension that is in
// neither this set nor BINARY_EXT fails the closure control, which is how a new file
// type makes itself known instead of being skipped.
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.json', '.jsonc', '.md', '.mdx',
  '.txt', '.cs', '.yml', '.yaml', '.html', '.htm', '.css', '.scss', '.sh', '.ps1',
  '.cmd', '.bat', '.py', '.toml', '.ini', '.cfg', '.xml', '.sql', '.graphql', '.svelte',
]);

// Binary: scanned by extension only, never read as text. Each of these would produce
// useless matches if read as utf8.
const BINARY_EXT = new Set([
  '.exe', '.dll', '.node', '.so', '.dylib', '.pem', '.cer', '.png', '.jpg', '.jpeg',
  '.gif', '.ico', '.webp', '.bmp', '.woff', '.woff2', '.ttf', '.otf', '.zip', '.gz',
  '.tar', '.pdf', '.db', '.sqlite', '.wasm', '.map', '.crx',
]);

/** Extensions with no dot, and dotfiles like `.gitignore`, have no extension. */
const extOf = (file) => {
  const base = path.basename(file);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
};

const scanText = (text) => {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    const match = ABS_PATH.exec(line);
    if (match) {
      hits.push({ line: index + 1, why: 'absolute drive path', text: line.trim() });
    }
  });
  return hits;
};

const fail = (lines) => {
  for (const line of lines) console.error(line);
  process.exit(2);
};

// ---------------------------------------------------------------- 1. matcher control
//
// Hand-written, and it must NOT be assembled from the needles themselves: a typo in
// a needle would then also typo the probe and the self-check would still pass.
const PROBE = [
  { text: `repo = ${'C:' + BS}Users${BS}maria${BS}app.js`, want: true },
  { text: 'repo = d:/work/example/file.js', want: true },
  { text: `work = ${'D:' + BS}work${BS}example`, want: true },
  { text: `data = ${'E:' + BS}data${BS}secret.ts`, want: true }, // a fourth drive, not a named root
  { text: 'root = cd C:' + BS, want: true }, // a bare drive root is still absolute
  { text: 'doc  = C:/Users/example/app.js', want: true }, // no allow-list: shape is enough
  { text: 'doc  = https://example.com/a/b', want: false }, // a URL is not a drive path
  { text: 'doc  = chrome://settings', want: false },
  { text: 'url  = http://127.0.0.1:9222/json', want: false },
  { text: 'note: nothing here', want: false },
];
const probeMissed = PROBE.filter((probe) => probe.want && scanText(probe.text).length === 0);
const probeCrossed = PROBE.filter((probe) => !probe.want && scanText(probe.text).length > 0);
if (probeMissed.length || probeCrossed.length) {
  fail([
    `scanner self-check FAILED: missed ${probeMissed.length}, unexpected ${probeCrossed.length}`,
    ...probeMissed.map((probe) => `  should have matched: ${probe.text}`),
    ...probeCrossed.map((probe) => `  should NOT have matched: ${probe.text}`),
    'do not trust a clean result until this passes',
  ]);
}
const probeHits = PROBE.filter((probe) => probe.want).length;
console.log(`scanner self-check: ${probeHits} positive and ${PROBE.length - probeHits} negative probe lines`);

// ---------------------------------------------------------------- 2. surface control

let candidates;
try {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  candidates = raw.split('\0').filter(Boolean).map((file) => path.normalize(file));
} catch (error) {
  fail([
    'scanner self-check FAILED: cannot list the files git would commit',
    `  ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    'without that list the scan has no surface to report on, so a clean result would be meaningless',
  ]);
}

const surfaceProblems = [];
if (!candidates.includes(SELF)) surfaceProblems.push(`${SELF} is not in the candidate set (the scanner cannot see itself)`);
if (!candidates.includes(path.normalize('package.json'))) surfaceProblems.push('package.json is not in the candidate set');
for (const entry of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
  const prefix = entry.name + path.sep;
  if (!candidates.some((file) => file.startsWith(prefix))) {
    surfaceProblems.push(`${entry.name}${path.sep} exists but contributes no candidate (ignored wholesale, or never walked)`);
  }
}
if (surfaceProblems.length) {
  fail([
    'scanner self-check FAILED: the candidate set does not cover the tree',
    ...surfaceProblems.map((problem) => `  ${problem}`),
    'a smaller candidate set still reports 0 hits, which is why this is an error and not a warning',
  ]);
}

// ---------------------------------------------------------------- 3. closure control

const scanned = [];
const binary = [];
const unclassified = new Map();
for (const file of candidates) {
  if (file === SELF) continue;
  const ext = extOf(file);
  if (ext === '' || TEXT_EXT.has(ext)) scanned.push(file);
  else if (BINARY_EXT.has(ext)) binary.push(file);
  else unclassified.set(ext, (unclassified.get(ext) ?? 0) + 1);
}
if (unclassified.size) {
  fail([
    'scanner self-check FAILED: unclassified extensions in the candidate set',
    ...[...unclassified.entries()].map(([ext, count]) => `  ${ext} x${count}`),
    'add each one to TEXT_EXT (scan it) or BINARY_EXT (deliberately not read as text);',
    'leaving it unclassified is the same as skipping it, but silently',
  ]);
}
console.log(
  `scan surface: ${candidates.length} candidates = ${scanned.length} scanned + ${binary.length} binary + 1 self`,
);

// ---------------------------------------------------------------- scan

const hits = [];
for (const file of scanned) {
  let text;
  try {
    text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  } catch (error) {
    fail([`scanner self-check FAILED: cannot read ${file}`, `  ${error instanceof Error ? error.message : String(error)}`]);
  }
  for (const hit of scanText(text)) hits.push(`${file}:${hit.line}: ${hit.why}: ${hit.text}`);
}

if (hits.length) {
  console.error(`local paths found (${hits.length}):\n${hits.join('\n')}`);
  process.exit(1);
}
console.log(`local paths: 0 hits in ${scanned.length} files`);
