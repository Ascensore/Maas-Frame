import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  ensureGuestIdentityFromRequest,
  getGuestIdentityFromRequest,
  setGuestIdentityCookie,
} from '@/lib/guest-identity';

const COOKIE_NAME = 'openframe_guest_identity';
const TTL_SECONDS = 60 * 60 * 24 * 180;
const SECRET = 'guest-identity-test-secret';
const NOW = new Date('2026-01-15T00:00:00.000Z');

function issueCookieValue(identityId: string): string {
  const response = NextResponse.next();
  setGuestIdentityCookie(response, identityId);
  const value = response.cookies.get(COOKIE_NAME)?.value;
  if (!value) throw new Error('setGuestIdentityCookie did not write a cookie');
  return value;
}

function requestWithCookie(value: string | null): NextRequest {
  const headers = new Headers();
  if (value !== null) headers.set('cookie', `${COOKIE_NAME}=${value}`);
  return new NextRequest('https://example.com/share/abc', { headers });
}

// Mirrors the production signing scheme so that deliberately malformed payloads
// can be presented with a valid signature. There is no other way to reach the
// payload validation branches from the outside.
function signPayload(payloadJson: string, secret = SECRET): string {
  const encoded = Buffer.from(payloadJson, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('GUEST_IDENTITY_SECRET', SECRET);
  vi.stubEnv('AUTH_SECRET', undefined);
  vi.stubEnv('NEXTAUTH_SECRET', undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('setGuestIdentityCookie and getGuestIdentityFromRequest', () => {
  it('round-trips an identity id through a signed cookie', () => {
    const value = issueCookieValue('guest-abc-123');

    expect(getGuestIdentityFromRequest(requestWithCookie(value))).toBe('guest-abc-123');
  });

  it('returns null when the cookie is absent', () => {
    expect(getGuestIdentityFromRequest(requestWithCookie(null))).toBeNull();
  });

  it('returns null for an empty cookie value', () => {
    expect(getGuestIdentityFromRequest(requestWithCookie(''))).toBeNull();
  });

  it('returns null when the payload has been tampered with', () => {
    const [payload, signature] = issueCookieValue('guest-abc-123').split('.');
    const tampered = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}.${signature}`;

    expect(getGuestIdentityFromRequest(requestWithCookie(tampered))).toBeNull();
  });

  it('returns null when the signature has been tampered with', () => {
    const [payload, signature] = issueCookieValue('guest-abc-123').split('.');
    const tampered = `${payload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    expect(getGuestIdentityFromRequest(requestWithCookie(tampered))).toBeNull();
  });

  it('returns null when the signature length does not match', () => {
    const [payload] = issueCookieValue('guest-abc-123').split('.');

    expect(getGuestIdentityFromRequest(requestWithCookie(`${payload}.short`))).toBeNull();
  });

  it('returns null when the value carries no signature at all', () => {
    const [payload] = issueCookieValue('guest-abc-123').split('.');

    expect(getGuestIdentityFromRequest(requestWithCookie(payload))).toBeNull();
  });

  it('returns null when the cookie was signed with a different secret', () => {
    const value = issueCookieValue('guest-abc-123');
    vi.stubEnv('GUEST_IDENTITY_SECRET', 'a-different-secret');

    expect(getGuestIdentityFromRequest(requestWithCookie(value))).toBeNull();
  });

  it('accepts the cookie one second before the 180 day expiry', () => {
    const value = issueCookieValue('guest-abc-123');
    vi.setSystemTime(new Date(NOW.getTime() + (TTL_SECONDS - 1) * 1000));

    expect(getGuestIdentityFromRequest(requestWithCookie(value))).toBe('guest-abc-123');
  });

  it('rejects the cookie at the exact expiry second', () => {
    const value = issueCookieValue('guest-abc-123');
    vi.setSystemTime(new Date(NOW.getTime() + TTL_SECONDS * 1000));

    expect(getGuestIdentityFromRequest(requestWithCookie(value))).toBeNull();
  });

  it('rejects the cookie well after expiry', () => {
    const value = issueCookieValue('guest-abc-123');
    vi.setSystemTime(new Date(NOW.getTime() + (TTL_SECONDS + 86_400) * 1000));

    expect(getGuestIdentityFromRequest(requestWithCookie(value))).toBeNull();
  });

  it.each([
    ['a missing exp', '{"gid":"guest-1"}'],
    ['exp as a string', '{"gid":"guest-1","exp":"9999999999"}'],
    ['exp as NaN-producing null', '{"gid":"guest-1","exp":null}'],
    ['a missing gid', '{"exp":9999999999}'],
    ['gid as a number', '{"gid":42,"exp":9999999999}'],
    ['an empty gid', '{"gid":"","exp":9999999999}'],
    ['a non-object payload', '"just-a-string"'],
    ['malformed JSON', '{"gid":'],
  ])('returns null for a correctly signed payload with %s', (_label, payloadJson) => {
    const value = signPayload(payloadJson);

    expect(getGuestIdentityFromRequest(requestWithCookie(value))).toBeNull();
  });

  it('accepts a correctly signed payload with a far future exp', () => {
    const value = signPayload('{"gid":"guest-forever","exp":4102444800}');

    expect(getGuestIdentityFromRequest(requestWithCookie(value))).toBe('guest-forever');
  });
});

describe('guest identity secret resolution', () => {
  it('prefers GUEST_IDENTITY_SECRET over AUTH_SECRET', () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    const value = issueCookieValue('guest-abc-123');

    // Removing only the preferred secret must invalidate the cookie, which proves
    // it was the one used to sign.
    vi.stubEnv('GUEST_IDENTITY_SECRET', undefined);
    expect(getGuestIdentityFromRequest(requestWithCookie(value))).toBeNull();
  });

  it('falls back to AUTH_SECRET when GUEST_IDENTITY_SECRET is unset', () => {
    vi.stubEnv('GUEST_IDENTITY_SECRET', undefined);
    vi.stubEnv('AUTH_SECRET', 'auth-secret');

    const value = issueCookieValue('guest-abc-123');

    expect(getGuestIdentityFromRequest(requestWithCookie(value))).toBe('guest-abc-123');
  });

  it('falls back to NEXTAUTH_SECRET last', () => {
    vi.stubEnv('GUEST_IDENTITY_SECRET', undefined);
    vi.stubEnv('NEXTAUTH_SECRET', 'nextauth-secret');

    const value = issueCookieValue('guest-abc-123');

    expect(getGuestIdentityFromRequest(requestWithCookie(value))).toBe('guest-abc-123');
  });

  it('throws when no secret is configured at all', () => {
    vi.stubEnv('GUEST_IDENTITY_SECRET', undefined);

    expect(() => issueCookieValue('guest-abc-123')).toThrow(
      'Missing GUEST_IDENTITY_SECRET, AUTH_SECRET, or NEXTAUTH_SECRET.'
    );
  });
});

describe('guest identity cookie attributes', () => {
  it('is http-only, lax and scoped to the whole site for 180 days', () => {
    const response = NextResponse.next();
    setGuestIdentityCookie(response, 'guest-abc-123');

    const setCookie = response.headers.get('set-cookie') ?? '';

    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain(`Max-Age=${TTL_SECONDS}`);
  });

  it('is not marked Secure outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = NextResponse.next();
    setGuestIdentityCookie(response, 'guest-abc-123');

    expect(response.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('is marked Secure in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.next();
    setGuestIdentityCookie(response, 'guest-abc-123');

    expect(response.headers.get('set-cookie')).toContain('Secure');
  });
});

describe('ensureGuestIdentityFromRequest', () => {
  it('reuses an existing identity without asking for a new cookie', () => {
    const value = issueCookieValue('guest-abc-123');

    expect(ensureGuestIdentityFromRequest(requestWithCookie(value))).toEqual({
      identityId: 'guest-abc-123',
      shouldSetCookie: false,
    });
  });

  it('mints a uuid identity and asks for a cookie when none is present', () => {
    const result = ensureGuestIdentityFromRequest(requestWithCookie(null));

    expect(result.shouldSetCookie).toBe(true);
    expect(result.identityId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('mints a fresh identity for an invalid cookie rather than reusing the payload', () => {
    const [payload] = issueCookieValue('guest-abc-123').split('.');
    const result = ensureGuestIdentityFromRequest(requestWithCookie(`${payload}.forged`));

    expect(result.shouldSetCookie).toBe(true);
    expect(result.identityId).not.toBe('guest-abc-123');
  });

  it('does not reuse the same identity across two anonymous requests', () => {
    const first = ensureGuestIdentityFromRequest(requestWithCookie(null));
    const second = ensureGuestIdentityFromRequest(requestWithCookie(null));

    expect(first.identityId).not.toBe(second.identityId);
  });
});
