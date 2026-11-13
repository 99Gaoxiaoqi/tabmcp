/**
 * MCP server: five tools over stdio.
 *
 * Every tool returns either `{ ok: true, ... }` or `{ ok: false, error: {code,
 * message, hint?, data?} }` as text, so an agent can branch on `code` instead of
 * parsing prose. Images come back as MCP image content.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ActionError, toEnvelope } from '../core/errors.js';
import { looksDeadMessage, type SessionNotice } from '../transport/deferred.js';
import type { BrowserSession } from '../transport/cdp.js';
import type { RuntimePage } from '../transport/page.js';
import { Tab } from '../api/tab.js';
import { findAdapter, loadAdapters, searchAdapters, type AdapterCatalog } from '../adapters/loader.js';
import { checkExpectation, runAdapter } from '../adapters/runner.js';
import { JsSession } from '../repl/session.js';
import { createReplGlobals } from '../repl/facade.js';
import { ReconRecorder, draftFromCandidate } from '../recon/capture.js';
import { DOCS, docsIndex, getDoc, listDocs } from '../docs/index.js';

/**
 * Tools whose repeat is harmless. A click and a js snippet are deliberately absent:
 * re-running them could act twice, and "may have clicked twice" is exactly the kind of
 * invisible wrong this project keeps removing. Anything not listed fails once and says
 * what replaced the page.
 */
export const RETRY_SAFE_TOOLS = [
  'browser_goto',
  'browser_observe',
  'browser_read',
  'browser_screenshot',
  'doctor',
] as const;

export interface ServerContext {
  session: BrowserSession;
  /** Serialises operations; one browser, one orderly queue. */
  queue: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Adapter sources; defaults are resolved lazily on first use. */
  adapterDirs?: { builtinDir?: string; userDir?: string };
  /** Preloaded catalogue; when present each adapter is also registered as its own tool. */
  catalog?: AdapterCatalog;
}

/** Host of a URL, empty when it cannot be parsed. */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    // chrome-error://chromewebdata and about:blank parse fine but name no site.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True when the page's host is the adapter's domain or a subdomain of it. */
export function hostMatches(url: string, domain: string): boolean {
  const host = hostOf(url);
  const wanted = domain.toLowerCase();
  return Boolean(host) && (host === wanted || host.endsWith('.' + wanted));
}

function text(value: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

export function createServer(context: ServerContext): McpServer {
  const server = new McpServer(
    { name: 'tabmcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // One Tab per page. The Tab owns the ref registry and the activity observer handle,
  // so building a new one per call made every ref stale immediately.
  const tabs = new WeakMap<RuntimePage, Tab>();

  /**
   * A call can be served by a different tab than the one the caller was using (the
   * browser died, or the tab was closed). Reconnecting silently would make an action
   * on the wrong page look like success, so the news travels with the result.
   */
  const takeSessionNotice = (): SessionNotice | null => {
    const session = context.session as BrowserSession & { takeNotice?: () => SessionNotice | null };
    return typeof session.takeNotice === 'function' ? session.takeNotice() : null;
  };

  /**
   * A page operation can fail because its page is gone (closed by the user, or the
   * browser restarted). Re-attaching and running the call once more is the difference
   * between "your tab vanished" and "this tool is broken" — but it must be honest, so
   * the retry is announced through the envelope.
   */
  const recoverSession = async (cause: string): Promise<boolean> => {
    const session = context.session as BrowserSession & { recover?: (cause: string) => Promise<boolean> };
    if (typeof session.recover !== 'function') return false;
    return session.recover(cause);
  };

  const RETRY_SAFE = new Set<string>(RETRY_SAFE_TOOLS);

  /** Turn on the page that took over, so the error can name it (read-only). */
  const resolveCurrentPage = async (): Promise<void> => {
    await context.session.activePage().catch(() => undefined);
  };

  /** Attach the replacement facts to an error envelope and say what to do next. */
  const annotateReplacedError = (envelope: unknown, info: SessionNotice | null, cause: string): unknown => {
    if (!envelope || typeof envelope !== 'object') return envelope;
    const body = envelope as Record<string, unknown>;
    const error = { ...((body.error ?? {}) as Record<string, unknown>) };
    const data = { ...((error.data ?? {}) as Record<string, unknown>) };
    data.sessionReplaced = true;
    data.previousTabId = info?.replaced?.previousTabId ?? null;
    data.currentTabId = info?.replaced?.currentTabId ?? null;
    data.replaceCause = cause;
    error.data = data;
    error.hint =
      'The page was replaced during this call. Re-observe and decide whether to retry: the action may already have happened.';
    return { ...body, error };
  };

  const deadCause = (body: unknown): string | null => {
    if (!body || typeof body !== 'object') return null;
    const error = (body as { error?: { message?: unknown } }).error;
    const message = typeof error?.message === 'string' ? error.message : '';
    return message && looksDeadMessage(message) ? message : null;
  };

  const withNotice = (body: unknown, notice: SessionNotice | null): unknown => {
    if (!notice || !body || typeof body !== 'object' || Array.isArray(body)) return body;
    const result = { ...(body as Record<string, unknown>) };
    if (notice.replaced) {
      result.sessionReplaced = true;
      result.previousTabId = notice.replaced.previousTabId;
      result.currentTabId = notice.replaced.currentTabId;
      result.replaceCause = notice.replaced.cause;
    }
    if (notice.unmatchedDeadText) {
      // Errors normally live under `error`; doctor reports the browser under `browserError`.
      const key = result.error ? 'error' : result.browserError ? 'browserError' : null;
      if (key) {
        const error = result[key] as Record<string, unknown>;
        const data = (error.data ?? {}) as Record<string, unknown>;
        result[key] = { ...error, data: { ...data, deadLikeTextUnmatched: notice.unmatchedDeadText } };
      } else {
        result.deadLikeTextUnmatched = notice.unmatchedDeadText;
      }
    }
    return result;
  };

  /**
   * Every tool result goes through here once, so no call site can forget to mention a
   * replacement. The text body is JSON for all tools except docs_get, whose prose is
   * left untouched.
   */
  const originalRegisterTool = server.registerTool.bind(server);
  (server as unknown as { registerTool: unknown }).registerTool = (
    name: string,
    config: unknown,
    handler: (...args: unknown[]) => Promise<{ content: { type: 'text'; text: string }[] }>,
  ) =>
    originalRegisterTool(name, config as never, (async (...args: unknown[]) => {
      let result = await handler(...args);
      let notice = takeSessionNotice();
      if (!notice?.replaced) {
        const first = result.content[0];
        let cause: string | null = null;
        try {
          cause = deadCause(JSON.parse(first.text));
        } catch {
          cause = null;
        }
        if (cause && (await recoverSession(cause))) {
          if (RETRY_SAFE.has(name)) {
            result = await handler(...args);
            notice = takeSessionNotice();
          } else {
            // The call may already have happened. Report it; never run it again.
            // Resolve first: the notice only knows which page took over once one is asked for.
            await resolveCurrentPage();
            const info = takeSessionNotice();
            const first = result.content[0];
            let body: unknown;
            try {
              body = JSON.parse(first.text);
            } catch {
              body = null;
            }
            if (body) {
              result = {
                ...result,
                content: [
                  { ...first, text: JSON.stringify(annotateReplacedError(body, info, cause), null, 2) },
                  ...result.content.slice(1),
                ],
              };
            }
            notice = null;
          }
        }
      }
      if (!notice) return result;
      const first = result.content[0];
      let parsed: unknown;
      try {
        parsed = JSON.parse(first.text);
      } catch {
        return result; // prose stays prose
      }
      const merged = withNotice(parsed, notice);
      return { ...result, content: [{ ...first, text: JSON.stringify(merged, null, 2) }, ...result.content.slice(1)] };
    }) as never);

  const tabFor = async (): Promise<Tab> => {
    const page = await context.session.activePage();
    const existing = tabs.get(page);
    if (existing) return existing;
    const created = new Tab(page);
    tabs.set(page, created);
    return created;
  };

  // After reload/back/forward the injected activity observer is gone. Touching the
  // page is enough to make the next observe() reinstall it lazily.
  const installAfterNavigation = async (tab: Tab): Promise<void> => {
    await tab.page.evaluate('void 0').catch(() => undefined);
  };

  const run = <T>(fn: () => Promise<T>) => context.queue(fn);

  // Adapters are discovered once per server start; a reload is a reconnect away.
  let catalogPromise: Promise<AdapterCatalog> | null = null;
  const catalog = (): Promise<AdapterCatalog> => {
    catalogPromise ??= loadAdapters({
      ...(context.adapterDirs?.builtinDir ? { builtinDir: context.adapterDirs.builtinDir } : {}),
      ...(context.adapterDirs?.userDir ? { userDir: context.adapterDirs.userDir } : {}),
    });
    return catalogPromise;
  };

  // One REPL per server: bindings belong to the session, and a reset drops them.
  let repl: JsSession | null = null;

  // Recon watches the extension's CDP events; transports without a stream say so.
  const recon = new ReconRecorder();
  let reconAttached = false;
  const attachRecon = (): boolean => {
    if (reconAttached) return true;
    if (!context.session.onNetworkEvent) return false;
    context.session.onNetworkEvent((event) => recon.ingest(event));
    reconAttached = true;
    return true;
  };

  server.registerTool(
    'doctor',
    {
      title: 'Doctor',
      description:
        'Self-check: browser connection, current tab, adapter catalogue, REPL state. Use it first when something looks wrong.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        // Doctor must answer even with no browser: it is the tool that explains why
        // nothing else works, so it cannot depend on the thing that is missing.
        const report: Record<string, unknown> = { ok: true, connected: false, transport: context.session.kind };
        try {
          const tabs = await context.session.pages();
          report.connected = true;
          report.tabs = tabs.length;
          const active = await context.session.activePage();
          report.activeTab = {
            id: active.id,
            url: await active.url().catch(() => ''),
            title: await active.title().catch(() => ''),
            retention: active.retention ?? null,
          };
          const frames = await active.frames().catch(() => []);
          report.frames = frames.length;
        } catch (err) {
          // A missing browser is a state to report, not a crash: keep ok:true and say so.
          report.connected = false;
          if (err instanceof ActionError) {
            report.browserError = { code: err.code, message: err.message, hint: err.hint ?? null };
          } else {
            report.browserError = { code: 'E_INTERNAL', message: err instanceof Error ? err.message : String(err), hint: null };
          }
        }
        try {
          const loaded = await catalog();
          report.adapters = {
            count: loaded.adapters.length,
            bySite: loaded.adapters.reduce<Record<string, number>>((acc, adapter) => {
              acc[adapter.site] = (acc[adapter.site] ?? 0) + 1;
              return acc;
            }, {}),
            problems: loaded.problems,
          };
        } catch (err) {
          report.adapters = { error: err instanceof Error ? err.message : String(err) };
        }
        report.repl = { bound: repl?.bindingCount ?? 0 };
        return { content: [text(report)] };
      }),
  );

  server.registerTool(
    'recon_start',
    {
      title: 'Start recording traffic',
      description:
        'Begin recording the page\'s own API calls. Drive the page (or ask the user to), then call recon_report to see which endpoints it uses.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        if (!attachRecon()) {
          return {
            content: [text({ ok: false, error: { code: 'E_UNSUPPORTED', message: 'this transport does not expose CDP events' } })],
            isError: true,
          };
        }
        recon.start();
        return { content: [text({ ok: true, recording: true })] };
      }),
  );

  server.registerTool(
    'recon_report',
    {
      title: 'Report recorded endpoints',
      description:
        'List the API endpoints observed since recon_start, most-used first, with method, path, status and query parameter names.',
      inputSchema: {
        stop: z.boolean().optional().describe('Stop recording before reporting'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ stop }) =>
      run(async () => {
        if (stop) recon.stop();
        const report = recon.report();
        return { content: [text({ ok: true, ...report })] };
      }),
  );

  server.registerTool(
    'recon_draft',
    {
      title: 'Draft an adapter from an endpoint',
      description:
        'Turn one recorded endpoint into adapter source. The draft is returned as text, not activated: finish the TODOs and verify before adding it.',
      inputSchema: {
        id: z.string().describe('Candidate id, e.g. "GET /api/items"'),
        site: z.string().describe('Directory name to place the adapter in'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, site }) =>
      run(async () => {
        const candidate = recon.get(id);
        if (!candidate) {
          throw new ActionError('E_TARGET_NOT_FOUND', `no recorded endpoint "${id}"`, {
            hint: 'Call recon_report to list what was recorded.',
          });
        }
        const draft = draftFromCandidate(candidate, site);
        return { content: [text({ ok: true, file: draft.file, source: draft.source })] };
      }),
  );

  server.registerTool(
    'docs_get',
    {
      title: 'Read a doc',
      description: 'No name lists the docs. With a name, returns that doc: quickstart, adapters, recon.',
      inputSchema: {
        name: z.string().optional().describe('Doc name; omit to list'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) =>
      run(async () => {
        if (!name) return { content: [text(docsIndex())] };
        const doc = getDoc(name);
        if (!doc) {
          throw new ActionError('E_TARGET_NOT_FOUND', `no doc "${name}"`, {
            hint: 'Call docs_get without a name to list them.',
          });
        }
        return { content: [text(doc.body.startsWith("#") ? doc.body : `# ${doc.title}\n\n${doc.body}`)] };
      }),
  );

  server.registerTool(
    'browser_navigate',
    {
      title: 'Reload or step through history',
      description: 'Reload the current page, or go back / forward in its history.',
      inputSchema: {
        action: z.enum(['reload', 'back', 'forward']),
      },
    },
    async ({ action }) =>
      run(async () => {
        try {
          const tab = await tabFor();
          if (action === 'reload') await tab.page.reload();
          else if (action === 'back') await tab.page.back();
          else await tab.page.forward();
          await installAfterNavigation(tab);
          return { content: [text({ ok: true, action, url: await tab.page.url().catch(() => '') })] };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  server.registerTool(
    'browser_cookies',
    {
      title: 'List cookies',
      description: 'List cookies visible to the page for a domain. Use for session or CSRF work in adapters.',
      inputSchema: {
        domain: z.string().describe('Domain to filter by'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ domain }) =>
      run(async () => {
        try {
          const tab = await tabFor();
          const cookies = await tab.page.cookies(domain);
          return { content: [text({ ok: true, count: cookies.length, cookies })] };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  server.registerTool(
    'browser_download',
    {
      title: 'Download a file',
      description: 'Click an element (by ref or selector) that starts a download, and wait for the file.',
      inputSchema: {
        ref: z.string().optional().describe('Element ref from observe'),
        selector: z.string().optional().describe('CSS selector, if no ref'),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
      },
    },
    async ({ ref, selector, timeoutMs }) =>
      run(async () => {
        try {
          const tab = await tabFor();
          const target = selector ?? (ref ? `[data-tabmcp-ref="${ref}"]` : undefined);
          if (!target) {
            throw new ActionError('E_BAD_ARGUMENT', 'pass ref or selector', { hint: 'Call browser_observe to get a ref.' });
          }
          const result = await tab.page.download({ selector: target, ...(timeoutMs ? { timeoutMs } : {}) });
          return { content: [text({ ok: true, ...result })] };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  server.registerTool(
    'browser_network_read',
    {
      title: 'Read recorded API traffic',
      description:
        'Read the JSON responses this page has already received, newest last, with a cursor. Use instead of scraping when the data comes from an endpoint.',
      inputSchema: {
        pattern: z.string().optional().describe('URL substring or /regex/'),
        limit: z.number().int().min(1).max(100).optional(),
        afterSequence: z.number().int().min(0).optional(),
        includeStatic: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pattern, limit, afterSequence, includeStatic }) =>
      run(async () => {
        try {
          const tab = await tabFor();
          const result = await tab.page.networkRead({
            ...(pattern ? { pattern } : {}),
            ...(limit ? { limit } : {}),
            ...(afterSequence !== undefined ? { afterSequence } : {}),
            ...(includeStatic !== undefined ? { includeStatic } : {}),
          });
          return { content: [text({ ok: true, ...result })] };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  server.registerTool(
    'js',
    {
      title: 'Browser JavaScript REPL',
      description:
        'Persistent JavaScript workspace. Variables, functions and classes survive between calls, and top-level await works. Globals: tab (goto/observe/act/read/screenshot/find/expect/cookie/fetchJson), sites (list/search/run), sleep. The last expression is returned.',
      inputSchema: {
        code: z.string().describe('JavaScript to run'),
        timeoutMs: z.number().int().min(100).max(300000).optional(),
        maxChars: z.number().int().min(500).max(120000).optional(),
      },
      annotations: { openWorldHint: true, destructiveHint: true },
    },
    async ({ code, timeoutMs, maxChars }) =>
      run(async () => {
        try {
          repl ??= new JsSession(
            createReplGlobals({
              tabFor,
              catalog,
              log: () => undefined,
            }),
          );
          const result = await repl.run(code, {
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(maxChars !== undefined ? { maxChars } : {}),
          });
          const payload = result.ok
            ? { ok: true, ...(result.value !== undefined ? { value: result.value } : {}), ...(result.writes.length ? { output: result.writes } : {}), defined: result.defined ?? [] }
            : { ok: false, error: result.error, ...(result.writes.length ? { output: result.writes } : {}) };
          return { content: [text(payload)], ...(result.ok ? {} : { isError: true }) };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  server.registerTool(
    'js_reset',
    {
      title: 'Reset JavaScript session',
      description: 'Drop every binding the REPL kept. Use when state is confusing the next step.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const before = repl?.bindingCount ?? 0;
        repl?.reset();
        repl = null;
        return { content: [text({ ok: true, cleared: before })] };
      }),
  );

  server.registerTool(
    'sites_search',
    {
      title: 'Find site adapters',
      description:
        'List installed site adapters: reusable, verified tools for specific sites. Search matches site, command and description. Empty query lists everything.',
      inputSchema: {
        query: z.string().optional().describe('Free text; empty lists all adapters'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) =>
      run(async () => {
        try {
          const loaded = await catalog();
          const hits = searchAdapters(loaded, query ?? '');
          const lines = hits.map((adapter) => {
            const args = (adapter.definition.args ?? [])
              .map((arg) => `${arg.name}${arg.required ? '*' : ''}:${arg.type ?? 'string'}`)
              .join(', ');
            return `${adapter.site} ${adapter.command} [${adapter.definition.access}] ${adapter.definition.description}${args ? ` (${args})` : ''}`;
          });
          return {
            content: [
              text({
                ok: true,
                count: hits.length,
                adapters: lines,
                ...(loaded.problems.length
                  ? { problems: loaded.problems.map((problem) => `${problem.file}: ${problem.problems.join('; ')}`) }
                  : {}),
              }),
            ],
          };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  server.registerTool(
    'site_run',
    {
      title: 'Run a site adapter',
      description:
        'Execute an installed adapter against the current tab and return structured JSON. If the adapter declares a domain and the tab is elsewhere this fails with E_WRONG_SITE; pass navigate:true to open the domain first.',
      inputSchema: {
        site: z.string().describe('Adapter site, e.g. "twitter"'),
        command: z.string().describe('Adapter command, e.g. "bookmark"'),
        args: z.record(z.string(), z.unknown()).optional().describe('Arguments per the adapter spec'),
        navigate: z
          .boolean()
          .optional()
          .describe('Navigate to the adapter domain first (default: require the current tab to be there)'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ site, command, args, navigate }) =>
      run(async () => {
        try {
          const loaded = await catalog();
          const adapter = findAdapter(loaded, site, command);
          if (!adapter) {
            throw new ActionError('E_TARGET_NOT_FOUND', `No adapter "${site} ${command}"`, {
              hint: 'Run sites_search to list installed adapters.',
            });
          }
          const tab = await tabFor();
          const domain = adapter.definition.domain;
          if (domain) {
            const current = await tab.page.url().catch(() => '');
            if (!hostMatches(current, domain)) {
              if (!navigate) {
                throw new ActionError(
                  'E_WRONG_SITE',
                  `Adapter "${site} ${command}" targets ${domain}, but the current tab is on ${hostOf(current) || 'an unknown page'}`,
                  {
                    hint: 'Navigate there first, or call again with navigate:true.',
                    data: { expected: domain, current: hostOf(current) },
                  },
                );
              }
              await tab.goto(`https://${domain}/`, { timeoutMs: 45_000 });
            }
          }
          const result = await runAdapter({ adapter, tab: tab.page, args: args ?? {} });
          return { content: [text(result)] };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  server.registerTool(
    'browser_goto',
    {
      title: 'Navigate',
      description:
        'Open a URL in the active tab and wait until the page has actually settled. Returns the final url, title and HTTP status.',
      inputSchema: {
        url: z.string().describe('Absolute http(s) URL'),
        waitUntil: z.enum(['load', 'domcontentloaded', 'none']).optional(),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
      },
      annotations: { openWorldHint: true },
    },
    async ({ url, waitUntil, timeoutMs }) =>
      run(async () => {
        try {
          const tab = await tabFor();
          const result = await tab.goto(url, {
            ...(waitUntil ? { waitUntil } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
          });
          return { content: [text(result)] };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  server.registerTool(
    'browser_observe',
    {
      title: 'Observe page',
      description:
        'Snapshot what is on the page: interactive elements with opaque refs, plus headings and landmarks for orientation. Use the returned refs with browser_act and browser_read.',
      inputSchema: {
        maxNodes: z.number().int().min(10).max(2000).optional(),
        maxChars: z.number().int().min(500).max(60000).optional(),
        includeStructure: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ maxNodes, maxChars, includeStructure }) =>
      run(async () => {
        try {
          const tab = await tabFor();
          const result = await tab.observe({
            ...(maxNodes ? { maxNodes } : {}),
            ...(maxChars ? { maxChars } : {}),
            ...(includeStructure !== undefined ? { includeStructure } : {}),
          });
          const header = `url: ${result.url}\ntitle: ${result.title}\nrevision: ${result.revision}\nnodes: ${result.nodes.length}/${result.total}${result.truncated ? ' (truncated)' : ''}`;
          return { content: [text(`${header}\n\n${result.text}`)] };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  server.registerTool(
    'browser_act',
    {
      title: 'Act on element',
      description:
        'Click, fill, press, select, hover or scroll an element by ref. Waits for the page to settle, then reports whether the action navigated, changed the page, or did nothing.',
      inputSchema: {
        ref: z.string().describe('Element ref from browser_observe'),
        action: z.enum(['click', 'fill', 'press', 'select', 'hover', 'scroll']),
        value: z.string().optional().describe('Text for fill, key for press, option value for select'),
        revision: z.number().int().optional().describe('Revision from observe(); rejects stale refs'),
        timeoutMs: z.number().int().min(500).max(60000).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ ref, action, value, revision, timeoutMs }) =>
      run(async () => {
        try {
          const tab = await tabFor();
          const result = await tab.act({
            ref,
            action,
            ...(value !== undefined ? { value } : {}),
            ...(revision !== undefined ? { revision } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
          });
          return { content: [text(result)] };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  server.registerTool(
    'browser_read',
    {
      title: 'Read text',
      description:
        'Read the visible text of the page or of one element by ref. Use maxChars to bound output; truncated output says how much was cut.',
      inputSchema: {
        target: z.string().optional().describe("'page' (default) or an element ref"),
        format: z.enum(['text', 'html']).optional(),
        maxChars: z.number().int().min(500).max(120000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ target, format, maxChars }) =>
      run(async () => {
        try {
          const tab = await tabFor();
          const result = await tab.read({
            ...(target ? { target } : {}),
            ...(format ? { format } : {}),
            ...(maxChars ? { maxChars } : {}),
          });
          return { content: [text(`url: ${result.url}\ntitle: ${result.title}\n\n${result.text}`)] };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Screenshot',
      description:
        'Capture the visible tab (or the full page) as an image. With annotate, numbered boxes mark interactive elements using the same refs the text tools use.',
      inputSchema: {
        fullPage: z.boolean().optional(),
        format: z.enum(['png', 'jpeg']).optional(),
        annotate: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ fullPage, format, annotate }) =>
      run(async () => {
        try {
          const tab = await tabFor();
          const result = await tab.screenshot({
            ...(fullPage !== undefined ? { fullPage } : {}),
            ...(format ? { format } : {}),
            ...(annotate !== undefined ? { annotate } : {}),
          });
          return {
            content: [
              { type: 'image' as const, data: result.base64, mimeType: result.mimeType },
              text({ ok: true, bytes: result.bytes, mimeType: result.mimeType }),
            ],
          };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  // Each adapter also appears as its own tool when the catalogue was preloaded.
  // That is the difference between "the agent must read a spec then call site_run"
  // and "the protocol validates the arguments".
  if (context.catalog) {
    for (const adapter of context.catalog.adapters) {
      const toolName = `${adapter.site}_${adapter.command}`.replace(/[^A-Za-z0-9_-]/g, '_');
      const schema: Record<string, z.ZodTypeAny> = {};
      for (const arg of adapter.definition.args ?? []) {
        const base = z.string();
        schema[arg.name] = arg.required ? base : base.optional();
      }
      server.registerTool(
        toolName,
        {
          title: `${adapter.site} ${adapter.command}`,
          description: `[adapter] ${adapter.definition.description}`,
          inputSchema: schema,
          annotations: { openWorldHint: true, destructiveHint: adapter.definition.access === 'write' },
        },
        async (args) =>
          run(async () => {
            try {
              const tab = await tabFor();
              const result = await runAdapter({ adapter, tab: tab.page, args: args as Record<string, unknown> });
              return { content: [text(result)] };
            } catch (err) {
              return { content: [text(toEnvelope(err))], isError: true };
            }
          }),
      );
    }
  }

  // Documentation is exposed both as a tool and as resources: some clients read
  // resources directly, others only call tools.
  server.registerResource(
    'docs',
    new ResourceTemplate('tabmcp://docs/{name}', {
      list: async () => ({ resources: listDocs().map((doc) => ({ uri: `tabmcp://docs/${doc.name}`, name: doc.name, title: doc.title, description: doc.summary })) }),
    }),
    { title: 'Documentation', description: 'How to use the tools and write adapters' },
    async (uri, variables) => {
      const name = String((variables as { name?: string }).name ?? '');
      const doc = getDoc(name) ?? DOCS[0]!;
      return { contents: [{ uri: uri.href, text: doc.body.startsWith("#") ? doc.body : `# ${doc.title}\n\n${doc.body}` }] };
    },
  );

  server.registerPrompt(
    'browse',
    {
      title: 'Browse a site for a goal',
      description: 'Explore with the browser tools until the goal is met.',
      argsSchema: { goal: z.string() },
    },
    ({ goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Goal: ${goal}\n\nWork in this order: browser_observe to see what is there, browser_act with the ref and revision, read the effect field. If the data comes from an endpoint, prefer browser_network_read over scraping text. If the page looks empty, say so instead of guessing.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'write-tool',
    {
      title: 'Turn a flow into an adapter',
      description: 'Explore a flow in the REPL, then codify it as an adapter.',
      argsSchema: { site: z.string(), goal: z.string() },
    },
    ({ site, goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Site: ${site}\nGoal: ${goal}\n\n1. recon_start, drive the flow, recon_report.\n2. Confirm the endpoint with tab.fetchJson in the REPL.\n3. recon_draft for the skeleton, then fill the argument meanings and result mapping.\n4. Save it under %APPDATA%/tabmcp/adapters/${site}/, verify with an expectation, and only then activate.`,
          },
        },
      ],
    }),
  );

  return server;
}

export async function serveStdio(context: ServerContext): Promise<void> {
  const server = createServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { ActionError };

