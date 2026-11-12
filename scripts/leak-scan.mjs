#!/usr/bin/env node
/**
 * Leak scan with a real positive control.
 *
 * Two failure modes this guards against:
 *   - a needle built with the wrong number of backslashes never matches;
 *   - a scanner that never fires prints the same thing as a clean repo.
 * So the needles are built from String.fromCharCode(92) (one backslash), and the
 * scan is first run against a temporary file that contains a known leak.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BS = String.fromCharCode(92); // one backslash, without putting one in this file
const roots = [`D:${BS}work`, `C:${BS}Program`, `C:${BS}Users`];
const NEEDLES = [
  ...roots,
  ...roots.map((root) => root.replace(BS, '/')),
];

const SKIP = new Set(['node_modules', 'dist', '.git', 'scratch']);
const EXT = new Set(['.ts', '.js', '.mjs', '.json', '.md', '.cs', '.txt']);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return EXT.has(path.extname(entry.name)) ? [full] : [];
  });

const scanText = (text) => {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const needle of NEEDLES) {
      if (line.includes(needle)) hits.push({ line: index + 1, needle, text: line.trim() });
    }
  });
  return hits;
};

// Positive control on real IO: a file that definitely contains a leak.
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leakscan-'));
const probeFile = path.join(probeDir, 'probe.txt');
fs.writeFileSync(probeFile, ['node = ' + NEEDLES[1], 'repo = ' + NEEDLES[0], 'mixed = ' + NEEDLES[3], ''].join('\n'));
const probeHits = scanText(fs.readFileSync(probeFile, 'utf8'));
fs.rmSync(probeDir, { recursive: true, force: true });
if (probeHits.length < 3) {
  console.error(`scanner self-check FAILED: expected >=3 hits on the probe, got ${probeHits.length}`);
  process.exit(2);
}
console.log(`scanner self-check: ${probeHits.length} hits on the probe (both separators)`);

const hits = [];
for (const file of walk('.')) {
  for (const hit of scanText(fs.readFileSync(file, 'utf8'))) {
    hits.push(`${file}:${hit.line}: ${hit.text}`);
  }
}

if (hits.length) {
  console.error('local paths found:\n' + hits.join('\n'));
  process.exit(1);
}
console.log('local paths: 0 hits');
