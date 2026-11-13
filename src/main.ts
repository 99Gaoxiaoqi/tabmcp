/**
 * Entry point.
 *
 * Modes:
 *   --connect <endpoint>   attach to Chrome already running with a debugging port
 *   --mcp                  speak MCP over stdio (default)
 *   --probe                smoke test: open a local page, exercise every API
 */

import { CdpSession, type BrowserSession } from './transport/cdp.js';
import { ExtensionSession } from './transport/extension.js';
import { DeferredSession } from './transport/deferred.js';
import { loadAdapters } from './adapters/loader.js';
import { serveStdio } from './mcp/server.js';
import { Tab } from './api/tab.js';
import { toEnvelope } from './core/errors.js';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

interface CliArgs {
  connect?: string;
  extension?: string;
  mcp: boolean;
  probe: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mcp: false, probe: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--connect') args.connect = argv[++i];
    else if (arg === '--extension') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args.extension = next; i++; }
      else args.extension = '';
    }
    else if (arg === '--mcp') args.mcp = true;
    else if (arg === '--probe') args.probe = true;
  }
  if (!args.mcp && !args.probe) args.mcp = true;

  return args;
}

/** One orderly queue: MCP clients may call concurrently, the browser may not. */
function makeQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>
<h1>Probe page</h1>
<button id="b" onclick="setTimeout(function(){document.getElementById('out').textContent='clicked'},120)">Click me</button>
<p id="out">idle</p>
<a href="#next">Next</a>
<input aria-label="Name" placeholder="Name">
<select aria-label="Pick"><option>one</option><option>two</option></select>
<div style="height:2000px"></div>
<button style="display:none">hidden</button>
</body></html>`;

async function probe(session: BrowserSession): Promise<void> {
  const page = await session.newPage();
  const tab = new Tab(page);
  const log = (label: string, value: unknown) => console.log(`${label}:`, JSON.stringify(value, null, 2));

  // Chrome refuses data:/file: navigation over this CDP path, so serve the probe page locally.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PROBE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const probePort = typeof addr === 'object' && addr ? addr.port : 0;

  const nav = await tab.goto(`http://127.0.0.1:${probePort}/`);
  log('goto', nav);

  const observed = await tab.observe({ maxNodes: 100 });
  log('observe.summary', {
    url: observed.url,
    revision: observed.revision,
    total: observed.total,
    refs: observed.nodes.filter((n) => n.ref).map((n) => ({ ref: n.ref, role: n.role, name: n.name })),
  });

  const clickTarget = observed.nodes.find((n) => n.role === 'button' && /click/i.test(n.name));
  if (!clickTarget?.ref) throw new Error('probe: clickable button not found');
  const acted = await tab.act({ ref: clickTarget.ref, action: 'click', revision: observed.revision });
  log('act.click', acted);

  const after = await tab.observe({ maxNodes: 100 });
  const out = after.nodes.find((n) => n.name === 'clicked');
  log('effect.observed', { outText: out?.name ?? after.text.match(/clicked/)?.[0] ?? null });

  const text = await tab.read({ target: 'page', maxChars: 2000 });
  log('read', { chars: text.text.length, head: text.text.slice(0, 120) });

  const shot = await tab.screenshot({ format: 'png' });
  log('screenshot', { bytes: shot.bytes, mimeType: shot.mimeType });

  // Stale ref must be refused, not silently re-resolved.
  try {
    await tab.act({ ref: clickTarget.ref, action: 'click', revision: observed.revision + 99 });
    log('stale.guard', 'UNEXPECTED: stale revision was accepted');
  } catch (err) {
    log('stale.guard', toEnvelope(err));
  }

  server.close();
  await session.close();
}

const args = parseArgs(process.argv.slice(2));
const endpoint = args.connect ?? process.env.BROWSER_ENDPOINT ?? 'http://127.0.0.1:9222';

async function openSession(): Promise<BrowserSession> {
  if (args.extension !== undefined) {
    const stateFile =
      args.extension || (process.env.TABMCP_BROKER_STATE ??
        path.join(os.tmpdir(), 'tabmcp', 'broker.json'));
    return ExtensionSession.connect(stateFile);
  }
  return CdpSession.connect({ endpoint });
}

/** One pasteable command that brings up whatever the transport needs. */
function startHint(): string {
  if (args.extension !== undefined) {
    return (
      'Load the TabMCP extension in Chrome (chrome://extensions) and leave one tab open; ' +
      'it dials the native host itself. Then check `doctor` again.'
    );
  }
  return (
    'Start a browser with a debugging port first: ' +
    'Start-Process "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe" -ArgumentList @(' +
    '"--remote-debugging-port=9222", "--user-data-dir=$env:TEMP\\tabmcp-probe")'
  );
}

/**
 * The transport is opened on demand rather than at startup, so a browser that is not
 * running yet costs a tool call instead of the whole stdio connection.
 */
function deferredSession(): DeferredSession {
  if (args.extension !== undefined) {
    const stateFile =
      args.extension || (process.env.TABMCP_BROKER_STATE ??
        path.join(os.tmpdir(), 'tabmcp', 'broker.json'));
    return new DeferredSession({
      kind: 'extension',
      target: stateFile,
      hint: startHint(),
      open: () => ExtensionSession.connect(stateFile),
    });
  }
  return new DeferredSession({
    kind: 'cdp',
    target: endpoint,
    hint: startHint(),
    open: () => CdpSession.connect({ endpoint }),
  });
}

if (args.probe) {
  await probe(await openSession());
} else {
  const session = deferredSession();
  // Load the catalogue before serving so each adapter can be its own tool.
  const catalog = await loadAdapters().catch(() => ({ adapters: [], problems: [] }));
  await serveStdio({ session, queue: makeQueue(), catalog });
}






