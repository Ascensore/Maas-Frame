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
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

/** True when a sanitized path points at the invitation acceptance route. */
export function isInvitationCallbackUrl(path: string): boolean {
  return path.startsWith('/invitations/accept');
}
