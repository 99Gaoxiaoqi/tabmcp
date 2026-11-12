/**
 * Agent-facing documentation.
 *
 * An agent that can read a short, accurate doc is far less likely to misuse the
 * tools than one that has to infer behaviour from schemas alone. These are served
 * both as a tool (`docs_get`) and as MCP resources (`browsermcp://docs/...`).
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

An adapter is one file: \`%APPDATA%/browsermcp-core/adapters/<site>/<command>.js\`.

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
- A draft must be verified before activation: \`expect\` (minRows / result_path / text)
  is how a draft proves it works.

Write them with the REPL: explore with \`tab.*\`, confirm the shape, then save the file.
`;

const RECON = `# Recon

1. \`recon_start\` — begin recording.
2. Drive the page (search, open a result, page through) — or ask the user to.
3. \`recon_report\` — endpoints seen, most used first, with status and query params.
4. \`recon_draft\` — turn one endpoint into adapter source with TODOs.

Only XHR/fetch traffic is recorded, deduped by \`METHOD path\`. Documents and assets
are ignored on purpose: they are the page loading, not an API.

A draft is text. It is never activated automatically — guesses about argument
semantics and result shapes are what make a bad adapter.
`;

export const DOCS: DocEntry[] = [
  { name: 'quickstart', title: 'Quickstart', summary: 'How to look, act and read results safely.', body: QUICKSTART },
  { name: 'adapters', title: 'Writing adapters', summary: 'Contract, external directory, draft rules.', body: ADAPTERS },
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
