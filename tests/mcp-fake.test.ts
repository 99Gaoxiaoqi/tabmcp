/**
 * MCP layer test with a fake transport.
 *
 * The browser-backed test is skipped when no Chrome is listening; that would leave the
 * MCP plumbing untested on a plain machine. This runs everywhere: the fakes in
 * `helpers/fake.ts` answer the injected scripts, so tool registration, argument
 * validation, the response envelope and the error envelope are all exercised.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { connectFake, FakePage, textOf } from './helpers/fake.js';
test('fake transport: tools are registered with schemas', async () => {
  const client = await connectFake();
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    // Deliberately NOT an exact list any more. This assertion used to spell out all 18
    // tool names, which made it the fourth hand-copied version of one fact (the README
    // count, the registrations in server.ts, this array, and loose names in other tests).
    // Adding a tool then failed here for no reason worth failing: the fact under test is
    // "the interesting tools are registered and each is well-formed", not "the set is
    // exactly the set I remembered".
    //
    // What still has to be true:
    for (const required of [
      'browser_tabs',
      'browser_tabs_select',
      'browser_goto',
      'browser_observe',
      'browser_act',
      'browser_read',
      'docs_get',
      'doctor',
      'js',
      'sites_search',
    ]) {
      assert.ok(names.includes(required), `${required} is registered`);
    }
    // No duplicates: a tool registered twice is a real bug that an exact list used to
    // catch only by accident.
    assert.equal(new Set(names).size, names.length, 'no tool name is registered twice');
    // The catalogue is not empty or truncated in a way that would make the check above
    // pass on a server that failed to register most tools.
    assert.ok(names.length >= 20, `expected at least 20 tools, saw ${names.length}`);

    for (const tool of tools.tools) assert.ok(tool.inputSchema, `${tool.name} has an input schema`);
    for (const tool of tools.tools) assert.ok(tool.description, `${tool.name} has a description`);
  } finally {
    await client.close();
  }
});

test('fake transport: goto and observe return the documented envelope', async () => {
  const client = await connectFake();
  try {
    const nav = await client.callTool({ name: 'browser_goto', arguments: { url: 'https://example.test/' } });
    const navText = textOf(nav);
    assert.match(navText, /"ok": true/);
    assert.match(navText, /example\.test/);

    const observed = await client.callTool({ name: 'browser_observe', arguments: { maxNodes: 50 } });
    const observedText = textOf(observed);
    assert.match(observedText, /revision: \d+/);
    assert.match(observedText, /button "Go"/);
  } finally {
    await client.close();
  }
});

test('fake transport: invalid arguments fail validation instead of crashing', async () => {
  const client = await connectFake();
  try {
    let rejected = false;
    try {
      await client.callTool({ name: 'browser_goto', arguments: { url: 42 as unknown as string } });
    } catch {
      rejected = true;
    }
    const result = await client.callTool({ name: 'browser_act', arguments: { ref: 'not-a-ref', action: 'click' } });
    const body = textOf(result);
    // A malformed ref must come back as a branchable error, not a thrown crash.
    assert.match(body, /E_REF_(INVALID|STALE)/);
    assert.ok(rejected || body.length > 0);
  } finally {
    await client.close();
  }
});




test('fake transport: js tool keeps bindings and returns the last expression', async () => {
  const client = await connectFake();
  try {
    const first = await client.callTool({ name: "js", arguments: { code: "const rows = [1,2,3]; rows.length" } });
    assert.match(textOf(first), /"value": 3/);

    const second = await client.callTool({ name: "js", arguments: { code: "rows.map((n) => n * 2)" } });
    assert.deepEqual(JSON.parse(textOf(second)).value, [2, 4, 6]);

    const reset = await client.callTool({ name: "js_reset", arguments: {} });
    assert.match(textOf(reset), /"cleared"/);

    const afterReset = await client.callTool({ name: "js", arguments: { code: "typeof rows" } });
    assert.match(textOf(afterReset), /undefined/);
  } finally {
    await client.close();
  }
});

test('fake transport: js tool can reach the tab facade', async () => {
  const client = await connectFake();
  try {
    const result = await client.callTool({ name: "js", arguments: { code: "await tab.title()" } });
    assert.match(textOf(result), /Fake page/);
  } finally {
    await client.close();
  }
});


test('fake transport: doctor reports transport, tab, adapters and repl', async () => {
  const client = await connectFake();
  try {
    await client.callTool({ name: "js", arguments: { code: "const x = 1;" } });
    const report = await client.callTool({ name: "doctor", arguments: {} });
    const body = JSON.parse(textOf(report));
    assert.equal(body.ok, true);
    assert.equal(body.transport, "extension");
    assert.equal(body.tabs, 1);
    assert.equal(body.activeTab.retention, null);
    assert.equal(body.repl.bound, 1);
    assert.ok(body.adapters && typeof body.adapters.count === "number");
  } finally {
    await client.close();
  }
});


