import assert from 'node:assert/strict';
import test from 'node:test';
import { Tab } from '../src/api/tab.js';
import type { NavigationResult } from '../src/transport/page.js';
import { FakePage } from './mcp-fake.test.js';

/** A page whose landing URL and HTTP status the test decides. */
class StatusPage extends FakePage {
  constructor(
    private readonly finalUrl: string,
    private readonly status: number | null,
  ) {
    super();
  }

  override async url(): Promise<string> {
    return this.finalUrl;
  }

  override async title(): Promise<string> {
    return this.status && this.status >= 400 ? 'Page not found' : 'Example';
  }

  override async goto(): Promise<NavigationResult> {
    return { url: this.finalUrl, status: this.status };
  }
}

test('a 404 lands with ok true and pageError true', async () => {
  const tab = new Tab(new StatusPage('https://github.com/99Gaoxiaoqi/tabmcp', 404));
  const result = await tab.goto('https://github.com/99Gaoxiaoqi/tabmcp');
  assert.equal(result.ok, true);
  assert.equal(result.pageError, true);
  assert.equal(result.status, 404);
  assert.equal(result.landedElsewhere, false);
});

test('a normal page carries no pageError field at all', async () => {
  const tab = new Tab(new StatusPage('https://example.com/', 200));
  const result = await tab.goto('https://example.com/');
  assert.equal('pageError' in result, false, 'the flag must not be added everywhere');
  assert.equal('landedElsewhere' in result, true);
});

test('landedElsewhere and pageError are independent in all four combinations', async () => {
  const cases = [
    { url: 'https://example.com/', requested: 'https://example.com/', status: 200, elsewhere: false, error: false },
    { url: 'https://example.com/', requested: 'https://example.com/', status: 404, elsewhere: false, error: true },
    { url: 'https://login.test/x', requested: 'https://example.com/', status: 200, elsewhere: true, error: false },
    { url: 'https://login.test/x', requested: 'https://example.com/', status: 500, elsewhere: true, error: true },
  ];

  for (const item of cases) {
    const tab = new Tab(new StatusPage(item.url, item.status));
    const result = await tab.goto(item.requested);
    assert.equal(result.landedElsewhere, item.elsewhere, `elsewhere for ${item.status} ${item.url}`);
    assert.equal('pageError' in result, item.error, `pageError for ${item.status} ${item.url}`);
    assert.equal('landedElsewhere' in result, true, 'landedElsewhere is always present');
  }
});

test('an unreachable host still fails with E_NAV_FAILED, not pageError', async () => {
  const tab = new Tab(new StatusPage('chrome-error://chromewebdata/', null));
  await assert.rejects(tab.goto('https://does-not-resolve.invalid/'), (err: unknown) => {
    assert.equal((err as { code?: string }).code, 'E_NAV_FAILED');
    return true;
  });
});
