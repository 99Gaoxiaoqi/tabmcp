import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Every error we raise on purpose must carry its own code.
 *
 * The alternative — throwing a bare Error and matching its wording in a classifier —
 * means a reworded message silently changes the code, with no test going red. This
 * scan keeps that from creeping back in.
 */
const ROOTS = ['src/transport', 'src/api', 'src/core', 'src/host', 'src/repl', 'src/adapters', 'src/sdk'];

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

test('taxonomy: product code never throws a bare Error', () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (/throw new Error\(/.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `bare throws found:\n${offenders.join('\n')}`);
});

test('taxonomy: every ActionError code is declared in the union', () => {
  const source = fs.readFileSync('src/core/errors.ts', 'utf8');
  const union = source.slice(source.indexOf('export type ErrorCode'), source.indexOf('];', source.indexOf('export const ERROR_CODES')));
  const declared = new Set([...union.matchAll(/'([A-Z][A-Z_]+)'/g)].map((match) => match[1]!));
  const used = new Set<string>();
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/new ActionError\('([A-Z_]+)'/g)) used.add(match[1]!);
    }
  }
  const unknown = [...used].filter((code) => !declared.has(code));
  assert.deepEqual(unknown, [], 'codes used but not declared');
  assert.ok(used.size > 4, `expected several distinct codes, saw ${used.size}`);
});
