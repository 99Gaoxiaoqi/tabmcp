import test from 'node:test';
import assert from 'node:assert/strict';
import { hostMatches, hostOf } from '../src/mcp/server.js';

test('site guard: the adapter domain and its subdomains match', () => {
  assert.equal(hostMatches('https://juejin.cn/search?query=x', 'juejin.cn'), true);
  assert.equal(hostMatches('https://api.juejin.cn/search_api/v1/search', 'juejin.cn'), true);
  assert.equal(hostMatches('https://sspai.com/', 'juejin.cn'), false);
  // A lookalike must not pass: "notjuejin.cn" ends with "juejin.cn" as a string.
  assert.equal(hostMatches('https://notjuejin.cn/', 'juejin.cn'), false);
});

test('site guard: an unparseable url yields an empty host, never a false match', () => {
  assert.equal(hostOf('about:blank'), '');
  assert.equal(hostOf('chrome-error://chromewebdata'), '');
  assert.equal(hostMatches('', 'juejin.cn'), false);
});
