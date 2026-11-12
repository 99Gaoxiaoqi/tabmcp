/**
 * Recon: watch what a page actually asks its own backend.
 *
 * Static analysis of bundles is one way to find endpoints; watching a real
 * session is the other, and it needs no parser. Requests the page itself made —
 * with the user's session — are exactly what an adapter should call.
 *
 * Candidates are evidence, not adapters: they carry no argument schema and must
 * be turned into a draft and verified before they can be used.
 */

export interface ApiCandidate {
  /** Stable key: METHOD + path. */
  id: string;
  method: string;
  /** Path with query string stripped, relative to the page origin. */
  path: string;
  origin: string;
  mimeType?: string;
  status?: number;
  count: number;
  lastRequestId: string;
  /** Query parameter names seen, for building the adapter's args. */
  params: string[];
}

export interface ReconReport {
  active: boolean;
  requests: number;
  candidates: ApiCandidate[];
  /** Requests that looked like documents/static assets and were ignored. */
  ignored: number;
}

const IGNORED_TYPES = /^(document|stylesheet|image|font|media|script|other)$/i;

/**
 * Records request/response pairs from CDP events.
 *
 * Only XHR/fetch traffic is kept: those are the calls an adapter can repeat,
 * while documents and assets are just the page loading.
 */
export class ReconRecorder {
  private active = false;
  private readonly byId = new Map<string, ApiCandidate>();
  private readonly pending = new Map<string, { method: string; url: string; type: string }>();
  private requestCount = 0;
  private ignored = 0;

  start(): void {
    this.active = true;
    this.byId.clear();
    this.pending.clear();
    this.requestCount = 0;
    this.ignored = 0;
  }

  stop(): void {
    this.active = false;
  }

  get recording(): boolean {
    return this.active;
  }

  /** Feed one CDP event; unknown events are ignored. */
  ingest(event: { method: string; params?: Record<string, unknown> }): void {
    if (!this.active) return;
    if (event.method === 'Network.requestWillBeSent') {
      this.requestCount++;
      const requestId = String(event.params?.requestId ?? '');
      const request = event.params?.request as { url?: string; method?: string } | undefined;
      const type = String(event.params?.type ?? 'Other');
      if (!requestId || !request?.url) return;
      if (IGNORED_TYPES.test(type) || type === 'Preflight') {
        this.ignored++;
        return;
      }
      this.pending.set(requestId, {
        method: (request.method ?? 'GET').toUpperCase(),
        url: request.url,
        type,
      });
      return;
    }
    if (event.method === 'Network.responseReceived') {
      const requestId = String(event.params?.requestId ?? '');
      const response = event.params?.response as { mimeType?: string; status?: number } | undefined;
      const request = this.pending.get(requestId);
      if (!request) return;
      this.pending.delete(requestId);
      const mimeType = response?.mimeType ?? '';
      if (!/json|javascript|text\/plain/i.test(mimeType)) {
        this.ignored++;
        return;
      }
      this.record(request.method, request.url, requestId, response?.status, mimeType);
    }
  }

  private record(method: string, url: string, requestId: string, status: number | undefined, mimeType: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const id = `${method} ${parsed.pathname}`;
    const params = [...new Set([...parsed.searchParams.keys()])];
    const existing = this.byId.get(id);
    if (existing) {
      existing.count++;
      existing.lastRequestId = requestId;
      if (status !== undefined) existing.status = status;
      if (mimeType) existing.mimeType = mimeType;
      for (const param of params) if (!existing.params.includes(param)) existing.params.push(param);
      return;
    }
    this.byId.set(id, {
      id,
      method,
      path: parsed.pathname,
      origin: parsed.origin,
      ...(mimeType ? { mimeType } : {}),
      ...(status !== undefined ? { status } : {}),
      count: 1,
      lastRequestId: requestId,
      params,
    });
  }

  report(): ReconReport {
    const candidates = [...this.byId.values()].sort((a, b) => b.count - a.count);
    return { active: this.active, requests: this.requestCount, candidates, ignored: this.ignored };
  }

  get(id: string): ApiCandidate | undefined {
    return this.byId.get(id);
  }
}

/**
 * Turns a candidate into an adapter skeleton.
 *
 * Deliberately incomplete: the argument schema and the result mapping are the
 * parts that need judgement, so they are left as TODOs rather than guessed.
 */
export function draftFromCandidate(candidate: ApiCandidate, site: string): { file: string; source: string } {
  const argNames = candidate.params.filter((param) => !/^(_:|utm_|spm|lcsc_vid)/i.test(param));
  const argsSpec = argNames
    .map((name) => `  { name: ${JSON.stringify(name)}, type: 'string', help: 'TODO: describe ${name}', example: 'TODO' },`)
    .join('\n');

  const source = `// Draft adapter generated from observed traffic: ${candidate.method} ${candidate.path}
// Recorded ${candidate.count} request(s). Fill in the TODOs, verify, then activate.
export default {
  description: 'TODO: one line describing ${candidate.method} ${candidate.path}',
  access: 'read',
  domain: ${JSON.stringify(new URL(candidate.origin).hostname)},
  args: [
${argsSpec}
  ],
  expect: { minRows: 1 },
  async run({ tab, args }) {
    const query = new URLSearchParams();
${argNames.map((name) => `    if (args[${JSON.stringify(name)}] !== undefined) query.set(${JSON.stringify(name)}, String(args[${JSON.stringify(name)}]));`).join('\n')}
    const suffix = query.toString();
    const data = await tab.fetchJson(${JSON.stringify(candidate.path)} + (suffix ? '?' + suffix : ''), {
      method: ${JSON.stringify(candidate.method)},
    });
    // TODO: map the response into a stable shape; return the part the agent needs.
    return { data };
  },
};
`;
  const command = candidate.path.split('/').filter(Boolean).pop()?.replace(/[^a-z0-9_-]/gi, '-').toLowerCase() || 'call';
  return { file: `${site}/${command}.js`, source };
}
