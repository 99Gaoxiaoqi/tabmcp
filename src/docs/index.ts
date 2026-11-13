/**
 * Agent-facing documentation.
 *
 * An agent that can read a short, accurate doc is far less likely to misuse the
 * tools than one that has to infer behaviour from schemas alone. These are served
 * both as a tool (`docs_get`) and as MCP resources (`tabmcp://docs/...`).
 */

export interface DocEntry {
  name: string;
  title: string;
  summary: string;
  body: string;
}

const QUICKSTART = `# Quickstart

1. One tab at a time. Tools act on the active tab unless you pass a ref from observe.
2. Look before you act: \`browser_observe\` returns refs like \`e1a2b3c4d5_7\`.
3. Act with the ref and the revision you observed: a stale revision is refused
   (\`E_REF_STALE\`) rather than clicking whatever is there now.
4. Every action reports \`effect\`: navigated / changed / none / unknown.
   \`none\` means the page did not react — do not assume success.
5. \`settled: false\` means the page was still moving when the window closed. Call
   \`browser_observe\` again before deciding the next step.

Prefer the REPL (\`js\`) when a task needs several steps: it keeps variables between
calls, so filtering and mapping happen in one place instead of across many tool calls.
`;

const ADAPTERS = `# Adapters

An adapter is one file: \`%APPDATA%/tabmcp/adapters/<site>/<command>.js\`.

\`\`\`js
export default {
  description: 'One line an agent reads',
  access: 'read',                 // or 'write' -> destructive annotation
  domain: 'x.com',
  args: [{ name: 'tweet_id', type: 'string', required: true, help: 'ID or URL' }],
  async run({ tab, args }) {
    const data = await tab.fetchJson('/api/thing?id=' + args.tweet_id);
    return { items: data.items };
  },
};
\`\`\`

Rules that matter:

- \`tab.cookie()\` + \`tab.fetchJson()\` hit the site's own API with the user's session.
  That is faster and steadier than driving the UI.
- Arguments are validated before \`run()\`; unknown arguments are rejected.
- Files starting with \`_\` are shared helpers, not commands.
- An adapter that declares \`domain\` expects the tab to be on that site: \`site_run\`
  refuses with \`E_WRONG_SITE\` (and names both hosts) instead of letting the fetch fail
  as "Failed to fetch". Pass \`navigate:true\` to open the domain first.
- A draft must be verified before activation: \`expect\` (minRows / result_path / text)
  is how a draft proves it works.

Write them with the REPL: explore with \`tab.*\`, confirm the shape, then save the file.
`;

const CHANNELS = `# Channels

Two transports exist: \`--connect <endpoint>\` (CDP, attaches to a browser started with a
debugging port) and \`--extension\` (a Chrome extension plus a native host). Prefer the
extension for the user's real, logged-in browser; prefer CDP for scripted runs.

What is identical:

- tool names, argument schemas, and result field names. \`goto\` returns
  \`{ok,url,title,status}\` and \`cookies\` returns
  \`{name,value,domain,path,httpOnly,secure}\` on both channels. Anything else is a bug,
  not a channel difference.

What differs:

- download: supported on CDP. On the extension channel a download is observed through
  \`chrome.downloads\`, and headless Chrome does not start one, so it fails with
  \`E_ACTION_TIMEOUT\`. Not verified in headed Chrome.
- network_read: CDP records from the first navigation this session performed; the
  extension records from the moment the debugger attached. Same shape, different
  starting point, so counts can differ on the same page.
- cold start: after the native host restarts, the extension reconnects within about
  two seconds, and calls in that window fail with \`E_BROWSER_DISCONNECTED\`.

- closed tab: if the tab in use is closed (by the user, or because the browser
  restarted) the next call is served by another tab. That result carries
  \`sessionReplaced: true\` with \`previousTabId\`, \`currentTabId\` and
  \`replaceCause\`, so an action that landed somewhere else cannot look like an
  action that landed where you asked. A normal call never carries those fields.
- no browser at all: the server still starts, every tool stays listable, and browser
  tools answer \`E_NO_BROWSER\` with a command to start one. \`doctor\` reports
  \`ok:true, connected:false\`; \`docs_get\` keeps working, because the tool that
  explains the problem must not need the thing that is missing.
- unclear transport death: when a message sounds like a dead connection but matches no
  known wording, the error carries \`data.deadLikeTextUnmatched\`. That wording list
  will go stale eventually; the marker is how the staleness becomes visible instead of
  turning into "this never works again".

Platform limits that look like our bugs but are not:

- Chrome's native messaging manifest has no \`args\` field. A host that needs
  arguments must be a launcher that resolves them itself; if you point \`path\` at an
  interpreter and pass \`args\`, \`connectNative\` simply fails and reports "not
  connected", which sends you looking at the registry instead.
- Under headless Chrome, \`chrome.downloads\` never fires, so \`browser_download\` on the
  extension channel fails with \`E_ACTION_TIMEOUT\`. Headed Chrome has not been verified.

Cookies are trimmed on purpose: \`expires\`, \`session\`, \`priority\`, \`size\`,
\`sourcePort\` and \`sourceScheme\` are dropped so both channels agree.
`;

const RECON = `# Recon

1. \`recon_start\` — begin recording.
2. Drive the page (search, open a result, page through) — or ask the user to.
3. \`recon_report\` — endpoints seen, most used first, with status and query params.
4. \`recon_draft\` — returns adapter source plus a suggested path. Nothing is written
   to disk and nothing is activated: the draft is text you review and save.

Only XHR/fetch traffic is recorded, deduped by \`METHOD path\`. Documents and assets
are ignored on purpose: they are the page loading, not an API.

A draft is a guess about argument semantics and result shapes. That is why it is text.
`;

export const DOCS: DocEntry[] = [
  { name: 'quickstart', title: 'Quickstart', summary: 'How to look, act and read results safely.', body: QUICKSTART },
  { name: 'adapters', title: 'Writing adapters', summary: 'Contract, external directory, draft rules.', body: ADAPTERS },
  {
    name: 'channels',
    title: 'Channel differences',
    summary: 'What CDP and the extension have in common, and what they do not.',
    body: CHANNELS,
  },
  { name: 'recon', title: 'Recording endpoints', summary: 'Turn observed traffic into an adapter draft.', body: RECON },
];

export function listDocs(): Array<{ name: string; title: string; summary: string }> {
  return DOCS.map(({ name, title, summary }) => ({ name, title, summary }));
}

export function getDoc(name: string): DocEntry | undefined {
  return DOCS.find((doc) => doc.name === name);
}

/** Compact index shown when docs_get is called without a name. */
export function docsIndex(): string {
  return [
    'Available docs (call docs_get with a name):',
    ...DOCS.map((doc) => `- ${doc.name}: ${doc.summary}`),
  ].join('\n');
}
