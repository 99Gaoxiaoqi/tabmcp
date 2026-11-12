/**
 * Adapter contract tests: validation, argument coercion, runner behaviour,
 * draft activation gating. A fake tab stands in for the browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coerceArgs, defineAdapter, errors, validateDefinition } from '../src/sdk/index.js';
import { loadAdapters, searchAdapters, findAdapter } from '../src/adapters/loader.js';
import { checkExpectation, runAdapter } from '../src/adapters/runner.js';
import { DraftStore } from '../src/adapters/drafts.js';
import type { RuntimePage } from '../src/transport/page.js';

const tab = { id: 'fake', url: async () => 'https://example.test/' } as unknown as RuntimePage;

test('validateDefinition: rejects missing description and bad access', () => {
  assert.equal(validateDefinition({ access: 'read', run: async () => ({}) }).ok, false);
  assert.equal(validateDefinition({ description: 'x', access: 'admin', run: async () => ({}) }).ok, false);
  assert.equal(validateDefinition({ description: 'x', access: 'read' }).ok, false);
});

test('validateDefinition: accepts a plain object adapter', () => {
  const result = validateDefinition({ description: 'List things', access: 'read', run: async () => ({ items: [] }) });
  assert.equal(result.ok, true);
});

test('coerceArgs: required, unknown, types and choices', () => {
  const spec = [
    { name: 'id', type: 'string' as const, required: true },
    { name: 'limit', type: 'int' as const, default: 10 },
    { name: 'mode', type: 'string' as const, choices: ['fast', 'full'] },
  ];
  assert.equal(coerceArgs(spec, {}).ok, false, 'missing required');
  assert.equal(coerceArgs(spec, { id: 'a', extra: 1 }).ok, false, 'unknown argument');
  assert.equal(coerceArgs(spec, { id: 'a', limit: 'x' }).ok, false, 'bad int');
  assert.equal(coerceArgs(spec, { id: 'a', mode: 'other' }).ok, false, 'choice violated');
  const ok = coerceArgs(spec, { id: 'a', limit: '5', mode: 'fast' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.value, { id: 'a', limit: 5, mode: 'fast' });
});

test('loader: discovers adapters, skips underscore helpers, reports broken files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmcp-adapters-'));
  const userDir = path.join(root, 'adapters');
  fs.mkdirSync(path.join(userDir, 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(userDir, 'demo', 'list.js'),
    'export default { description: "List entries", access: "read", args: [{ name: "limit", type: "int" }], async run({ args }) { return { items: [1,2,3].slice(0, args.limit ?? 3) }; } };\n',
  );
  fs.writeFileSync(path.join(userDir, 'demo', '_shared.js'), 'export const helper = 1;\n');
  fs.writeFileSync(path.join(userDir, 'demo', 'broken.js'), 'export default { access: "nope" };\n');

  const catalog = await loadAdapters({ builtinDir: path.join(root, 'none'), userDir });
  assert.deepEqual(catalog.adapters.map((a) => a.toolName), ['demo list']);
  assert.equal(catalog.problems.length, 1);
  assert.match(catalog.problems[0]!.file, /broken\.js/);

  assert.equal(searchAdapters(catalog, 'list').length, 1);
  assert.equal(searchAdapters(catalog, 'nothing-matches').length, 0);
  assert.ok(findAdapter(catalog, 'DEMO', 'LIST'), 'lookup is case-insensitive');
});

test('runner: executes with coerced args and normalises adapter errors', async () => {
  const adapter = {
    site: 'demo',
    command: 'list',
    toolName: 'demo list',
    file: 'demo/list.js',
    source: 'user' as const,
    definition: defineAdapter({
      description: 'List entries',
      access: 'read',
      args: [{ name: 'limit', type: 'int', default: 2 }],
      run: async ({ args }) => ({ items: [1, 2, 3].slice(0, args.limit as number) }),
    }),
  };

  const ok = await runAdapter({ adapter, tab, args: {} });
  assert.deepEqual(ok.result, { items: [1, 2] });
  assert.equal(ok.access, 'read');

  const authAdapter = {
    ...adapter,
    definition: defineAdapter({
      description: 'Needs login',
      access: 'read',
      run: async () => {
        throw errors.auth('Not logged in', 'Sign in and retry.');
      },
    }),
  };
  await assert.rejects(() => runAdapter({ adapter: authAdapter, tab, args: {} }), (err: unknown) => {
    assert.equal((err as { code?: string }).code, 'E_AUTH');
    assert.match((err as Error).message, /Not logged in/);
    return true;
  });

  await assert.rejects(() => runAdapter({ adapter, tab, args: { unknown: 1 } }), (err: unknown) => {
    assert.equal((err as { code?: string }).code, 'E_BAD_ARGUMENT');
    return true;
  });
});

test('checkExpectation: minRows and text', () => {
  assert.equal(checkExpectation({ minRows: 3 }, { items: [1, 2, 3] }).ok, true);
  assert.equal(checkExpectation({ minRows: 3 }, { items: [1] }).ok, false);
  assert.equal(checkExpectation({ minRows: 2, result_path: 'data.rows' }, { data: { rows: [1, 2] } }).ok, true);
  assert.equal(checkExpectation({ text: 'ok' }, { status: 'ok' }).ok, true);
  assert.equal(checkExpectation({ text: 'missing' }, { status: 'ok' }).ok, false);
});

test('drafts: activation is refused until verified', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmcp-drafts-'));
  const store = new DraftStore(path.join(root, 'drafts'), path.join(root, 'adapters'));
  const draft = store.create({
    site: 'demo',
    command: 'list',
    description: 'List entries',
    access: 'read',
    source: 'export default { description: "List entries", access: "read", async run() { return { items: [] }; } };\n',
    expect: { minRows: 1 },
  });

  assert.equal(store.list().length, 1);
  assert.throws(() => store.activate(draft.id), /not been verified/);

  store.markVerified(draft.id);
  const activated = store.activate(draft.id);
  assert.ok(fs.existsSync(activated.file), 'adapter written to the user adapter dir');
  assert.equal(store.list().length, 0, 'draft removed after activation');
});
