/**
 * REPL tests: persistence, top-level await, trailing expressions, errors,
 * timeouts and reset — the behaviours an agent relies on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsSession, declaredNames } from '../src/repl/session.js';

function session(): JsSession {
  return new JsSession({ helper: { answer: 42 } });
}

test('returns the value of a trailing expression', async () => {
  const repl = session();
  const result = await repl.run('1 + 1');
  assert.equal(result.ok, true);
  assert.equal(result.value, 2);
});

test('keeps variables between runs', async () => {
  const repl = session();
  await repl.run('const rows = [1, 2, 3];');
  const second = await repl.run('rows.length');
  assert.equal(second.value, 3);
});

test('keeps functions and classes between runs', async () => {
  const repl = session();
  await repl.run('function double(n) { return n * 2; }');
  await repl.run('class Box { constructor(v) { this.v = v; } get() { return this.v; } }');
  const doubled = await repl.run('double(21)');
  assert.equal(doubled.value, 42);
  const boxed = await repl.run('new Box(7).get()');
  assert.equal(boxed.value, 7);
});

test('supports top-level await', async () => {
  const repl = session();
  const result = await repl.run('await new Promise((r) => setTimeout(() => r("done"), 20))');
  assert.equal(result.ok, true);
  assert.equal(result.value, 'done');
});

test('exposes the provided globals', async () => {
  const repl = session();
  const result = await repl.run('helper.answer');
  assert.equal(result.value, 42);
});

test('captures console output', async () => {
  const repl = session();
  const result = await repl.run('console.log("row", 1); console.log("row", 2);');
  assert.deepEqual(result.writes, ['row 1', 'row 2']);
});

test('reports errors without losing earlier bindings', async () => {
  const repl = session();
  await repl.run('const kept = "yes";');
  const failed = await repl.run('throw new Error("boom")');
  assert.equal(failed.ok, false);
  assert.match(failed.error?.message ?? '', /boom/);
  const after = await repl.run('kept');
  assert.equal(after.value, 'yes');
});

test('a syntax error does not kill the session', async () => {
  const repl = session();
  const broken = await repl.run('const = ;');
  assert.equal(broken.ok, false);
  const after = await repl.run('2 + 2');
  assert.equal(after.value, 4);
});

test('times out instead of hanging forever', async () => {
  const repl = session();
  const started = Date.now();
  const result = await repl.run('await new Promise(() => {});', { timeoutMs: 150 });
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? '', /timed out/);
  assert.ok(Date.now() - started >= 140);
});

test('reset clears prior bindings', async () => {
  const repl = session();
  await repl.run('const doomed = 1;');
  assert.equal((await repl.run('doomed')).value, 1);
  repl.reset();
  const after = await repl.run('typeof doomed');
  assert.equal(after.value, 'undefined');
});

test('declaredNames finds var/let/const/function/class', () => {
  const names = declaredNames(`
    const a = 1;
    let b = 2;
    var c = 3;
    function d() {}
    class E {}
  `);
  assert.deepEqual(names.sort(), ['E', 'a', 'b', 'c', 'd']);
});

test('truncates large values instead of flooding the caller', async () => {
  const repl = session();
  const result = await repl.run('"x".repeat(1000)', { maxChars: 50 });
  assert.equal(typeof result.value, 'string');
  assert.match(String(result.value), /truncated/);
});

test('persists JSON-safe bindings and restores them in a new session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcp-repl-state-'));
  const statePath = path.join(dir, 'state.json');

  const first = new JsSession({}, { statePath });
  await first.run('const rows = [{ id: 1 }, { id: 2 }]; const label = "kept";');

  const second = new JsSession({}, { statePath });
  assert.equal(second.restored >= 2, true);
  assert.deepEqual((await second.run('rows')).value, [{ id: 1 }, { id: 2 }]);
  assert.equal((await second.run('label')).value, 'kept');
});

test('drops values that cannot survive JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcp-repl-state-'));
  const statePath = path.join(dir, 'state.json');

  const first = new JsSession({}, { statePath });
  await first.run('const fn = () => 1; const ok = 42; const circular = {}; circular.self = circular;');

  const second = new JsSession({}, { statePath });
  assert.equal((await second.run('typeof fn')).value, 'undefined');
  assert.equal((await second.run('ok')).value, 42);
  assert.equal((await second.run('typeof circular')).value, 'undefined');
});

test('a corrupt state file does not stop the session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcp-repl-state-'));
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, '{not json', 'utf8');
  const session = new JsSession({}, { statePath });
  assert.equal((await session.run('1 + 1')).value, 2);
});
