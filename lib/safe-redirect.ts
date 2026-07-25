/**
 * Reduce an untrusted `callbackUrl`/`next` value to a same-origin relative path.
 * Anything absolute, cross-origin or unparsable falls back to `fallback`.
 *
 * Works on both sides: in the browser the origin defaults to `window.location.origin`
 * (so next-auth's absolute `result.url` still passes), on the server pass the public origin.
 */
export function getSafeCallbackUrl(
  value: string | null | undefined,
  options?: { origin?: string; fallback?: string }
): string {
  const fallback = options?.fallback ?? '/dashboard';
  if (!value) return fallback;

  const baseOrigin =
    options?.origin ??
    (typeof window === 'undefined' ? 'http://localhost' : window.location.origin);

  try {
    const parsed = new URL(value, baseOrigin);
    if (parsed.origin !== baseOrigin) return fallback;
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    // The origin check alone is not enough: an attacker can smuggle their own host into
    // the path of an otherwise same-origin URL. `new URL('https://app.example.com//evil.com')`
    // has our origin but a pathname of `//evil.com`, which every navigation sink below
    // resolves as protocol-relative and follows off-site.
    return isSafeRelativePath(path) ? path : fallback;
  } catch {
    return fallback;
  }
}

/**
 * True when a path is safe to hand to a navigation sink (`router.push`, `<Link href>`,
 * `NextResponse.redirect`): rooted at a single `/`, so it can only ever stay on this origin.
 *
 * `//evil.com` and `/\evil.com` are protocol-relative — browsers fill in the current
 * scheme and navigate to `evil.com`.
 */
export function isSafeRelativePath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\');
}

/** True when a sanitized path points at the invitation acceptance route. */
export function isInvitationCallbackUrl(path: string): boolean {
  return path.startsWith('/invitations/accept');
}
