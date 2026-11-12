/**
 * Cookie shape.
 *
 * Both transports read cookies through CDP, but one of them returned the raw
 * protocol objects and the other a trimmed subset. A caller that works on one
 * channel must work on the other, so the shape is defined here once and both
 * paths go through it.
 */

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
}

/** Fields returned by `cookies()`; everything else is dropped on purpose. */
export const COOKIE_FIELDS = ['name', 'value', 'domain', 'path', 'httpOnly', 'secure'] as const;

export interface RawCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
}

export function normalizeCookie(raw: RawCookie): Cookie {
  return {
    name: String(raw.name ?? ''),
    value: String(raw.value ?? ''),
    domain: String(raw.domain ?? ''),
    path: String(raw.path ?? '/'),
    httpOnly: Boolean(raw.httpOnly),
    secure: Boolean(raw.secure),
  };
}

export function normalizeCookies(raw: RawCookie[]): Cookie[] {
  return raw.map(normalizeCookie);
}

/** Domain match used by both transports: exact, leading-dot, or suffix match. */
export function cookieMatchesDomain(cookie: { domain?: unknown }, domain: string): boolean {
  if (!domain) return true;
  const value = String(cookie.domain ?? '');
  return value === domain || value === `.${domain}` || value.endsWith(domain);
}
