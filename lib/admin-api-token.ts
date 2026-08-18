/**
 * A machine caller for the read-only admin endpoints.
 *
 * The growth scoreboard is read once a week by a digest script that has no
 * browser, and therefore no NextAuth session. The alternative was copying a
 * session cookie out of a browser by hand: those are JWTs with a 30-day
 * lifetime, so a scheduled job built on one stops working a month later and
 * reports nothing rather than reporting a failure.
 *
 * Off unless `OPENFRAME_ADMIN_API_TOKEN` is set, so a self-hosted instance that
 * never sets it keeps session-only admin access.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The shortest token this accepts.
 *
 * Behind this header sit every paying account's name, email and usage, so a
 * short token is a guessable path to all of it. A token under this length is
 * treated as no token at all rather than as a weaker one: failing closed makes
 * a bad value visible on the first call, where silently accepting it would
 * leave the endpoint open and look fine.
 */
export const MIN_ADMIN_API_TOKEN_LENGTH = 32;

/** The configured token, or null when it is absent or too short to be safe. */
export function getAdminApiToken(): string | null {
  const raw = process.env.OPENFRAME_ADMIN_API_TOKEN?.trim();
  if (!raw || raw.length < MIN_ADMIN_API_TOKEN_LENGTH) return null;
  return raw;
}

/**
 * Constant-time comparison over SHA-256 digests.
 *
 * Hashing first is not about secrecy, it is about length: `timingSafeEqual`
 * throws on unequal-length buffers, and the obvious length check before it
 * would leak the token's length through timing. Digests are always 32 bytes.
 */
function tokensMatch(candidate: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

/** True when the request carries `Authorization: Bearer <the configured token>`. */
export function isAdminApiTokenRequest(request: Request): boolean {
  const expected = getAdminApiToken();
  if (!expected) return false;

  const header = request.headers.get('authorization');
  if (!header) return false;

  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme.toLowerCase() !== 'bearer' || rest.length !== 1) return false;

  return tokensMatch(rest[0], expected);
}
