import type { NextRequest } from 'next/server';

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getConfiguredOrigins(): string[] {
  const configured = [process.env.NEXT_PUBLIC_APP_URL, process.env.NEXTAUTH_URL];
  return configured
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizeOrigin(/^https?:\/\//i.test(value) ? value : `https://${value}`))
    .filter((value): value is string => value !== null);
}

/**
 * Origin to build user-facing redirects from.
 *
 * Behind a reverse proxy (Docker deployments) `request.nextUrl.origin` is the
 * container-internal address (`localhost:3000`), so redirecting relative to the
 * request URL sends the browser to a dead host. Prefer the operator-configured
 * public origin and fall back to the request origin for local development.
 */
export function getPublicOrigin(request: NextRequest): string {
  const configured = [process.env.NEXTAUTH_URL, process.env.NEXT_PUBLIC_APP_URL];

  for (const value of configured) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const origin = normalizeOrigin(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (origin) return origin;
  }

  return request.nextUrl.origin;
}

export function getAllowedRequestOrigins(request: NextRequest): Set<string> {
  const origins = new Set<string>();

  // Only trust server-side computed origin and operator-configured origins.
  // x-forwarded-host / x-forwarded-proto are client-controlled and must never
  // be used to build the allowed-origin set (SSRF / origin-spoof vector).
  origins.add(request.nextUrl.origin);

  for (const configuredOrigin of getConfiguredOrigins()) {
    origins.add(configuredOrigin);
  }

  return origins;
}

export function isTrustedSameOriginRequest(request: NextRequest): boolean {
  const requestOrigin = request.headers.get('origin');
  if (!requestOrigin) return false;

  const normalizedRequestOrigin = normalizeOrigin(requestOrigin);
  if (!normalizedRequestOrigin) return false;

  return getAllowedRequestOrigins(request).has(normalizedRequestOrigin);
}
