/**
 * Settle contract tests. These use a fake activity source, so they prove the
 * decision logic without a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TUNING, effectOf, settle, waitForTarget, TargetNotFound } from '../src/core/settle.js';
import type { ActivitySource, ActivityInfo, NetworkInfo } from '../src/core/activity.js';

function info(partial: Partial<ActivityInfo> = {}): ActivityInfo {
  return {
    docId: 'doc-1',
    url: 'https://example.test/',
    ready: 'complete',
    mutations: 0,
    idleMs: 1000,
    ...partial,
  };
}

function sourceOf(
  activities: Array<ActivityInfo | null>,
  networks: NetworkInfo[] = [{ pending: 0, idleMs: 1000 }],
): ActivitySource {
  let i = 0;
  let n = 0;
  return {
    async activity() {
      const value = activities[Math.min(i, activities.length - 1)];
      i++;
      return value ?? null;
    },
    async network() {
      const value = networks[Math.min(n, networks.length - 1)];
      n++;
      return value ?? { pending: 0, idleMs: 1000 };
    },
  };
}

test('settles immediately when the page is already quiet', async () => {
  const source = sourceOf([info({ idleMs: 500 })]);
  const started = Date.now();
  const result = await settle(source, started, 1000);
  assert.equal(result.quiet, true);
  assert.equal(result.pendingRequests, 0);
});

test('keeps waiting while a request the action started is in flight', async () => {
  const source = sourceOf(
    [info({ idleMs: 500 }), info({ idleMs: 600 }), info({ idleMs: 800 })],
    [
      { pending: 2, idleMs: 10 },
      { pending: 1, idleMs: 20 },
      { pending: 0, idleMs: 500 },
    ],
  );
  const result = await settle(source, Date.now(), 2000);
  assert.equal(result.quiet, true);
});

test('does not settle while the document is still parsing', async () => {
  const source = sourceOf([
    info({ ready: 'loading', idleMs: 500 }),
    info({ ready: 'loading', idleMs: 500 }),
    info({ ready: 'complete', idleMs: 500 }),
  ]);
  const result = await settle(source, Date.now(), 1000);
  assert.equal(result.quiet, true);
});

test('reports not quiet when the cap is reached with work pending', async () => {
  const source = sourceOf([info({ idleMs: 0 })], [{ pending: 3, idleMs: 0 }]);
  const result = await settle(source, Date.now(), 150);
  assert.equal(result.quiet, false);
  assert.equal(result.pendingRequests, 3);
});

test('effect: navigation is reported when the document changed', () => {
  const before = { target: info({ docId: 'a' }), network: { pending: 0, idleMs: 1 } };
  const after = { target: info({ docId: 'b', url: 'https://example.test/next' }), network: { pending: 0, idleMs: 1 } };
  assert.deepEqual(effectOf(before, after, false), { effect: 'navigated', url: 'https://example.test/next' });
});

test('effect: dom change without navigation is "changed"', () => {
  const before = { target: info({ mutations: 5 }), network: { pending: 0, idleMs: 1 } };
  const after = { target: info({ mutations: 9 }), network: { pending: 0, idleMs: 1 } };
  assert.equal(effectOf(before, after, false).effect, 'changed');
});

test('effect: nothing moved is "none"', () => {
  const snap = (mutations: number) => ({ target: info({ mutations }), network: { pending: 0, idleMs: 1 } });
  assert.equal(effectOf(snap(5), snap(5), false).effect, 'none');
});

test('effect: unknown activity is reported as unknown, not "none"', () => {
  const before = { target: null, network: { pending: 0, idleMs: 1 } };
  const after = { target: info(), network: { pending: 0, idleMs: 1 } };
  assert.equal(effectOf(before, after, false).effect, 'unknown');
});

test('waitForTarget returns as soon as the target appears', async () => {
  const source = sourceOf([info()]);
  let calls = 0;
  const value = await waitForTarget(
    source,
    async () => {
      calls++;
      return calls >= 2 ? 'found' : null;
    },
    { timeoutMs: 1000, since: Date.now() },
  );
  assert.equal(value, 'found');
});

test('waitForTarget fails fast when the page stays quiet', async () => {
  const quiet = info({ idleMs: DEFAULT_TUNING.notFoundQuietMs + 100 });
  const source = sourceOf([quiet]);
  const started = Date.now();
  await assert.rejects(
    () => waitForTarget(source, async () => null, { timeoutMs: 10_000, since: started }),
    (err: unknown) => {
      assert.ok(err instanceof TargetNotFound);
      assert.equal(err.fastFail, true);
      assert.ok(err.elapsedMs < 3000, `elapsed ${err.elapsedMs}ms should be well under the timeout`);
      return true;
    },
  );
});

test('waitForTarget uses the full timeout while the page is busy', async () => {
  const busy = info({ ready: 'loading', idleMs: 0 });
  const source = sourceOf([busy]);
  const started = Date.now();
  await assert.rejects(
    () => waitForTarget(source, async () => null, { timeoutMs: 400, since: started }),
    (err: unknown) => {
      assert.ok(err instanceof TargetNotFound);
      assert.equal(err.fastFail, false);
      return true;
    },
  );
});

