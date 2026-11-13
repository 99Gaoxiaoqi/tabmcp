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
 *
 * ROOTS is the whole source tree, not a list of subdirectories. A handwritten list is
 * a list of directories someone remembered: the two files at the root (main.ts,
 * protocol.ts) and the largest file in the repo (mcp/server.ts) were all outside it,
 * so the bare throws in them were never scanned. Adding a directory does not remind
 * anyone to come back here; starting at src/ does not need to.
 */
const ROOTS = ['src'];
const ERRORS_FILE = path.join('src', 'core', 'errors.ts');

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

/** Every .ts file under ROOTS, read once. Fails loudly if the walk found nothing. */
const sources = (): { file: string; text: string }[] => {
  const files = ROOTS.flatMap(walk);
  assert.ok(files.length > 20, `source walk found only ${files.length} files under ${ROOTS.join(', ')}`);
  return files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
};

test('taxonomy: product code never throws a bare Error', () => {
  const offenders: string[] = [];
  for (const { file, text } of sources()) {
    text.split('\n').forEach((line, index) => {
      if (/throw new Error\(/.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `bare throws found:\n${offenders.join('\n')}`);
});

test('taxonomy: declared codes and used codes match in both directions', () => {
  const errorsSource = fs.readFileSync(ERRORS_FILE, 'utf8');
  const block = /export type ErrorCode\s*=([\s\S]*?);/.exec(errorsSource);
  assert.ok(block, 'could not locate the `export type ErrorCode` union');

  const body = block[1]!;
  const declared = [...body.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((match) => match[1]!);
  // Closure: the parse must see as many entries as the block actually contains. A
  // regex that quietly stopped matching part of the union would otherwise shrink the
  // declared set and make the checks below pass on less.
  const rawEntries = body.match(/'[A-Z][A-Z0-9_]+'/g) ?? [];
  assert.equal(declared.length, rawEntries.length, 'union parse dropped entries');
  assert.ok(declared.length >= 5, `expected several declared codes, saw ${declared.length}`);

  // Everything except the union declaration itself: a code counts as used when it
  // appears somewhere that is not its own declaration.
  const allText = sources()
    .map((entry) => entry.text)
    .join('\n')
    .replace(block[0], '');

  const unused = declared.filter((code) => !allText.includes(`'${code}'`));
  assert.deepEqual(
    unused,
    [],
    `declared but never used — a code nobody raises invites the nearest wrong meaning: ${unused.join(', ')}`,
  );

  const usedInActionError = new Set(
    [...allText.matchAll(/new ActionError\('([A-Z_][A-Z0-9_]*)'/g)].map((match) => match[1]!),
  );
  const declaredSet = new Set(declared);
  const undeclared = [...usedInActionError].filter((code) => !declaredSet.has(code));
  assert.deepEqual(undeclared, [], `codes used but not declared: ${undeclared.join(', ')}`);
});
