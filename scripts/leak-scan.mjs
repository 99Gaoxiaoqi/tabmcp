#!/usr/bin/env node
/**
 * Leak scan with a positive control that is independent of the needles.
 *
 * Three exit codes, three meanings:
 *   0  clean
 *   1  a local path was found
 *   2  the scanner itself is broken (self-check failed)
 *
 * The probe text below is written by hand, in the shapes a leak actually takes.
 * It must NOT be assembled from the scanner's own variables: if the needles were
 * ever mistyped, a same-source probe would still "pass" and the scanner would
 * report a clean repo while missing a real leak.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BS = String.fromCharCode(92); // one backslash, without putting one in this file
const roots = [`D:${BS}work`, `C:${BS}Program`, `C:${BS}Users`];
const NEEDLES = [...roots, ...roots.map((root) => root.replace(BS, '/'))];

// This file is skipped because its self-check probe must contain real-looking paths.
const SKIP = new Set(['node_modules', 'dist', '.git', 'scratch']);
const SKIP_FILES = new Set([path.normalize('scripts/leak-scan.mjs')]);
const EXT = new Set(['.ts', '.js', '.mjs', '.json', '.md', '.cs', '.txt']);

const scanText = (text) => {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const needle of NEEDLES) {
      if (line.includes(needle)) hits.push({ line: index + 1, needle, text: line.trim() });
    }
  });
  return hits;
};

// Hand-written probe. If a needle is mistyped, these are no longer matched and the
// self-check fails loudly instead of reporting a clean repository.
const PROBE_LINES = [
  'node = C:' + String.fromCharCode(92) + 'Program Files' + String.fromCharCode(92) + 'nodejs.exe',
  'repo = D:/work/example/file.js',
  'mixed = D:' + String.fromCharCode(92) + 'work' + String.fromCharCode(92) + 'example',
  'home = C:/Users/example/app.js',
  'home2 = C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'example',
];
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leakscan-'));
const probeFile = path.join(probeDir, 'probe.txt');
fs.writeFileSync(probeFile, PROBE_LINES.join('\n') + '\n');
const probeHits = scanText(fs.readFileSync(probeFile, 'utf8'));
fs.rmSync(probeDir, { recursive: true, force: true });

const probeText = PROBE_LINES.join('\n');
const missingRoots = roots.filter((root) => !probeText.includes(root));
const separatorHits = new Set(probeHits.map((hit) => (hit.needle.includes('/') ? 'forward' : 'back')));

if (probeHits.length < 3 || missingRoots.length > 0 || separatorHits.size < 2) {
  console.error(`scanner self-check FAILED: ${probeHits.length} hits, missing roots: ${missingRoots.join(', ') || 'none'}`);
  console.error('either a needle is wrong, or a root was added without a probe line for it');
  console.error('do not trust a clean result until this passes');
  process.exit(2);
}
console.log(`scanner self-check: ${probeHits.length} hits on the probe (both separators)`);

const hits = [];
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return EXT.has(path.extname(entry.name)) ? [full] : [];
  });

for (const file of walk('.')) {
  if (SKIP_FILES.has(path.normalize(file))) continue;
  for (const hit of scanText(fs.readFileSync(file, 'utf8'))) {
    hits.push(`${file}:${hit.line}: ${hit.text}`);
  }
}

if (hits.length) {
  console.error('local paths found:\n' + hits.join('\n'));
  process.exit(1);
}
console.log('local paths: 0 hits');
