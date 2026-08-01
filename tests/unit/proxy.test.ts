// The proxy is where a visitor gets an identity, and it is the only place that
// can: it runs on the edge, before the page, on every document request.
//
// The load-bearing detail below is that the id is written to the *request* as
// well as the response. A cookie set only on the response is invisible to the
// page rendering that same request, so the very first landing view, the one
// carrying the campaign tags that brought the visitor, would go unrecorded.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { ANONYMOUS_ID_COOKIE, FIRST_TOUCH_COOKIE, decodeFirstTouch } from '@/lib/analytics/cookies';

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

function documentRequest(
  url: string,
  init?: { headers?: Record<string, string>; cookies?: Record<string, string> }
) {
  const headers = new Headers({
    'user-agent': BROWSER_UA,
    'sec-fetch-dest': 'document',
    ...init?.headers,
  });
  const cookies = Object.entries(init?.cookies ?? {});
  if (cookies.length > 0) {
    headers.set('cookie', cookies.map(([name, value]) => `${name}=${value}`).join('; '));
  }
  return new NextRequest(new URL(url), { headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proxy', () => {
  it('always sets the content security policy', () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'false');

    const response = proxy(documentRequest('https://open-frame.net/'));

    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('sets no acquisition cookie at all when the flag is off', () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'false');

    const response = proxy(documentRequest('https://open-frame.net/?utm_source=github'));

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
    expect(response.cookies.get(FIRST_TOUCH_COOKIE)).toBeUndefined();
  });

  it('gives a new visitor an id and stores what brought them', () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    const request = documentRequest(
      'https://open-frame.net/?utm_source=youtube&utm_medium=video&utm_campaign=launch'
    );

    const response = proxy(request);

    const id = response.cookies.get(ANONYMOUS_ID_COOKIE);
    expect(id?.value).toMatch(/^[a-z0-9]{32}$/);
    expect(id?.httpOnly).toBe(true);
    expect(id?.sameSite).toBe('lax');
    expect(id?.secure).toBe(true);

    const touch = decodeFirstTouch(response.cookies.get(FIRST_TOUCH_COOKIE)?.value);
    expect(touch).toEqual({
      channel: 'YOUTUBE',
      utmSource: 'youtube',
      utmMedium: 'video',
      utmCampaign: 'launch',
      referrerHost: null,
      landingPath: '/',
    });

    // The page rendering this same request has to be able to read both.
    expect(request.cookies.get(ANONYMOUS_ID_COOKIE)?.value).toBe(id?.value);
    expect(request.cookies.get(FIRST_TOUCH_COOKIE)?.value).toBeDefined();
  });

  it('classifies a visit that only carries a referrer', () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');

    const response = proxy(
      documentRequest('https://open-frame.net/vs/frameio', {
        headers: { referer: 'https://github.com/yusufipk/OpenFrame' },
      })
    );

    expect(decodeFirstTouch(response.cookies.get(FIRST_TOUCH_COOKIE)?.value)).toMatchObject({
      channel: 'GITHUB',
      referrerHost: 'github.com',
      landingPath: '/vs/frameio',
    });
  });

  it('does not overwrite the first touch of a returning visitor', () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
    const existingId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

    const response = proxy(
      documentRequest('https://open-frame.net/?utm_source=google', {
        cookies: { [ANONYMOUS_ID_COOKIE]: existingId, [FIRST_TOUCH_COOKIE]: 'anything' },
      })
    );

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
    expect(response.cookies.get(FIRST_TOUCH_COOKIE)).toBeUndefined();
  });

  it('replaces an id that does not look like one we issued', () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');

    const response = proxy(
      documentRequest('https://open-frame.net/', {
        cookies: { [ANONYMOUS_ID_COOKIE]: 'nope' },
      })
    );

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)?.value).toMatch(/^[a-z0-9]{32}$/);
  });

  it('ignores crawlers, so they never enter the visitor count', () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');

    const response = proxy(
      documentRequest('https://open-frame.net/', {
        headers: { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' },
      })
    );

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
  });

  it('ignores a prefetch and an API call', () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');

    const prefetch = proxy(
      documentRequest('https://open-frame.net/register', {
        headers: { 'next-router-prefetch': '1' },
      })
    );
    const api = proxy(
      documentRequest('https://open-frame.net/api/projects', {
        headers: { 'sec-fetch-dest': 'empty' },
      })
    );

    expect(prefetch.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
    expect(api.cookies.get(ANONYMOUS_ID_COOKIE)).toBeUndefined();
  });

  it('leaves the cookie insecure on plain http, so local development works', () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');

    const response = proxy(documentRequest('http://localhost:3000/'));

    expect(response.cookies.get(ANONYMOUS_ID_COOKIE)?.secure).toBe(false);
  });
});
