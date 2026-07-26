import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  getAllowedRequestOrigins,
  getPublicOrigin,
  isTrustedSameOriginRequest,
} from '@/lib/request-origin';

const APP_URL = 'https://app.openframe.test';
const REQUEST_URL = `${APP_URL}/api/billing/checkout`;

function request(headers: Record<string, string> = {}, url = REQUEST_URL): NextRequest {
  return new NextRequest(url, { method: 'POST', headers: new Headers(headers) });
}

beforeEach(() => {
  // The `unit` project loads no env file, so whatever the shell happens to export
  // would otherwise decide the allowed-origin set. Pin both variables.
  vi.stubEnv('NEXTAUTH_URL', undefined);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isTrustedSameOriginRequest', () => {
  it('trusts a request whose Origin matches the request origin', () => {
    expect(isTrustedSameOriginRequest(request({ origin: APP_URL }))).toBe(true);
  });

  it('refuses a request from a different origin', () => {
    expect(isTrustedSameOriginRequest(request({ origin: 'https://evil.example.com' }))).toBe(false);
  });

  it('refuses a request with no Origin header at all', () => {
    expect(isTrustedSameOriginRequest(request())).toBe(false);
  });

  it('refuses the literal "null" Origin a sandboxed iframe sends', () => {
    expect(isTrustedSameOriginRequest(request({ origin: 'null' }))).toBe(false);
  });

  it('refuses an empty Origin header', () => {
    expect(isTrustedSameOriginRequest(request({ origin: '' }))).toBe(false);
  });

  it('refuses an unparseable Origin instead of throwing', () => {
    expect(() => isTrustedSameOriginRequest(request({ origin: 'not a url' }))).not.toThrow();
    expect(isTrustedSameOriginRequest(request({ origin: 'not a url' }))).toBe(false);
  });

  it('refuses a different scheme on the same host', () => {
    expect(isTrustedSameOriginRequest(request({ origin: 'http://app.openframe.test' }))).toBe(
      false
    );
  });

  it('refuses a different port on the same host', () => {
    expect(isTrustedSameOriginRequest(request({ origin: 'https://app.openframe.test:8443' }))).toBe(
      false
    );
  });

  it('refuses an attacker subdomain of the trusted host', () => {
    expect(
      isTrustedSameOriginRequest(request({ origin: 'https://app.openframe.test.evil.com' }))
    ).toBe(false);
  });

  it('refuses a host that merely starts with the trusted host', () => {
    expect(isTrustedSameOriginRequest(request({ origin: 'https://app.openframe.testing' }))).toBe(
      false
    );
  });

  it('trusts an operator-configured origin that differs from the request origin', () => {
    // The Docker case: the container sees localhost:3000, the browser sees the
    // public hostname, and the Origin header carries the latter.
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://frames.example.com');

    expect(
      isTrustedSameOriginRequest(
        request(
          { origin: 'https://frames.example.com' },
          'http://localhost:3000/api/billing/portal'
        )
      )
    ).toBe(true);
  });

  it('trusts an origin configured through NEXTAUTH_URL', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://frames.example.com/api/auth');

    expect(
      isTrustedSameOriginRequest(
        request(
          { origin: 'https://frames.example.com' },
          'http://localhost:3000/api/billing/portal'
        )
      )
    ).toBe(true);
  });

  it('still refuses a third origin when both variables are configured', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://a.example.com');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://b.example.com');

    expect(isTrustedSameOriginRequest(request({ origin: 'https://c.example.com' }))).toBe(false);
  });

  // The header comment in lib/request-origin.ts calls this out explicitly: the
  // x-forwarded-* headers are client controlled, so trusting them would let any
  // caller name its own origin as the allowed one.
  it('does not let a forged x-forwarded-host widen the allowed set', () => {
    expect(
      isTrustedSameOriginRequest(
        request({
          origin: 'https://evil.example.com',
          'x-forwarded-host': 'evil.example.com',
          'x-forwarded-proto': 'https',
        })
      )
    ).toBe(false);
  });

  it('does not let a forged Host header widen the allowed set', () => {
    expect(
      isTrustedSameOriginRequest(
        request({ origin: 'https://evil.example.com', host: 'evil.example.com' })
      )
    ).toBe(false);
  });

  it('compares only the origin, ignoring a path or query the caller appended', () => {
    expect(isTrustedSameOriginRequest(request({ origin: `${APP_URL}/some/path?a=1` }))).toBe(true);
  });

  it('ignores case in the scheme and host, as URL parsing normalizes both', () => {
    expect(isTrustedSameOriginRequest(request({ origin: 'HTTPS://APP.OPENFRAME.TEST' }))).toBe(
      true
    );
  });
});

describe('getAllowedRequestOrigins', () => {
  it('always contains the server-computed request origin', () => {
    expect(getAllowedRequestOrigins(request())).toEqual(new Set([APP_URL]));
  });

  it('adds both configured origins alongside the request origin', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://a.example.com');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://b.example.com');

    expect(getAllowedRequestOrigins(request())).toEqual(
      new Set([APP_URL, 'https://a.example.com', 'https://b.example.com'])
    );
  });

  it('reduces a configured url with a path down to its origin', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://a.example.com/api/auth/callback');

    expect(getAllowedRequestOrigins(request())).toContain('https://a.example.com');
  });

  it('assumes https for a configured value with no scheme', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'frames.example.com');

    expect(getAllowedRequestOrigins(request())).toContain('https://frames.example.com');
  });

  it('keeps an explicitly configured http origin as http', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');

    expect(getAllowedRequestOrigins(request())).toContain('http://localhost:3000');
  });

  it('skips a blank or whitespace-only configured value', () => {
    vi.stubEnv('NEXTAUTH_URL', '   ');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');

    expect(getAllowedRequestOrigins(request())).toEqual(new Set([APP_URL]));
  });

  it('skips a configured value that cannot be parsed as a url', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://');

    expect(getAllowedRequestOrigins(request())).toEqual(new Set([APP_URL]));
  });

  it('collapses duplicate configured origins into one entry', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://frames.example.com');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://frames.example.com/dashboard');

    expect(getAllowedRequestOrigins(request()).size).toBe(2);
  });

  it('never contains an x-forwarded-derived origin', () => {
    const origins = getAllowedRequestOrigins(
      request({ 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'https' })
    );

    expect(origins).toEqual(new Set([APP_URL]));
  });
});

describe('getPublicOrigin', () => {
  it('prefers NEXTAUTH_URL over both the request origin and NEXT_PUBLIC_APP_URL', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://a.example.com');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://b.example.com');

    expect(getPublicOrigin(request())).toBe('https://a.example.com');
  });

  it('falls back to NEXT_PUBLIC_APP_URL when NEXTAUTH_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://b.example.com');

    expect(getPublicOrigin(request())).toBe('https://b.example.com');
  });

  it('falls back to the request origin when neither variable is configured', () => {
    // The local development case, where no reverse proxy sits in front.
    expect(getPublicOrigin(request())).toBe(APP_URL);
  });

  it('strips the path from a configured url', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://a.example.com/api/auth');

    expect(getPublicOrigin(request())).toBe('https://a.example.com');
  });

  it('assumes https for a configured host with no scheme', () => {
    vi.stubEnv('NEXTAUTH_URL', 'frames.example.com');

    expect(getPublicOrigin(request())).toBe('https://frames.example.com');
  });

  it('skips a whitespace-only NEXTAUTH_URL and uses the next candidate', () => {
    vi.stubEnv('NEXTAUTH_URL', '  ');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://b.example.com');

    expect(getPublicOrigin(request())).toBe('https://b.example.com');
  });

  it('skips an unparseable NEXTAUTH_URL and uses the next candidate', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://b.example.com');

    expect(getPublicOrigin(request())).toBe('https://b.example.com');
  });

  it('does not build the redirect origin from a forged x-forwarded-host', () => {
    // This is the value the browser is sent to, so a spoofed host here is an
    // open redirect.
    expect(
      getPublicOrigin(
        request({ 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'https' })
      )
    ).toBe(APP_URL);
  });

  it('preserves the port of the request origin when falling back', () => {
    expect(getPublicOrigin(request({}, 'http://localhost:3000/api/auth/verify-email'))).toBe(
      'http://localhost:3000'
    );
  });
});
