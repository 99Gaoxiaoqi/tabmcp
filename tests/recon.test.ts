/**
 * Recon tests: which requests count as API candidates, dedup by method+path,
 * parameter collection, and draft generation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ReconRecorder, draftFromCandidate } from '../src/recon/capture.js';

function request(id: string, url: string, method = 'GET', type = 'Fetch'): { method: string; params: Record<string, unknown> } {
  return { method: 'Network.requestWillBeSent', params: { requestId: id, type, request: { url, method } } };
}

function response(id: string, mimeType = 'application/json', status = 200): { method: string; params: Record<string, unknown> } {
  return { method: 'Network.responseReceived', params: { requestId: id, response: { mimeType, status } } };
}

test('recorder: keeps API calls, ignores documents and assets', () => {
  const rec = new ReconRecorder();
  rec.start();
  rec.ingest(request('1', 'https://example.test/api/items?limit=20'));
  rec.ingest(response('1'));
  rec.ingest(request('2', 'https://example.test/logo.png', 'GET', 'Image'));
  rec.ingest(response('2', 'image/png'));
  rec.ingest(request('3', 'https://example.test/page.html', 'GET', 'Document'));
  rec.ingest(response('3', 'text/html'));

  const report = rec.report();
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0]!.id, 'GET /api/items');
  assert.deepEqual(report.candidates[0]!.params, ['limit']);
  assert.equal(report.ignored, 2);
});

test('recorder: dedupes by method and path, counting repeats', () => {
  const rec = new ReconRecorder();
  rec.start();
  for (const id of ['a', 'b', 'c']) {
    rec.ingest(request(id, `https://example.test/api/items?page=${id}`));
    rec.ingest(response(id));
  }
  const report = rec.report();
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0]!.count, 3);
  assert.deepEqual(report.candidates[0]!.params.sort(), ['page']);
});

test('recorder: same path with different methods are different candidates', () => {
  const rec = new ReconRecorder();
  rec.start();
  rec.ingest(request('a', 'https://example.test/api/items', 'GET'));
  rec.ingest(response('a'));
  rec.ingest(request('b', 'https://example.test/api/items', 'POST'));
  rec.ingest(response('b'));
  assert.equal(rec.report().candidates.length, 2);
});

test('recorder: non-JSON responses are ignored', () => {
  const rec = new ReconRecorder();
  rec.start();
  rec.ingest(request('a', 'https://example.test/api/blob'));
  rec.ingest(response('a', 'image/png'));
  assert.equal(rec.report().candidates.length, 0);
});

test('recorder: nothing is recorded while stopped', () => {
  const rec = new ReconRecorder();
  rec.ingest(request('a', 'https://example.test/api/items'));
  rec.ingest(response('a'));
  assert.equal(rec.report().candidates.length, 0);
});

test('draft: generates an adapter skeleton with args from observed params', () => {
  const rec = new ReconRecorder();
  rec.start();
  rec.ingest(request('a', 'https://so.example.test/api/search?keyword=m3&page=2'));
  rec.ingest(response('a'));
  const candidate = rec.report().candidates[0]!;
  const draft = draftFromCandidate(candidate, 'demo');

  assert.equal(draft.file, 'demo/search.js');
  assert.match(draft.source, /export default \{/);
  assert.match(draft.source, /name: "keyword"/);
  assert.match(draft.source, /name: "page"/);
  assert.match(draft.source, /await tab\.fetchJson\("\/api\/search"/);
  assert.match(draft.source, /domain: "so\.example\.test"/);
  // The parts needing judgement must stay visibly unfinished.
  assert.match(draft.source, /TODO/);
});
