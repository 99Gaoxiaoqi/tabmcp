/**
 * MCP layer test: spawn the real server over stdio and talk to it.
 *
 * Requires a Chrome with a debugging port; set BROWSER_ENDPOINT or pass
 * --connect. Skipped when no endpoint is reachable, so `npm test` stays green
 * without a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENDPOINT = process.env.BROWSER_ENDPOINT ?? 'http://127.0.0.1:9222';

async function endpointAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

test('MCP server exposes the five browser tools', async (t) => {
  if (!(await endpointAlive())) {
    // Silent skips hide regressions. Opt in to a hard failure when the
    // environment is supposed to have a browser.
    if (process.env.REQUIRE_BROWSER === '1') {
      assert.fail(`REQUIRE_BROWSER=1 but no browser is listening at ${ENDPOINT}`);
    }
    t.skip(`no browser at ${ENDPOINT} (set REQUIRE_BROWSER=1 to make this fail instead)`);
    return;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/src/main.js', '--connect', ENDPOINT],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    // Adapter tools are registered per installed adapter, so the exact list depends on
    // the machine. The built-ins must all be there; anything extra must look like an
    // adapter tool (<site>_<command>) rather than a typo.
    const builtins = [
      'browser_act',
      'browser_cookies',
      'browser_download',
      'browser_goto',
      'browser_navigate',
      'browser_network_read',
      'browser_observe',
      'browser_read',
      'browser_screenshot',
      'docs_get',
      'doctor',
      'js',
      'js_reset',
      'recon_draft',
      'recon_report',
      'recon_start',
      'site_run',
      'sites_search',
    ];
    for (const name of builtins) assert.ok(names.includes(name), `missing built-in tool: ${name}`);
    const extras = names.filter((name) => !builtins.includes(name));
    for (const name of extras) {
      assert.match(name, /^[a-z0-9]+_[a-z0-9_]+$/, `unexpected tool: ${name}`);
    }

    // A tool call over the real protocol, not just a listing.
    const nav = await client.callTool({
      name: 'browser_goto',
      arguments: { url: 'data:text/html,<h1>mcp</h1><button>Go</button>' },
    });
    const navText = (nav.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';
    assert.match(navText, /"ok": true/);

    const observed = await client.callTool({ name: 'browser_observe', arguments: {} });
    const observedText = (observed.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';
    assert.match(observedText, /button/);
    assert.match(observedText, /revision: \d+/);
  } finally {
    await client.close();
  }
});

