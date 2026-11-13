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

// `--strict` turns a stale exemption into a failure (exit 1). `verify` passes it; a
// manual run does not, because the person running it by hand is reading the output.
const STRICT = process.argv.includes('--strict');

// Three shapes, each one a way of naming a location on somebody's own machine.
//
//  1. an absolute drive path. Both separators, any drive, any case. The leading group
//     rejects a letter that is part of a word, which keeps `https://`, `chrome://` and
//     `note: x` out while still matching inside quotes and at the start of a line. The
//     trailing (?!\/) keeps a URL's double slash from reading as a drive root.
//
//  2. a UNC path. It names the machine even more directly than a drive letter does -
//     the host name or address, plus the share. It is written with TWO leading
//     backslashes in prose, and with two PER SEPARATOR when it appears inside a code
//     string, so the pattern accepts a run of two or more.
//     Two guards, both learned from the probe table:
//       - the character before the run must not be a backslash, so a longer run is
//         scanned from its start rather than matched in the middle;
//       - it must not be a colon, because `C:\\Users\\maria` in source code is a drive  // leak-scan:allow documentation: names the shape it is warning about
//         path with escaped separators, not a UNC path. Reporting it twice would make
//         the report say two things about one location;
//       - it must not be a percent sign: `%WINDIR%\\Microsoft.NET\\...` continues a path
//         whose root is an environment variable, and the part after it is not a host;
//       - it must not be a slash either, so a URL that happens to carry a UNC-shaped tail
//         (`https://example.com/\\server\\share`) stays a URL.
//
//     It also applies the same placeholder convention the probe table already uses for
//     URLs: `example.com` names no site, and `server` names no machine. Both are how
//     documentation writes the shape without writing a real one. That is not a machine
//     allow-list - it is one reserved word, the same reserved word the URL control has
//     always relied on. A machine genuinely named `server` would be missed; that is the
//     price, and it is cheaper than making every doc example a build failure.
//
//  3. a file:/// URL pointing at a real file. `file:///D:/...` is deliberately excluded:  // leak-scan:allow documentation: names the shape it is explaining
//     the drive shape above already covers it, and one location must not be reported as
//     two different problems. What is left is the shape a macOS or Linux contributor
//     writes without thinking: `file:///home/alice/...`.  // leak-scan:allow documentation: names the shape it is explaining
const ABS_PATH = /(^|[^A-Za-z0-9])([A-Za-z]):([\\/])(?!\/)/;
const UNC_PATH =
  /(^|[^A-Za-z0-9_$:\\%\/])\\{2,}([A-Za-z0-9][A-Za-z0-9._-]*)\\{1,2}[A-Za-z0-9$._-]+/;
/** Host names that name no machine, symmetric with `example.com` for URLs. */
const PLACEHOLDER_HOSTS = new Set(['server']);
const FILE_URL = /\bfile:\/\/\/(?![A-Za-z]:)[^\s'"`)<>\]]+/;

const SHAPES = [
  { why: 'absolute drive path', test: (line) => ABS_PATH.test(line) },
  {
    why: 'UNC path (host name or address)',
    test: (line) => {
      const match = UNC_PATH.exec(line);
      return match !== null && !PLACEHOLDER_HOSTS.has(match[2].toLowerCase());
    },
  },
  { why: 'file:/// path outside a drive letter', test: (line) => FILE_URL.test(line) },
];

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

// A line that carries this marker is not reported. Four rules keep it honest:
//   - it must be on the same line as a `//` comment. Text that merely contains the
//     marker string - a string literal, or this very paragraph explaining the syntax -
//     is not a marker. That distinction cost five separate bugs today: an escaped
//     `await import(`, a fixture containing `from '...'`, a placeholder host name, the
//     word `allowed:` in a message, and a truthiness check on a parsed field.
//   - a marker inside a `/* ... */` block is NOT supported: not detected, not honoured,
//     not even on one line. Saying so is cheaper than a scanner that half-supports a
//     syntax - this project has already paid for "looks supported, isn't".
//   - it applies to ONE line, never a file, so an exemption can never quietly cover
//     code that was added later;
//   - it must say why. A bare marker is an error, because an annotation nobody had to
//     justify is indistinguishable from one nobody meant.
// The count is always printed, including when it is zero - "nothing was let through"
// is a fact the reader should not have to infer from silence.
const ALLOW_MARKER = /\/\/[^\n]*?leak-scan:\s*allow\b\s*(.*)$/;

const scanText = (text) => {
  const hits = [];
  const allowed = [];
  const idle = [];
  const unexplained = [];
  // Split on `\r?\n`, not on `\n` alone: this repository has core.autocrlf=true, so a
  // Windows checkout can legitimately be CRLF. Splitting only on `\n` leaves a trailing
  // `\r`, and `.` does not match `\r`, so every marker would silently do nothing - on
  // exactly the platform most likely to need them.
  text.split(/\r?\n/).forEach((line, index) => {
    const marker = ALLOW_MARKER.exec(line);
    if (marker) {
      const reason = marker[1].trim();
      // Count a marker as an exemption only when it actually suppressed something. A
      // marker on a harmless line - including this file's own documentation of the
      // marker syntax - is not an exemption, and counting it would inflate the number
      // the reader uses to judge how much was let through.
      const wouldHaveFired = SHAPES.filter((shape) => shape.test(line)).length > 0;
      if (reason === '') unexplained.push(index + 1);
      else if (wouldHaveFired) allowed.push({ line: index + 1, reason });
      else idle.push({ line: index + 1 });
      return;
    }
    // One hit per line per shape. A line can legitimately contain two different shapes
    // (a repo root and a share), and collapsing them into one line number would hide
    // the second one.
    const reasons = SHAPES.filter((shape) => shape.test(line)).map((shape) => shape.why);
    if (reasons.length > 0) {
      hits.push({ line: index + 1, why: reasons.join(' + '), text: line.trim() });
    }
  });
  return { hits, allowed, idle, unexplained };
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
  { text: 'repo = d:/work/example/file.js', want: true },  // leak-scan:allow probe: this line is the control that proves the shape is caught
  { text: `work = ${'D:' + BS}work${BS}example`, want: true },
  { text: `data = ${'E:' + BS}data${BS}secret.ts`, want: true }, // a fourth drive, not a named root
  { text: 'root = cd C:' + BS, want: true }, // a bare drive root is still absolute
  { text: 'doc  = C:/Users/example/app.js', want: true }, // no allow-list: shape is enough  // leak-scan:allow probe: this line is the control that proves the shape is caught

  // UNC: a host name, and an address. Both name a machine, not just a folder.
  { text: `share = ${BS}${BS}fileserver${BS}team${BS}notes.md`, want: true },
  { text: `share = ${BS}${BS}10.0.0.7${BS}c$${BS}logs${BS}app.log`, want: true },
  { text: `share = "${BS}${BS}srv-01${BS}builds${BS}out"`, want: true }, // inside quotes
  { text: `share = ${BS}${BS}fileserver${BS}share`, want: true }, // two segments is still a real share
  // ...but `server` names no machine, exactly as `example.com` names no site. This is the
  // control that took two red builds to notice: a fixture that must look like a UNC path
  // is not a leaked path.
  { text: `doc  = ${BS}${BS}server${BS}share`, want: false },
  { text: `doc  = ${BS}${BS}server${BS}share${BS}tabmcp`, want: false },
  // A relative continuation after an environment variable is not a host.
  { text: `bin  = '%WINDIR%${BS}${BS}Microsoft.NET${BS}${BS}Framework64${BS}${BS}csc.exe'`, want: false },
  // Two more near-misses, both suggested by the reviewer of this change: a URL whose
  // path happens to look like a share, and an escaped backslash pair that is not a path.
  { text: `doc  = https://example.com/${BS}${BS}fileserver${BS}team${BS}notes.md`, want: false },
  { text: `esc  = a${BS}${BS}b`, want: false },

  // file:/// pointing at a real path, the shape a macOS/Linux contributor writes.
  { text: 'doc  = file:///home/alice/project/readme.md', want: true },  // leak-scan:allow probe: this line is the control that proves the shape is caught
  { text: 'doc  = file:///Users/bob/src/app.ts', want: true },  // leak-scan:allow probe: this line is the control that proves the shape is caught

  // Negative controls. The first three are legitimate things that contain slashes and
  // dots and must never be reported; the last two are the near-misses that the guards
  // exist for.
  { text: 'doc  = https://example.com/a/b', want: false }, // a URL is not a drive path
  { text: 'path = /api/v1/items', want: false }, // a POSIX-style API route is not a file path
  { text: 'doc  = //cdn.example.com/lib.js', want: false }, // protocol-relative URL, not UNC
  { text: 'doc  = chrome://settings', want: false },
  { text: 'url  = http://127.0.0.1:9222/json', want: false },
  { text: 'note: nothing here', want: false },
  // `file:///D:/...` is a drive path and is already reported by that shape. This line  // leak-scan:allow documentation: names the shape it is explaining
  // must still count as a hit overall, but only once - checked below, because "one
  // location, one finding" is the whole point of the exclusion.
  { text: 'doc  = file:///D:/work/example/app.js', want: true },  // leak-scan:allow probe: this line is the control that proves the shape is caught
];

// The exclusion above is worth its own assertion: this line must produce exactly one
// reason, not two, or the report tells the reader two stories about one path.
const driveInFileUrl = scanText('doc  = file:///D:/work/example/app.js').hits;  // leak-scan:allow assertion: the drive-in-file-URL case under test
if (driveInFileUrl.length !== 1 || driveInFileUrl[0].why !== 'absolute drive path') {
  fail([
    'scanner self-check FAILED: file:/// with a drive letter must be reported once, as a drive path',
    `  got: ${JSON.stringify(driveInFileUrl.map((hit) => hit.why))}`,
    'two reasons for one location reads as two problems',
  ]);
}
const probeMissed = PROBE.filter((probe) => probe.want && scanText(probe.text).hits.length === 0);
const probeCrossed = PROBE.filter((probe) => !probe.want && scanText(probe.text).hits.length > 0);
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
  // No `file === SELF` skip. The scanner is scanned like anything else, so a real path
  // pasted into this file is reported instead of hidden by a whole-file exemption.
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
  `scan surface: ${candidates.length} candidates = ${scanned.length} scanned (including this script) + ${binary.length} binary`,
);

// ---------------------------------------------------------------- scan

const hits = [];
const allowedNotes = [];
const idleNotes = [];
const unexplainedMarkers = [];
for (const file of scanned) {
  let text;
  try {
    text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  } catch (error) {
    fail([`scanner self-check FAILED: cannot read ${file}`, `  ${error instanceof Error ? error.message : String(error)}`]);
  }
  const result = scanText(text);
  for (const hit of result.hits) hits.push(`${file}:${hit.line}: ${hit.why}: ${hit.text}`);
  for (const note of result.allowed) allowedNotes.push(`${file}:${note.line}: ${note.reason}`);
  for (const note of result.idle) idleNotes.push(`${file}:${note.line}`);
  for (const line of result.unexplained) unexplainedMarkers.push(`${file}:${line}`);
}

if (unexplainedMarkers.length) {
  fail([
    `scanner self-check FAILED: ${unexplainedMarkers.length} leak-scan:allow marker(s) without a reason`,
    ...unexplainedMarkers.map((where) => `  ${where}`),
    'an exemption nobody had to justify is indistinguishable from one nobody meant;',
    'write `leak-scan:allow <why this line is not a leak>`',
  ]);
}

// Printed even when it is zero: what was let through must be visible, not inferred.
const allowedFiles = new Set(allowedNotes.map((note) => note.split(':')[0])).size;
console.log(`allowed: ${allowedNotes.length} line(s) in ${allowedFiles} file(s)`);
if (idleNotes.length) {
  // A marker that suppressed nothing is either documentation or a leftover. Saying so
  // keeps the count above readable as "how much was hidden", not "how many markers
  // exist".
  const detail = `  (${idleNotes.length} marker(s) suppressed nothing: ${idleNotes.join(', ')})`;
  // Under --strict this is a failure, not a note. A warning that lives only in a log
  // is a warning nobody reads, and an exemption nobody tidied up is how `allowed: 10`
  // quietly stops meaning anything. `verify` runs strict; a human running this by hand
  // is looking at the output, so a note is enough there.
  if (STRICT) {
    // Exit 1, not 2: the check ran fine and found a problem in the tree. 2 in this
    // script means "could not check", and a stale exemption is not that.
    for (const line of [
      'leak-scan: a stale exemption is in place but exempts nothing',
      detail.trim(),
      'either the marker is on the wrong line now, or the line no longer needs it;',
      'a stale exemption makes the allowed count unreadable',
    ]) {
      process.stderr.write(`${line}\n`);
    }
    process.exit(1);
  }
  console.log(detail);
}

if (hits.length) {
  console.error(`local paths found (${hits.length}):\n${hits.join('\n')}`);
  if (allowedNotes.length) console.error(`(excluded by marker: ${allowedNotes.length})`);
  process.exit(1);
}
console.log(`local paths: 0 hits in ${scanned.length} files`);
