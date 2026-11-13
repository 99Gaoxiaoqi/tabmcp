# tabmcp


An MCP server that drives a real browser tab: observe, act, read, and record what the page fetches.

<!-- tool-count: 20 -->
20 built-in tools over MCP stdio (including the list-only browser_tabs and browser_tabs_select), plus one tool per installed adapter. Grouped by
what you want to do, not by name:

| You want to | Tools |
|---|---|
| Look at a page, click, type, read text | `browser_goto` `browser_observe` `browser_act` `browser_read` |
| Take a picture of the page | `browser_screenshot` (optionally with numbered ref boxes) |
| See what the page itself requested, and read the JSON it got | `browser_network_read` |
| Reload, step back and forward | `browser_navigate` |
| Cookies for a domain | `browser_cookies` |
| Download a file | `browser_download` |
| Run a site adapter (installed commands) | `sites_search` `site_run` |
| Run JavaScript in a persistent REPL | `js` `js_reset` |
| Record endpoints and draft an adapter | `recon_start` `recon_report` `recon_draft` |
| Ask how any of this works | `docs_get` |
| Check the wiring | `doctor` |

Each installed adapter also registers its own tool (`<site>_<command>`), so the runtime
list is 18 plus the number of adapters (`sites_search` shows them).

## Run

```bash
npm install
npm run build
```

Start Chrome with a debugging port, then attach. Pick your platform:

```powershell
# Windows (PowerShell). Start-Process returns immediately; calling Chrome directly
# keeps the terminal attached to it.
Start-Process "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" -ArgumentList @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$env:TEMP\tabmcp-probe"
)
```

```bash
# macOS / Linux
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/tabmcp-probe
```

Verify the port answers before going further:

```bash
curl http://127.0.0.1:9222/json/version     # prints {"Browser": "Chrome/..."}
```

MCP client config:

```json
{
  "mcpServers": {
    "tabmcp": {
      "command": "node",
      "args": ["<absolute-path-to>/dist/src/main.js", "--connect", "http://127.0.0.1:9222"]
    }
  }
}
```

To drive your own logged-in browser instead, use the extension transport
(`--extension`); see `docs_get channels` for the difference.

## Five minutes: a page whose data HTTP cannot get

Juejin renders search results with JavaScript. A plain HTTP fetch of the same URL
returns the empty shell; the browser returns the results.

```bash
# 1. what plain HTTP sees
curl -s "https://juejin.cn/search?query=python" | grep -c "图解python"    # 0
```

Then, with tabmcp attached:

```
browser_goto   { "url": "https://juejin.cn/search?query=python" }
```

```js
// js: fetch the search API from the page itself, then keep what matters
const body = await tab.fetchJson(
  'https://api.juejin.cn/search_api/v1/search?aid=2608&uuid=&spider=0' +
  '&query=python&id_type=0&cursor=0&limit=20&search_type=0&sort_type=0&version=1'
);
body.data.slice(0, 10).map((item) => ({
  title: item.result_model.article_info.title,
  author: item.result_model.author_user_info.user_name,
  url: 'https://juejin.cn/post/' + item.result_model.article_info.article_id,
}));
```

Expected shape (ten rows):

```json
[
  { "title": "图解python | 字典", "author": "ShowMeAI", "url": "https://juejin.cn/post/7067755595549376548" },
  { "title": "图解python | 列表", "author": "ShowMeAI", "url": "https://juejin.cn/post/7067585859272310791" }
]
```

The same data is reachable as a one-line adapter once you have the endpoint:
`sites_search` then `site_run`, or `recon_draft` to generate a skeleton.

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

## Status: usable

Both transports work against a real Chrome: CDP (`--connect`) and the extension
(`--extension`). Verified on real sites, not only on a local test page.

- 20 built-in MCP tools; both channels share one result-field contract. Parity is asserted
  against fake transports in tests - the two real page implementations are verified on a
  live browser, not in unit tests
- persistent JS REPL, named tab groups, session recovery, per-agent tab isolation
- site adapters loaded from a directory, plus recon that records XHR/fetch traffic
- every failure carries a branchable code; transport errors are classified once

Known platform limits are listed in `docs_get` under `channels`.

Below `Status`, the rest of this file is a build log: what was verified, when, and
what remains. Read it before changing the code, not before using the tool.


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

## Aligned with TabMCP's timing model (2026-11-12)

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

## Site adapters (TabMCP-compatible shape)

An adapter is data plus one function; the data becomes the MCP tool schema.

```js
// %APPDATA%/tabmcp/adapters/demo/list.js
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

**Drafts do not appear as tools.** `recon_draft` returns adapter source as text; you finish
it, save the file into the adapters directory, and reload. Nothing is stored, and there is
no activation step. The sources contain a `DraftStore` class with a verify-then-activate
flow, but no product code constructs it, so in practice the gate is you reading the draft.

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
