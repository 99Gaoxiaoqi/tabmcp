#!/usr/bin/env node
/**
 * The README claims a tool count; the code has a number of registerTool call sites.
 * They drifted once (README said five, the code registered nineteen), so the claim
 * is checked instead of remembered.
 *
 * Three exit codes, three meanings:
 *   0  the README count matches, and every call site was accounted for
 *   1  the README count is wrong
 *   2  the counter itself cannot vouch for the result
 *
 * The previous version matched `registerTool\(\s*'...'` - single quotes only. A tool
 * registered with double quotes, a backtick, or a name computed at runtime did not
 * match, so the gate compared a smaller number against a smaller number and passed.
 * Quote style is not a semantic difference; the count must not depend on it.
 *
 * The fix is not a wider regex but a closed sum:
 *
 *   every  registerTool(  call site
 *        = a literal name (any quote style, no interpolation)
 *        + a computed name (registered once, for every adapter installed)
 *
 * Computed sites are counted and asserted against an expected number, so a new one
 * cannot appear without someone writing down what it is. The matcher below runs on
 * every invocation, including lines that must NOT count, so a silently narrower
 * regex fails loudly instead of reporting agreement.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(REPO_ROOT);

const README = 'README.md';
const SOURCE = 'src/mcp/server.ts';

// A computed registration cannot be checked against the README, so each one has to be
// named on purpose. The adapter loop registers `toolName` once for every installed
// adapter; anything else that computes a name is a new decision, not a detail.
// Asserting the name - rather than a count - keeps this free of a number that would
// have to be edited whenever a fixture or a repository differs.
const ALLOWED_COMPUTED_NAMES = new Set(['toolName']);

const SITE = /\bserver\.registerTool\s*\(/g;
const LITERAL = /\bserver\.registerTool\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const COMPUTED = /\bserver\.registerTool\s*\(\s*([A-Za-z_$][\w$]*)/g;

const fail = (lines) => {
  for (const line of lines) console.error(line);
  process.exit(2);
};

/** Count call sites and split them into literal names and computed identifiers. */
const analyze = (source) => {
  const sites = [...source.matchAll(SITE)].length;
  const literalNames = [...source.matchAll(LITERAL)]
    .map((match) => match[2])
    .filter((name) => !name.includes('${')); // an interpolated template is computed
  const computedNames = [...source.matchAll(COMPUTED)]
    .map((match) => match[1])
    // A literal starts with a quote, so it is not an identifier. A template with
    // interpolation starts with a backtick and is caught by the filter above.
    .filter((name) => !['true', 'false', 'null'].includes(name));
  const literalSites = literalNames.length;
  const interpolated = [...source.matchAll(LITERAL)].filter((match) => match[2].includes('${')).length;
  return {
    sites,
    literalNames,
    computedNames,
    computedSites: sites - literalSites,
  };
};

// ---------------------------------------------------------------- matcher control
//
// Runs on every invocation. The expected values are written out by hand, so a regex
// that stops matching a quote style fails here rather than reporting agreement with a
// README that was lowered to match it.
const PROBE_SOURCE = [
  "server.registerTool('one', {});",
  'server.registerTool("two", {});',
  'server.registerTool(`three`, {});',
  'server.registerTool(',
  "  'four',",
  '  {},',
  ');',
  'server.registerTool(toolName, {});',
  'server.registerTool(`prefix_${suffix}`, {});',
  'originalRegisterTool(name, config, handler);',
].join('\n');

const probe = analyze(PROBE_SOURCE);
const probeExpected = {
  sites: 6,
  literalNames: ['one', 'two', 'three', 'four'],
  computedSites: 2,
  computedNames: ['toolName'],
};
const probeProblems = [];
if (probe.sites !== probeExpected.sites) probeProblems.push(`sites ${probe.sites}, expected ${probeExpected.sites}`);
if (probe.computedSites !== probeExpected.computedSites) {
  probeProblems.push(`computed ${probe.computedSites}, expected ${probeExpected.computedSites}`);
}
if (probe.literalNames.join(',') !== probeExpected.literalNames.join(',')) {
  probeProblems.push(`literals [${probe.literalNames.join(', ')}], expected [${probeExpected.literalNames.join(', ')}]`);
}
if (probe.computedNames.join(',') !== probeExpected.computedNames.join(',')) {
  probeProblems.push(`computed names [${probe.computedNames.join(', ')}], expected [${probeExpected.computedNames.join(', ')}]`);
}
if (probeProblems.length) {
  fail([
    'counter self-check FAILED: the matcher does not see what it is supposed to see',
    ...probeProblems.map((problem) => `  ${problem}`),
    'do not trust the count until this passes',
  ]);
}
console.log(`counter self-check: ${probe.sites} sites, ${probe.literalNames.length} literals, ${probe.computedSites} computed`);

// ---------------------------------------------------------------- the claim

let readme;
try {
  readme = fs.readFileSync(README, 'utf8');
} catch {
  fail([`cannot read ${README}`]);
}
const marker = /<!--\s*tool-count:\s*(\d+)\s*-->/.exec(readme);
if (!marker) fail([`${README} has no <!-- tool-count: N --> marker`]);
const claimed = Number(marker[1]);

let source;
try {
  source = fs.readFileSync(SOURCE, 'utf8');
} catch {
  fail([`cannot read ${SOURCE}`]);
}
const { sites, literalNames, computedSites, computedNames } = analyze(source);

const duplicates = literalNames.length - new Set(literalNames).size;
if (duplicates > 0) {
  console.error(`duplicate built-in tool names: ${duplicates}`);
  process.exit(1);
}

const unexpectedComputed = [...new Set(computedNames)].filter((name) => !ALLOWED_COMPUTED_NAMES.has(name));
if (unexpectedComputed.length) {
  fail([
    `unaccounted computed registrations: ${unexpectedComputed.join(', ')}`,
    'a computed name cannot be checked against the README, so each one has to be',
    'named on purpose. If a new one is legitimate, add it to ALLOWED_COMPUTED_NAMES',
    'and say which call site it is.',
  ]);
}

if (claimed !== literalNames.length) {
  console.error(
    `tool count mismatch: ${README} says ${claimed}, ${SOURCE} registers ${literalNames.length} literal names ` +
      `(${sites} call sites - ${computedSites} computed)`,
  );
  process.exit(1);
}
console.log(
  `tool count: ${README} ${claimed} == ${literalNames.length} literal registerTool names ` +
    `(${sites} call sites - ${computedSites} computed)`,
);
