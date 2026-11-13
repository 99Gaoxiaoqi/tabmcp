#!/usr/bin/env node
/**
 * The README claims a tool count; the code has a number of registerTool call sites.
 * They drifted once (README said five, the code registered nineteen), so the claim
 * is checked instead of remembered.
 */
import fs from 'node:fs';

const README = 'README.md';
const SOURCE = 'src/mcp/server.ts';

const readme = fs.readFileSync(README, 'utf8');
const match = /<!--\s*tool-count:\s*(\d+)\s*-->/.exec(readme);
if (!match) {
  console.error('README.md has no <!-- tool-count: N --> marker');
  process.exit(1);
}
const claimed = Number(match[1]);

const source = fs.readFileSync(SOURCE, 'utf8');
// The adapter loop registers a computed name (`toolName`) once, for every adapter
// installed; only the literal registrations are built-ins the README can promise.
const staticSites = [...source.matchAll(/server\.registerTool\(\s*'([^']+)'/g)].map((m) => m[1]);
const actual = staticSites.length;
const unique = new Set(staticSites);
if (unique.size !== actual) {
  console.error(`duplicate built-in tool names: ${actual - unique.size}`);
  process.exit(1);
}

if (claimed !== actual) {
  console.error(`tool count mismatch: README says ${claimed}, ${SOURCE} registers ${actual}`);
  process.exit(1);
}
console.log(`tool count: README ${claimed} == built-in registerTool sites ${actual}`);
