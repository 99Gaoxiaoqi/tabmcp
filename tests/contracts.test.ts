import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionError, classifyUnknown, toEnvelope } from '../src/core/errors.js';
import { COOKIE_FIELDS, cookieMatchesDomain, normalizeCookies } from '../src/core/cookie.js';

test('cookies: both transports produce the same field set', () => {
  // What CDP hands back from a Playwright context.
  const fromPlaywright = [
    { name: 'sid', value: 'a', domain: '.example.com', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
  ];
  // What chrome.debugger's Network.getCookies hands back in the extension.
  const fromExtension = [
    {
      name: 'sid',
      value: 'a',
      domain: '.example.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      session: true,
      size: 12,
      priority: 'Medium',
      sourcePort: -1,
      sourceScheme: 'Secure',
    },
  ];

  const a = normalizeCookies(fromPlaywright);
  const b = normalizeCookies(fromExtension);
  assert.deepEqual(Object.keys(a[0]!).sort(), Object.keys(b[0]!).sort());
  assert.deepEqual(Object.keys(a[0]!).sort(), [...COOKIE_FIELDS].sort());
  assert.deepEqual(a, b);
});

test('cookies: domain matching is identical for both call sites', () => {
  assert.equal(cookieMatchesDomain({ domain: '.szlcsc.com' }, 'szlcsc.com'), true);
  assert.equal(cookieMatchesDomain({ domain: 'szlcsc.com' }, 'szlcsc.com'), true);
  assert.equal(cookieMatchesDomain({ domain: 'evil.com' }, 'szlcsc.com'), false);
  assert.equal(cookieMatchesDomain({ domain: 'anything' }, ''), true);
});

test('errors: a known error keeps the code it was thrown with', () => {
  const original = new ActionError('E_ACTION_TIMEOUT', 'download did not start within 8000ms');
  const classified = classifyUnknown(original);
  assert.equal(classified.code, 'E_ACTION_TIMEOUT');
  assert.deepEqual(toEnvelope(original).error.code, 'E_ACTION_TIMEOUT');
});

test('errors: foreign transport messages are classified without text drift', () => {
  const cases: Array<[string, string]> = [
    ['Target page, context or browser has been closed', 'E_BROWSER_DISCONNECTED'],
    ['No tab with given id 123', 'E_BROWSER_DISCONNECTED'],
    ['Cannot access a chrome:// URL', 'E_TARGET_UNSUPPORTED'],
    ['Timeout 30000ms exceeded', 'E_ACTION_TIMEOUT'],
    ['element is not visible', 'E_TARGET_NOT_FOUND'],
    ['something else entirely', 'E_INTERNAL'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(classifyUnknown(new Error(message)).code, expected, message);
  }
});

test('errors: our own timeout text is not what decides the code', () => {
  // The extension used to throw a bare Error here, so the classifier had to guess
  // from the wording. The code now comes from the throw site.
  const own = new ActionError('E_ACTION_TIMEOUT', 'download did not start within 8000ms');
  assert.equal(toEnvelope(own).error.code, 'E_ACTION_TIMEOUT');
  // A reworded message must not change the code.
  const reworded = new ActionError('E_ACTION_TIMEOUT', 'the file never appeared');
  assert.equal(toEnvelope(reworded).error.code, 'E_ACTION_TIMEOUT');
});
