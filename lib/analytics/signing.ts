// Signing for the two acquisition cookies.
//
// httpOnly keeps JavaScript out of these cookies. It does nothing about curl,
// and both cookies are read straight into database columns, so without a
// signature the anonymous id is simply a string the caller picked. Picking one
// is enough to write a first-touch row for a visitor who never existed, or to
// claim another visitor's events at signup, since the backfill matches on the
// id alone.
//
// Web Crypto rather than node:crypto: this is imported by the proxy, which runs
// on the edge, and by the pages that read the cookies back, which run in Node.
// Both have crypto.subtle; only Node has createHmac.

import { logWarn } from '@/lib/logger';

const SEPARATOR = '.';

/**
 * 132 bits of an HMAC-SHA256, base64url. Truncating a MAC is standard practice
 * and keeps a cookie that rides on every request small.
 */
const SIGNATURE_LENGTH = 22;

let cachedSecret: string | null = null;
let cachedKey: Promise<CryptoKey> | null = null;
let warnedAboutMissingSecret = false;

function readSecret(): string | null {
  const secret = process.env.AUTH_SECRET?.trim() || process.env.NEXTAUTH_SECRET?.trim();
  if (secret) return secret;

  // Not thrown. The proxy runs on every request and the pages render for every
  // visitor; failing those to protect a funnel chart would be the wrong trade.
  // Analytics simply records nothing, which is visible on /admin/growth the same
  // day, and it is announced once per process rather than per request.
  if (!warnedAboutMissingSecret) {
    warnedAboutMissingSecret = true;
    logWarn(
      'AUTH_SECRET (or NEXTAUTH_SECRET) is not set, so acquisition cookies cannot be ' +
        'signed. Nothing will be recorded while it is missing.'
    );
  }
  return null;
}

function getKey(secret: string): Promise<CryptoKey> {
  if (!cachedKey || cachedSecret !== secret) {
    cachedSecret = secret;
    cachedKey = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
  }
  return cachedKey;
}

function toBase64Url(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function macOf(value: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await getKey(secret),
    new TextEncoder().encode(value)
  );
  return toBase64Url(signature).slice(0, SIGNATURE_LENGTH);
}

/** Constant time, so a forged cookie learns nothing from how long it took to reject. */
function equals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * `<mac>.<value>`.
 *
 * The MAC goes first and is fixed-length, so the split is a slice at a known
 * offset rather than a search for a separator that a future payload might
 * happen to contain.
 *
 * Returns null when there is no secret to sign with, which the callers treat as
 * "set no cookie".
 */
export async function signCookieValue(value: string): Promise<string | null> {
  const secret = readSecret();
  if (!secret) return null;
  return `${await macOf(value, secret)}${SEPARATOR}${value}`;
}

/** The signed value back, or null if it was absent, truncated, or edited. */
export async function unsignCookieValue(signed: string | null | undefined): Promise<string | null> {
  if (typeof signed !== 'string' || signed.length <= SIGNATURE_LENGTH + 1) return null;

  const secret = readSecret();
  if (!secret) return null;

  if (signed[SIGNATURE_LENGTH] !== SEPARATOR) return null;
  const mac = signed.slice(0, SIGNATURE_LENGTH);
  const value = signed.slice(SIGNATURE_LENGTH + 1);

  return equals(mac, await macOf(value, secret)) ? value : null;
}
