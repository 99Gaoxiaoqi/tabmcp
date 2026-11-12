# browsermcp-core

> **Independent implementation.** This project is not affiliated with
> [`jackwener/BrowserMCP`](https://github.com/jackwener/BrowserMCP) or the `BrowserMCP`
> organisation. No source code was copied from either. The public behaviour of the
> reference project was studied to align tool shapes and failure modes; the
> implementation here was written from scratch. If any fragment turns out to be a
> recognizable derivative, it will be attributed in `NOTICE`.


Behavior-aligned, independently written browser MCP core.

Five tools over MCP stdio — `browser_goto`, `browser_observe`, `browser_act`,
`browser_read`, `browser_screenshot` — backed by Playwright's CDP connection.

No code from BrowserMCP is copied. The behaviors that make it feel responsive
are reproduced from a written spec:

| Behavior | Where | Rule |
|---|---|---|
| Event-based settle | `src/core/settle.ts` | Settled when the document is parsed, no request the action started is in flight, and the DOM has been quiet for `quietMs` |
| Action effect | `src/core/settle.ts` | Every action reports `navigated` / `changed` / `none` / `unknown` |
| Fast not-found | `src/core/settle.ts` | A missing target answers once the page has been quiet for `notFoundQuietMs`, never faster than `notFoundMinWaitMs` |
| Opaque refs | `src/core/refs.ts` | `e<generation-hex>_<n>`; stale generations are refused, not re-resolved |
| Bounded ARIA-ish snapshot | `src/core/snapshot.ts` | Interactive nodes carry refs; headings/landmarks give orientation; output bounded by node and char count |
| Activity incl. shadow DOM | `src/core/activity.ts` | MutationObserver on the document plus scanned/patch-attached shadow roots |
| Branchable errors | `src/core/errors.ts` | `{ ok: false, error: { code, message, hint?, data? } }` |

## Run

```bash
npm install
npm run build

# Attach to a Chrome started with a debugging port
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/probe
node dist/src/main.js --connect http://127.0.0.1:9222        # MCP over stdio
node dist/src/main.js --connect http://127.0.0.1:9222 --probe # self-test
```

MCP client config:

```json
{
  "mcpServers": {
    "browsermcp-core": {
      "command": "node",
      "args": ["<absolute-path-to>/dist/src/main.js", "--connect", "http://127.0.0.1:9222"]
    }
  }
}
```

## Tuning

`DEFAULT_TUNING` in `src/core/settle.ts` is a starting point, not a truth:

```ts
quietMs: 100            // DOM + network quiet window
notFoundQuietMs: 2000   // page quiet this long => target really missing
notFoundMinWaitMs: 500  // but give a fresh page at least this long
loadingCapMs: 3000      // extra room while the document parses
```

Measure on real sites and adjust; a slow intranet form needs different numbers
than a static page.

## Tests

```bash
npm test    # settle contract (fake activity source) + MCP round-trip when a browser is up
```

## Not done yet

- Extension transport (MV3 + native messaging) — the `BrowserSession` interface in
  `src/transport/cdp.ts` is the seam; the API layer does not change.
- Persistent JS REPL, named tab groups, session recovery, per-agent isolation.
- Site adapters and recon.

## M2: extension transport (verified end to end)

The extension path is verified: `goto`, `observe`, `act` (reported `effect: changed`),
`read` (returned the text the click produced), `screenshot`, and the stale-ref guard all
worked through Chrome -> extension -> native host -> broker -> MCP.

Three real defects were found and fixed while wiring it up:

1. **Chrome 137+ ignores `--load-extension`.** Load the unpacked extension via CDP:
   launch Chrome with `--enable-unsafe-extension-debugging`, then call
   `Extensions.loadUnpacked`. The id is key-derived (`manifest.key`), so it is stable.
2. **Background tabs receive neither input nor screenshots.** Input needs
   `Emulation.setFocusEmulationEnabled` and capture needs `Page.bringToFront`; without
   them a click silently does nothing and a screenshot hangs until timeout.
3. **`chrome.debugger` outlives the service worker.** After the MV3 worker is recycled,
   `attach` fails with "Another debugger is already attached"; that must be treated as
   already-attached rather than an error.

Windows note: a native messaging host is launched from `path` with no arguments, so a
`.cmd` wrapper does not work. `launcher/Launcher.cs` builds `native-host.exe`, which pumps
stdin/stdout into Node.

### Run the extension path

```bash
node scripts/setup-extension.mjs          # host manifest + HKCU registry, prints extension id
npm run build

# 1. launch Chrome with a scratch profile
chrome --remote-debugging-port=9445 --user-data-dir=<tmp> --enable-unsafe-extension-debugging

# 2. load the unpacked extension (one CDP call)
node load-ext.mjs                          # or Extensions.loadUnpacked via CDP

# 3. talk to it
node dist/src/main.js --extension --probe
node dist/src/main.js --extension          # MCP over stdio
```

## Calibration on a real site (2026-11-12)

Measured against `so.szlcsc.com` in the owner's everyday Chrome, loaded tab, logged-in session:

| Operation | Latency | Notes |
|---|---|---|
| `observe` | 72 ms | 332 nodes after dropping `list`/`listitem` noise (was 635) |
| `act fill` (in page) | 290 ms | `effect: changed`, `settled: true` |
| `act click` (navigates) | 3.35 s | `effect: navigated`, `settled: true` |
| missing ref | 1.08 s | `E_TARGET_NOT_FOUND` — fast-fail, not the 5 s ceiling |

Four defects the real site exposed, all fixed:

1. **Every in-page action waited the full 10 s navigation timeout.** The navigation
   promise was awaited instead of raced; a click that only edited the page blocked
   until timeout. Now the nav promise is raced with a 50 ms window.
2. **Settling after navigation never completed.** Navigation replaces the document and
   takes the injected observer with it, so activity reads came back null and settle
   waited out the cap. The activity source now reinstalls the observer on miss.
3. **"No requests in flight" is unreachable on real pages.** Analytics/long-poll
   connections stay open, so settle could never be quiet. Added `pendingGraceMs`: once
   the DOM is quiet with a request open past the grace window, stop waiting on it.
4. **A successful navigation reported `settled: false`.** When the page reacted but the
   first window expired, a second wider settle now runs before reporting.

Calibrated defaults (were guesses): `quietMs 120`, `notFoundQuietMs 700`,
`notFoundMinWaitMs 300`, `loadingCapMs 4000`, `pendingGraceMs 1200`.
`list`/`listitem` are no longer emitted as structure nodes — they were 138 of 635 nodes
and carried no navigating value.

## Aligned with BrowserMCP's timing model (2026-11-12)

The slow path was structural, not a constant: navigation watching and settling ran one
after the other, and a second wider pass was added when the first window expired. That
made a navigating click cost the sum of both windows.

Now it matches the reference behavior:

```ts
const [navHit, settled] = await Promise.all([
  Promise.race([navPromise, delay(NAV_CLASSIFY_MS)]),   // 300ms: did a nav start?
  settle(source, started, options.settleMs ?? DEFAULT_SETTLE_MS, tuning), // 1000ms
]);
```

The caller pays the larger window, not the sum, and no second pass runs.

| Operation | Before | After |
|---|---|---|
| click that navigates | 3.35 s, `settled: true` | 2.00 s, `settled: false`, `pendingRequests: 2` |
| fill in page | 290 ms | 709 ms (page was animating; bounded by the 1000 ms window) |
| missing ref | 1.08 s | 0.99 s |
| observe | 72 ms | 47 ms |

`settled: false` is not a failure: it means the page was still moving when the window
closed, which is the honest answer and what the reference implementation reports too.
An agent that needs certainty calls `observe` again — one extra round trip instead of
forcing every action to block until the page is perfectly still.

## Tests: what runs where, and why one used to skip

`npm test` runs 24 tests across four files:

| File | Tests | Needs a browser |
|---|---|---|
| `settle.test.ts` | 11 | no (fake activity source) |
| `protocol.test.ts` | 6 | no |
| `broker.test.ts` | 3 | no |
| `mcp-fake.test.ts` | 3 | no (fake transport) |
| `mcp.test.ts` | 1 | **yes** |

The browser-backed MCP test spawns the real server over stdio and drives Chrome. On a
machine without a browser on `BROWSER_ENDPOINT` it now:

- **skips with a visible reason**, and
- **fails instead** when `REQUIRE_BROWSER=1` is set, so a CI environment that expects a
  browser cannot silently pass.

`mcp-fake.test.ts` covers tool registration, argument validation, the success envelope
and the error envelope without any browser, so the MCP layer is never untested just
because Chrome is not running.

## Site adapters (BrowserMCP-compatible shape)

An adapter is data plus one function; the data becomes the MCP tool schema.

```js
// %APPDATA%/browsermcp-core/adapters/demo/list.js
export default {
  description: 'List entries on the demo site',
  access: 'read',
  domain: 'demo.example',
  args: [{ name: 'limit', type: 'int', default: 20, help: 'How many rows' }],
  async run({ tab, args }) {
    // tab.cookie() + tab.fetchJson() hit the site's own API with the user's session
    const csrf = await tab.cookie('csrf', { domain: '.demo.example' });
    const data = await tab.fetchJson(`/api/items?limit=${args.limit}`, { headers: { 'x-csrf': csrf ?? '' } });
    return { items: data.items };
  },
};
```

Tools: `sites_search` lists adapters (site, command, access, args), `site_run` executes one.
Adding a site means dropping a file in the adapters directory — no rebuild.

**Drafts do not appear as tools.** A candidate adapter is stored as a draft with an
`expect` (e.g. `{ minRows: 3, result_path: 'items' }`); `DraftStore.activate()` refuses
until `markVerified()` has run on a passing result. Automation can therefore propose
adapters without polluting the tool list with guesses.

### Runtime additions this required

`RuntimePage` gained the four operations adapters need, implemented on both transports:

| Method | Why |
|---|---|
| `cookie(name, {domain})` | CSRF/auth tokens for the site's own API |
| `fetchJson(url, {method,headers,body})` | request from the page context, so it carries the session |
| `find({role,name,text,css})` | locate elements when the agent has no ref |
| `expect({selector,text,url},{timeoutMs})` | assert a condition instead of guessing timings |

Tests: 31 total (30 pass, 1 skipped) — adapter validation, argument coercion, loader
discovery, runner error mapping, expectation checking, draft activation gating.

## JavaScript REPL (`js`, `js_reset`)

The agent's primary workspace: one persistent JavaScript context per MCP session.

```js
// call 1
const snap = await tab.observe({ maxNodes: 200 });
snap.nodes.filter(n => n.role === 'button').map(n => n.name)
// → ["搜索", "上传BOM", "商品分类", ...]

// call 2 — snap is still there
snap.total   // → 339
```

Globals: `tab` (goto/observe/act/read/screenshot/find/expect/cookie/fetchJson),
`sites` (list/search/run), `sleep`, `log`.

How it stays useful across calls:

- **Bindings persist** because top-level declarations are re-attached to the context
  after each run — without that they would die with the wrapper function.
- **Top-level `await` works** because the wrapper is async, and a trailing expression is
  detected by compiling it as `(async () => (expr))`, not by guessing from line shape.
- **`js_reset`** drops every binding when stale state is confusing the next step.
- A timeout stops waiting; it cannot kill code already running, so the tool says so
  rather than pretending the work was cancelled.

Measured on the real site (logged-in Chrome, 立创 search page):

| Step | Latency |
|---|---|
| `tab.observe()` inside REPL, then filter 200 nodes | 118 ms |
| `tab.find({role:'button',name:'搜索'})` | returns two refs |
| `tab.expect({text:'螺丝'}, 1500ms)` | 2 ms, ok |

Tests: 12 REPL-specific (persistence, classes, top-level await, console capture,
errors, syntax errors, timeout, reset, truncation), plus two MCP-level tests that drive
the `js` tool through a real MCP client.

## Tab ownership, doctor, frames

**Ownership.** A tab the agent creates is scratch: it is closed when the session ends.
`markDeliverable()` / `markHandoff()` / `clearRetention()` change that; tabs the user
opened are never closed. Verified on a real browser:

```
before 4 tabs → agent opens one (5) → session closes → back to 4, scratch tab gone
before 3 tabs → agent opens one and marks it handoff → session closes → stays 4
```

**doctor** reports transport, tab count, active tab (url/title/retention), frame count,
adapter catalogue (count, by-site, load problems) and REPL binding count — the first
thing to call when something looks wrong, instead of guessing.

**frames()** lists the page's frames on both transports (`Page.getFrameTree` on the
extension path, `page.frames()` on the Playwright path).

Tests: 46 total (45 pass, 1 skipped).

## Remaining items: isolation, recovery, frames, annotation, recon

**Multi-agent isolation.** The broker now serialises CDP work per tab across every
connected session (`withTabLock`). Two agents can share one browser without interleaving
commands on the same tab; different tabs still run in parallel. Tests assert
`maxActive === 1` on one tab and `maxActive === 2` on two.

**Session recovery.** `JsSession` can persist JSON-safe bindings and restore them in a
new process. Functions and circular structures are dropped rather than faked; a corrupt
state file is ignored. Verified: `const rows = [...]; const label = "kept"` survives a
restart, `() => 1` does not.

**Frames.** `frames()` lists frames (`Page.getFrameTree` / `page.frames()`), and
`evaluateInFrame({index|frameId}, script)` runs code inside one. On the extension path a
frame is reached through `Page.createIsolatedWorld`. Verified on a real page:
`evaluateInFrame({index:0}, "document.title")` returned the page title.

**Annotated screenshots.** `browser_screenshot({annotate:true})` draws numbered boxes on
interactive elements using the same refs as the text tools, captures, then removes the
overlay. Measured: 235 KB plain vs 238 KB annotated on a real page.

**Recon.** `recon_start` / `recon_report` / `recon_draft` record the page's own API calls
from CDP events: XHR/fetch only, deduped by `METHOD path`, with status, mime type and
query parameter names. `recon_draft` emits an adapter skeleton with `TODO`s where
judgement is needed — drafts are text, never auto-activated. Real capture picked up
`GET /mro/api/hotkey` (2 calls, 200) and `POST /api/web-traces` from ordinary page
traffic.

Tests: 57 total (56 pass, 1 skipped).
