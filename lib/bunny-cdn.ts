import { readRuntimePublicConfig } from '@/lib/runtime-public-config';

function normalizeBunnyCdnHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || null;
  } catch {
    return trimmed.replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;
  }
}

export function resolveServerBunnyCdnHostname(): string | null {
  return normalizeBunnyCdnHostname(
    process.env.BUNNY_CDN_URL || process.env.NEXT_PUBLIC_BUNNY_CDN_URL
  );
}

/**
 * Browser-side hostname. Prefers the config the server injects at request time,
 * because `NEXT_PUBLIC_BUNNY_CDN_URL` is inlined when the bundle is built and the
 * published Docker image is built without it. Falls back to the build-time variable,
 * which is what a source build sets, and to the server-only variable during the SSR
 * pass of a client component, where it is still readable and has to produce the same
 * hostname the browser will read or hydration diverges.
 */
export function resolvePublicBunnyCdnHostname(): string | null {
  return (
    normalizeBunnyCdnHostname(readRuntimePublicConfig()?.bunnyCdnUrl) ??
    resolveServerBunnyCdnHostname()
  );
}
