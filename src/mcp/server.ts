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
import type { BrowserSession, TabDescriptor } from '../transport/cdp.js';
import type { RuntimePage } from '../transport/page.js';
import { Tab } from '../api/tab.js';
import { findAdapter, loadAdapters, searchAdapters, type AdapterCatalog } from '../adapters/loader.js';
import { checkExpectation, runAdapter } from '../adapters/runner.js';
import type { ArgSpec } from '../sdk/index.js';
import { JsSession } from '../repl/session.js';
import { createReplGlobals } from '../repl/facade.js';
import { ReconRecorder, draftFromCandidate, type ApiCandidate } from '../recon/capture.js';
import { DOCS, docsIndex, getDoc, listDocs } from '../docs/index.js';
import { placeDownload } from '../core/downloads.js';

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
  'browser_tabs',
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

/**
 * Candidate ids are case-sensitive `METHOD path` keys, which is a fine key and a poor
 * thing to ask a caller to reproduce by hand: an agent that saw `GET /api/items` in a
 * report should not fail because it typed `get /api/items` or pasted only the path.
 *
 * Tried in order: exact key, case-insensitive key, path substring. Ambiguous input
 * resolves to the first candidate, which the report's most-used-first order makes the
 * sensible guess.
 */
export function matchCandidate(candidates: ApiCandidate[], wanted: string): ApiCandidate | undefined {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return undefined;
  const byPath = (value: string): boolean => value.toLowerCase().includes(needle);
  return (
    candidates.find((candidate) => candidate.id.toLowerCase() === needle) ??
    candidates.find((candidate) => byPath(candidate.path)) ??
    candidates.find((candidate) => byPath(`${candidate.method} ${candidate.path}`))
  );
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

  /**
   * Stickiness is deliberate, so the target does not follow the user's foreground tab.
   * What must not happen is acting on a background tab without saying so.
   */
  const focusDifference = async (toolName: string): Promise<{ current: string | null; foreground: string | null } | null> => {
    if (toolName === 'browser_tabs' || toolName === 'browser_tabs_select' || toolName === 'doctor') return null;
    const session = context.session as BrowserSession & {
      focusDifference?: () => Promise<{ current: string | null; foreground: string | null } | null>;
    };
    if (typeof session.focusDifference !== 'function') return null;
    return session.focusDifference().catch(() => null);
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
  /**
   * The structured body is not always the first content part: `browser_observe` and
   * `browser_read` lead with their compact prose so a reader gets the page, not a code
   * block, and carry the same facts as JSON in a second part.
   *
   * Looking only at index 0 made those two tools silently ineligible for session
   * recovery and for the `sessionReplaced` notice: the parse threw, the code treated
   * that as "no cause" and "prose stays prose". Find the JSON part instead.
   */
  const jsonPartIndex = (result: { content: { type: 'text'; text: string }[] }): number =>
    result.content.findIndex((part) => {
      if (part.type !== 'text') return false;
      try {
        const parsed: unknown = JSON.parse(part.text);
        return Boolean(parsed) && typeof parsed === 'object';
      } catch {
        return false;
      }
    });

  /** Replace one content part in place, leaving every other part byte-identical. */
  const replacePart = (
    result: { content: { type: 'text'; text: string }[] },
    index: number,
    value: unknown,
  ): { content: { type: 'text'; text: string }[] } => ({
    ...result,
    content: result.content.map((part, i) =>
      i === index ? { ...part, text: JSON.stringify(value, null, 2) } : part,
    ),
  });

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
        let cause: string | null = null;
        const idx = jsonPartIndex(result);
        if (idx >= 0) {
          try {
            cause = deadCause(JSON.parse(result.content[idx].text));
          } catch {
            cause = null;
          }
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
            const after = jsonPartIndex(result);
            if (after >= 0) {
              try {
                const body: unknown = JSON.parse(result.content[after].text);
                result = replacePart(result, after, annotateReplacedError(body, info, cause));
              } catch {
                // Unparseable stays untouched; nothing was rewritten.
              }
            }
            notice = null;
          }
        }
      }
      // Stickiness is deliberate; acting on a tab the user is not looking at is not
      // something the caller should have to infer from a url.
      const diff = await focusDifference(name);
      if (!notice && !diff) return result;
      const idx = jsonPartIndex(result);
      if (idx < 0) return result; // prose stays prose
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.content[idx].text);
      } catch {
        return result;
      }
      const merged = withNotice(parsed, notice);
      const withFocus =
        diff && merged && typeof merged === 'object' && !Array.isArray(merged)
          ? { ...(merged as Record<string, unknown>), tabFocusDiffers: diff }
          : merged;
      return replacePart(result, idx, withFocus);
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

  /**
   * Both adapter entry points (`site_run` and the per-adapter `<site>_<command>` tools)
   * have to answer "the tab is on the wrong site" identically: same code, same data
   * shape, same offer to navigate. It lives in one function for exactly that reason -
   * two copies drift, and the caller cannot tell which entry it used from the error.
   */
  /**
   * One argument's schema, from the adapter's own spec. Numbers and booleans arrive as
   * strings from most clients, so they are coerced - but only where coercion cannot
   * change the meaning:
   *
   *  - `int`/`number` -> `z.coerce.number()`; `"20"` and `20` are the same number.
   *  - `boolean` deliberately NOT `z.coerce.boolean()`: that is `Boolean(x)`, so the
   *    string `"false"` becomes **true**. A caller writing `flag=false` would get the
   *    opposite of what they asked for, with no error anywhere. Only the spellings that
   *    are unambiguous are accepted, and anything else is rejected rather than guessed.
   *  - `array`/`object` keep their shape; a comma-separated string is not an array, and
   *    pretending it is would hide a caller's mistake.
   */
  const schemaForArg = (arg: ArgSpec): z.ZodTypeAny => {
    let base: z.ZodTypeAny;
    switch (arg.type) {
      case 'int':
      case 'number':
        base = z.coerce.number();
        break;
      case 'boolean':
        base = z
          .union([z.boolean(), z.string()])
          .transform((value) => {
            if (typeof value === 'boolean') return value;
            const text = value.trim().toLowerCase();
            if (text === 'true' || text === '1') return true;
            if (text === 'false' || text === '0') return false;
            return null;
          })
          .refine((value): value is boolean => value !== null, {
            message: 'expected a boolean: true, false, 1 or 0',
          });
        break;
      case 'array':
        base = z.array(arg.items?.type === 'number' || arg.items?.type === 'int' ? z.coerce.number() : z.string());
        break;
      case 'object':
        base = z.record(z.string(), z.unknown());
        break;
      default:
        base = z.string();
    }
    if (arg.choices?.length) {
      // `choices` is the adapter saying "these values and no others". Refine rather than
      // `z.union([base, z.enum(...)])`: base already accepts any string, so the union would
      // swallow the enum whole and enforce nothing - a check that always passes.
      const allowed = new Set(arg.choices.map((choice) => String(choice)));
      const listed = [...allowed].join(', ');
      base = base.refine((value) => allowed.has(String(value)), {
        message: `expected one of: ${listed}`,
      });
    }
    const notes: string[] = [];
    if (arg.help) notes.push(arg.help);
    if (arg.example !== undefined) notes.push(`e.g. ${JSON.stringify(arg.example)}`);
    if (arg.default !== undefined) notes.push(`default: ${JSON.stringify(arg.default)}`);
    if (notes.length) base = base.describe(notes.join(' '));
    return arg.required ? base : base.optional();
  };

  const ensureAdapterDomain = async (
    label: string,
    domain: string | undefined,
    tab: Tab,
    navigate: boolean,
  ): Promise<void> => {
    if (!domain) return;
    const currentUrl = await tab.page.url().catch(() => '');
    if (hostMatches(currentUrl, domain)) return;
    if (!navigate) {
      throw new ActionError(
        'E_WRONG_SITE',
        `Adapter "${label}" targets ${domain}, but the current tab is on ${hostOf(currentUrl) || 'an unknown page'}`,
        {
          hint: 'Navigate there first, or call again with navigate:true.',
          data: { expected: domain, current: hostOf(currentUrl) },
        },
      );
    }
    await tab.goto(`https://${domain}/`, { timeoutMs: 45_000 });
  };

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
          // These two getters exist on the Playwright-backed page but are not part of the
          // RuntimePage contract, so read them defensively. Without doctor surfacing them
          // the only symptom of a failed attach or a failed observer install is "every
          // action waited out its cap" - a fact nobody can act on.
          const diagnostics = active as RuntimePage & {
            networkDiagnostics?: string;
            activityDiagnostics?: string;
          };
          const networkError = diagnostics.networkDiagnostics;
          const activityError = diagnostics.activityDiagnostics;
          report.activeTab = {
            id: active.id,
            url: await active.url().catch(() => ''),
            title: await active.title().catch(() => ''),
            retention: active.retention ?? null,
            ...(networkError ? { networkError } : {}),
            ...(activityError ? { activityError } : {}),
          };
          // Attach failures are session-scoped (a page that refused the debugger), so they
          // are reported beside the tab, not inside it.
          const withAttach = context.session as BrowserSession & {
            networkAttachDiagnostics?: () => Array<{ url: string; error: string }>;
          };
          const attachErrors =
            typeof withAttach.networkAttachDiagnostics === 'function' ? withAttach.networkAttachDiagnostics() : [];
          if (attachErrors.length) report.networkAttachErrors = attachErrors;
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
    'browser_tabs',
    {
      title: 'List tabs',
      description:
        'List every tab this session may use: id, url, title, whether it is the current target, ' +
        'and whether the user is looking at it. Use the ids with browser_tabs_select.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        try {
// `TabDescriptor` is the single definition; a hand-copied inline shape here
          // would drift the moment a field is added (it already did once).
          const session = context.session as BrowserSession & {
            tabList?: () => Promise<TabDescriptor[]>;
          };
          if (typeof session.tabList !== 'function') {
            throw new ActionError('E_TARGET_UNSUPPORTED', 'this transport cannot list tabs', {
              hint: 'Use doctor for the current tab.',
            });
          }
          const tabs = await session.tabList();
// Which signal produced `foreground`. Kept next to the data rather than in a
          // comment, because the two channels do not measure the same thing and a reader
          // cannot tell them apart from the values alone.
          const foregroundSignal = context.session.kind === 'extension' ? 'active' : 'visibility';
          return { content: [text({ ok: true, count: tabs.length, foregroundSignal, tabs })] };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
      }),
  );

  server.registerTool(
    'browser_tabs_select',
    {
      title: 'Choose the target tab',
      description:
        'Make one tab the default target for later calls. This is sticky - it does not follow ' +
        'the foreground tab, and it does not bring the tab to the front.',
      inputSchema: {
        id: z.string().describe('Tab id from browser_tabs (e.g. pw-1a2b3c4d or ext-123)'),
      },
    },
    async ({ id }) =>
      run(async () => {
        try {
          const session = context.session as BrowserSession & { selectTab?: (tabId: string) => Promise<void> };
          if (typeof session.selectTab !== 'function') {
            throw new ActionError('E_TARGET_UNSUPPORTED', 'this transport cannot select a tab', {
              hint: 'Use doctor to see the current tab.',
            });
          }
          await session.selectTab(id);
          return { content: [text({ ok: true, selected: id })] };
        } catch (err) {
          return { content: [text(toEnvelope(err))], isError: true };
        }
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
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Max candidates to return (default 30)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ stop, limit }) =>
      run(async () => {
        if (stop) recon.stop();
        const report = recon.report();
        const cap = limit ?? 30;
        const total = report.candidates.length;
        // lastRequestId is a recorder-internal handle (a CDP request id). It was being
        // returned, where it only ever read as a cursor that could be passed back.
        const candidates = report.candidates
          .slice(0, cap)
          .map(({ lastRequestId: _ignored, ...rest }) => rest);
        return {
          content: [
            text({
              ok: true,
              active: report.active,
              requests: report.requests,
              ignored: report.ignored,
              total,
              hasMore: total > cap,
              candidates,
            }),
          ],
        };
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
        const candidate = recon.get(id) ?? matchCandidate(recon.report().candidates, id);
        if (!candidate) {
          throw new ActionError('E_TARGET_NOT_FOUND', `no recorded endpoint "${id}"`, {
            hint: 'Call recon_report to list what was recorded.',
          });
        }
        const draft = draftFromCandidate(candidate, site);
        return { content: [text({ ok: true, file: draft.file, source: draft.source })] };
      }),
  );

  // The doc names in the description are derived, not typed out here: the hand-written
  // list had already drifted (it was missing `tools` and `channels`), and a description
  // that lies about its own inventory is the cheapest possible wrong answer.
  const docNames = listDocs()
    .map((doc) => doc.name)
    .join(', ');

  server.registerTool(
    'docs_get',
    {
      title: 'Read a doc',
      description: `No name lists the docs. With a name, returns that doc: ${docNames}. Arguments other than name are rejected, so a typo does not silently return the index instead.`,
      // `.strict()` rather than a raw shape: an unknown key must be an error. Called with
      // {"topic":"tools"} this used to answer with the index and isError:false in 2ms.
      inputSchema: z
        .object({
          name: z.string().optional().describe('Doc name; omit to list'),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ name }: { name?: string }) =>
      run(async () => {
        if (!name) return { content: [text(docsIndex())] };
        const doc = getDoc(name);
        if (!doc) {
          throw new ActionError('E_TARGET_NOT_FOUND', `no doc "${name}"`, {
            hint: `Call docs_get without a name to list them. Available: ${docNames}.`,
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
      // Navigation reaches the network, so it is open-world. It is not destructive: it
      // moves the browser, it does not write anything. Same reading as browser_goto.
      annotations: { openWorldHint: true },
    },
    async ({ action }) =>
      run(async () => {
        try {
          const tab = await tabFor();
          // The status belongs to the landing, not to the button: a reload is the most
          // common way to land on the login page or the 404 you already had.
          const landed =
            action === 'reload'
              ? await tab.page.reload()
              : action === 'back'
                ? await tab.page.back()
                : await tab.page.forward();
          await installAfterNavigation(tab);
          const status = landed.status;
          const pageError = typeof status === 'number' && status >= 400;
          return {
            content: [
              text({
                ok: true,
                action,
                url: await tab.page.url().catch(() => ''),
                status,
                ...(pageError ? { pageError: true } : {}),
              }),
            ],
          };
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
      description:
        'Click an element (by ref or selector) that starts a download, and wait for the file. ' +
        'Without dir the file stays in a temporary folder with no extension; pass dir to keep it ' +
        'under its real name.',
      inputSchema: {
        ref: z.string().optional().describe('Element ref from observe'),
        selector: z.string().optional().describe('CSS selector, if no ref'),
        dir: z
          .string()
          .optional()
          .describe('Directory to save into, under the real file name. Created if missing.'),
        filename: z.string().optional().describe('Override the saved file name (only with dir).'),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
      },
    },
    async ({ ref, selector, dir, filename, timeoutMs }) =>
      run(async () => {
        try {
          const tab = await tabFor();
          const target = selector ?? (ref ? `[data-tabmcp-ref="${ref}"]` : undefined);
          if (!target) {
            throw new ActionError('E_BAD_ARGUMENT', 'pass ref or selector', { hint: 'Call browser_observe to get a ref.' });
          }
          const captured = await tab.page.download({ selector: target, ...(timeoutMs ? { timeoutMs } : {}) });
          // Without dir this is the raw capture, unchanged; with dir the file is copied out.
          const result = await placeDownload(captured, {
            ...(dir ? { dir } : {}),
            ...(filename ? { filename } : {}),
          });
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
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(200000)
          .optional()
          .describe(
            'Cap on the JSON returned (default 30000). Entries are dropped whole, never cut mid-body, and the reply says how many.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pattern, limit, afterSequence, includeStatic, maxChars }) =>
      run(async () => {
        try {
          const tab = await tabFor();
          const result = await tab.page.networkRead({
            ...(pattern ? { pattern } : {}),
            ...(limit ? { limit } : {}),
            ...(afterSequence !== undefined ? { afterSequence } : {}),
            ...(includeStatic !== undefined ? { includeStatic } : {}),
          });
          const cap = maxChars ?? 30_000;
          // Drop whole entries from the end rather than slicing the string: a body cut in
          // the middle reads as a short body instead of a truncated one.
          const kept = [...result.entries];
          let truncatedEntries = 0;
          while (kept.length > 0 && JSON.stringify(kept).length > cap) {
            kept.pop();
            truncatedEntries += 1;
          }
          return {
            content: [
              text({
                ok: true,
                cursor: result.cursor,
                entries: kept,
                hasMore: result.hasMore,
                truncated: truncatedEntries > 0 || result.hasMore,
                truncatedEntries,
                chars: JSON.stringify(kept).length,
              }),
            ],
          };
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
        'Persistent JavaScript workspace. Variables, functions and classes survive between calls, and top-level await works. Globals: tab (url/title/goto/observe/act/read/screenshot/find/expect/cookie/cookies/frames/reload/back/forward/download/contentState/networkRead/evaluateInFrame/fetchJson), sites (list/search/run), sleep, log. The last expression is returned. A failure comes back as { ok:false, error:{ code, message, hint?, data? } }, the same envelope as every other tool.',
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
          if (result.ok) {
            return {
              content: [
                text({
                  ok: true,
                  ...(result.value !== undefined ? { value: result.value } : {}),
                  ...(result.writes.length ? { output: result.writes } : {}),
                  defined: result.defined ?? [],
                }),
              ],
            };
          }
          // A snippet that fails is the caller's to fix, so it travels as a coded envelope
          // instead of { ok:false, error:{message} }, which forced a caller to match prose.
          // Note: the code union has E_BAD_ARGUMENT, not the E_ACTION_ARGUMENT the task
          // named; errors.ts belongs to another slice, so the closer existing code is used.
          const message = result.error?.message ?? 'script failed';
          const timedOut = /execution timed out after|promise did not settle within/i.test(message);
          const syntax = result.error?.name === 'SyntaxError';
          const failure = new ActionError(
            timedOut ? 'E_ACTION_TIMEOUT' : syntax ? 'E_BAD_ARGUMENT' : 'E_ACTION_FAILED',
            message,
            {
              ...(timedOut
                ? { hint: 'Raise timeoutMs, or await the promise inside the snippet instead of returning it.' }
                : {}),
              ...(syntax ? { hint: 'Fix the syntax: nothing was executed.' } : {}),
              ...(result.writes.length ? { data: { output: result.writes } } : {}),
            },
          );
          return { content: [text(toEnvelope(failure))], isError: true };
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
          await ensureAdapterDomain(`${site} ${command}`, adapter.definition.domain, tab, navigate === true);
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
          // Prose first: the snapshot is meant to be read. The same facts as JSON ride
          // second so the wrapper's parse succeeds and session recovery applies to this
          // tool at all.
          return {
            content: [
              text(`${header}\n\n${result.text}`),
              text({
                ok: true,
                url: result.url,
                title: result.title,
                revision: result.revision,
                nodes: { shown: result.nodes.length, total: result.total, truncated: result.truncated },
                // No body here on purpose: the snapshot text is already in part 0, and a
                // second copy would double the payload for every observe call.
                truncated: result.truncated,
                chars: result.text.length,
              }),
            ],
          };
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
          // Prose first for readability; JSON second so truncation is a field a caller can
          // branch on rather than a sentence it has to match.
          return {
            content: [
              text(`url: ${result.url}\ntitle: ${result.title}\n\n${result.text}`),
              text({
                ok: true,
                url: result.url,
                title: result.title,
                target: result.target,
                // Body stays in part 0 only; this part is metadata.
                truncated: result.truncated,
                chars: result.text.length,
              }),
            ],
          };
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
      const specArgs = adapter.definition.args ?? [];
      // An adapter may declare its own `navigate` argument; if it does, that argument is
      // the adapter's, and this tool must not quietly take it over.
      const ownsNavigate = !specArgs.some((arg) => arg.name === 'navigate');
      const schema: Record<string, z.ZodTypeAny> = {};
      for (const arg of specArgs) schema[arg.name] = schemaForArg(arg);
      if (ownsNavigate) {
        schema.navigate = z
          .boolean()
          .optional()
          .describe('Navigate to the adapter domain first (default: require the current tab to be there)');
      }
      server.registerTool(
        toolName,
        {
          title: `${adapter.site} ${adapter.command}`,
          description: `[adapter] ${adapter.definition.description}`,
          inputSchema: schema,
          annotations: { openWorldHint: true, destructiveHint: adapter.definition.access === 'write' },
        },
        async (raw) =>
          run(async () => {
            try {
              const tab = await tabFor();
              const { navigate, ...adapterArgs } = raw as Record<string, unknown>;
              const wantsNavigate = ownsNavigate && navigate === true;
              await ensureAdapterDomain(
                `${adapter.site} ${adapter.command}`,
                adapter.definition.domain,
                tab,
                wantsNavigate,
              );
              const result = await runAdapter({ adapter, tab: tab.page, args: adapterArgs });
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

