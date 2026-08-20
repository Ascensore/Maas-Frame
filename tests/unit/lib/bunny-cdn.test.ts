import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePublicBunnyCdnHostname, resolveServerBunnyCdnHostname } from '@/lib/bunny-cdn';

beforeEach(() => {
  // The `unit` project loads no env file, so pin both variables rather than
  // inheriting whatever the shell exports.
  vi.stubEnv('BUNNY_CDN_URL', undefined);
  vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveServerBunnyCdnHostname', () => {
  it('returns null when neither variable is configured', () => {
    expect(resolveServerBunnyCdnHostname()).toBeNull();
  });

  it('prefers the server variable over the public one', () => {
    vi.stubEnv('BUNNY_CDN_URL', 'https://server.b-cdn.net');
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://public.b-cdn.net');

    expect(resolveServerBunnyCdnHostname()).toBe('server.b-cdn.net');
  });

  it('falls back to the public variable when the server one is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://public.b-cdn.net');

    expect(resolveServerBunnyCdnHostname()).toBe('public.b-cdn.net');
  });

  it('falls back to the public variable when the server one is empty', () => {
    vi.stubEnv('BUNNY_CDN_URL', '');
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://public.b-cdn.net');

    expect(resolveServerBunnyCdnHostname()).toBe('public.b-cdn.net');
  });

  it.each([
    ['a full https url', 'https://cdn.example.b-cdn.net', 'cdn.example.b-cdn.net'],
    ['an http url', 'http://cdn.example.b-cdn.net', 'cdn.example.b-cdn.net'],
    ['a url with a path', 'https://cdn.example.b-cdn.net/videos', 'cdn.example.b-cdn.net'],
    ['a url with a trailing slash', 'https://cdn.example.b-cdn.net/', 'cdn.example.b-cdn.net'],
    ['a url with a query string', 'https://cdn.example.b-cdn.net/?a=1', 'cdn.example.b-cdn.net'],
    ['a bare hostname', 'cdn.example.b-cdn.net', 'cdn.example.b-cdn.net'],
    ['a bare hostname with a trailing slash', 'cdn.example.b-cdn.net/', 'cdn.example.b-cdn.net'],
    [
      'a scheme-less url written with slashes',
      '//cdn.example.b-cdn.net',
      '//cdn.example.b-cdn.net',
    ],
    ['surrounding whitespace', '  https://cdn.example.b-cdn.net  ', 'cdn.example.b-cdn.net'],
  ])('reduces %s to the hostname', (_label, configured, expected) => {
    vi.stubEnv('BUNNY_CDN_URL', configured);

    expect(resolveServerBunnyCdnHostname()).toBe(expected);
  });

  it('drops the port from a url that carries one', () => {
    // `URL.hostname` excludes the port, unlike `URL.host`. Callers that compare
    // this value against a request hostname get the bare host, which is what the
    // Bunny CDN always serves on.
    vi.stubEnv('BUNNY_CDN_URL', 'https://cdn.example.b-cdn.net:8443/videos');

    expect(resolveServerBunnyCdnHostname()).toBe('cdn.example.b-cdn.net');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('returns null for %s', (_label, configured) => {
    vi.stubEnv('BUNNY_CDN_URL', configured);

    expect(resolveServerBunnyCdnHostname()).toBeNull();
  });

  it('returns null for a bare host:port, which parses as a url with no hostname', () => {
    // `new URL('localhost:9000')` succeeds with protocol `localhost:` and an
    // empty hostname, so it never reaches the string-stripping fallback.
    vi.stubEnv('BUNNY_CDN_URL', 'localhost:9000');

    expect(resolveServerBunnyCdnHostname()).toBeNull();
  });

  it('leaves a path attached when the value has no scheme to parse', () => {
    // The fallback only strips a leading scheme and trailing slashes, so a
    // scheme-less value with a path is returned as-is rather than as a hostname.
    vi.stubEnv('BUNNY_CDN_URL', 'cdn.example.b-cdn.net/videos');

    expect(resolveServerBunnyCdnHostname()).toBe('cdn.example.b-cdn.net/videos');
  });

  it('never returns a value carrying a scheme', () => {
    vi.stubEnv('BUNNY_CDN_URL', 'https://cdn.example.b-cdn.net');

    expect(resolveServerBunnyCdnHostname()).not.toContain('://');
  });
});

describe('resolvePublicBunnyCdnHostname', () => {
  it('returns null when the public variable is unset', () => {
    expect(resolvePublicBunnyCdnHostname()).toBeNull();
  });

  it('falls back to the server variable when no config has been injected', () => {
    // No document here, which is the SSR pass of a client component: the
    // server-only variable is readable and has to yield the same hostname the
    // browser will read out of the injected config, or hydration diverges.
    vi.stubEnv('BUNNY_CDN_URL', 'https://server.b-cdn.net');

    expect(resolvePublicBunnyCdnHostname()).toBe('server.b-cdn.net');
  });

  it('reduces the configured public url to its hostname', () => {
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://public.b-cdn.net/videos/');

    expect(resolvePublicBunnyCdnHostname()).toBe('public.b-cdn.net');
  });

  it('returns the same hostname as the server resolver when only the public url is set', () => {
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://public.b-cdn.net');

    expect(resolvePublicBunnyCdnHostname()).toBe(resolveServerBunnyCdnHostname());
  });
});
