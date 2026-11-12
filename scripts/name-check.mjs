import fs from 'node:fs';
import path from 'node:path';
const SKIP = new Set(['node_modules', 'dist', '.git', 'scratch']);
const EXT = new Set(['.ts', '.js', '.mjs', '.json', '.md', '.cs', '.txt']);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (SKIP.has(e.name)) return [];
  const full = path.join(dir, e.name);
  if (e.isDirectory()) return walk(full);
  return EXT.has(path.extname(e.name)) ? [full] : [];
});
const SELF = path.normalize('scripts/name-check.mjs');
// This file names the patterns it forbids, so it must not scan itself.
const checks = [
  ['browsermcp', /browsermcp/i],
  ['browser mcp (with space)', /browser\s+mcp/i],
  ['bmcp standalone', /(?<!ta)bmcp/i],
  ['tatabmcp (double replace)', /tatabmcp/i],
  ['browser mcp core', /browser\s*mcp\s*core/i],
];
let bad = 0;
for (const [label, re] of checks) {
  const files = [];
  for (const file of walk('.')) {
    if (path.normalize(file) === SELF) continue;
    const hits = fs.readFileSync(file, 'utf8').match(new RegExp(re.source, 'gi')) ?? [];
    if (hits.length) files.push(`${file} (${hits.length})`);
  }
  const ok = files.length === 0;
  if (!ok) bad++;
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(28), files.join(', '));
}
process.exit(bad ? 1 : 0);
