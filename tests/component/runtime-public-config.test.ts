import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import {
  buildRuntimePublicConfig,
  readRuntimePublicConfig,
  resolvePublicDirectDownloadAllowedHosts,
  RUNTIME_PUBLIC_CONFIG_ELEMENT_ID,
} from '@/lib/runtime-public-config';

/**
 * These run in jsdom because that is the only place the bug shows: on the server
 * the environment is readable at request time, in the browser it is whatever was
 * inlined when the bundle was built, which for the published Docker image is
 * nothing.
 */
function injectConfig(payload: string): void {
  const element = document.createElement('script');
  element.id = RUNTIME_PUBLIC_CONFIG_ELEMENT_ID;
  element.type = 'application/json';
  element.textContent = payload;
  document.body.appendChild(element);
}

beforeEach(() => {
  vi.stubEnv('BUNNY_CDN_URL', undefined);
  vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', undefined);
  vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  document.getElementById(RUNTIME_PUBLIC_CONFIG_ELEMENT_ID)?.remove();
});

describe('buildRuntimePublicConfig', () => {
  it('prefers the server variable over the public one', () => {
    vi.stubEnv('BUNNY_CDN_URL', 'https://server.b-cdn.net');
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://public.b-cdn.net');

    expect(buildRuntimePublicConfig().bunnyCdnUrl).toBe('https://server.b-cdn.net');
  });

  it('emits empty strings rather than undefined when nothing is configured', () => {
    expect(buildRuntimePublicConfig()).toEqual({
      bunnyCdnUrl: '',
      directDownloadAllowedHosts: '',
    });
  });
});

describe('readRuntimePublicConfig', () => {
  it('returns null when the page carries no config', () => {
    expect(readRuntimePublicConfig()).toBeNull();
  });

  it('returns null for a payload that is not valid JSON', () => {
    injectConfig('{ not json');

    expect(readRuntimePublicConfig()).toBeNull();
  });

  it('coerces missing or non-string fields to empty strings', () => {
    injectConfig(JSON.stringify({ bunnyCdnUrl: 42 }));

    expect(readRuntimePublicConfig()).toEqual({
      bunnyCdnUrl: '',
      directDownloadAllowedHosts: '',
    });
  });
});

describe('resolvePublicBunnyCdnHostname in the browser', () => {
  it('uses the injected hostname when the build-time variable is empty', () => {
    // The published Docker image, where the operator configured BUNNY_CDN_URL at
    // runtime and the bundle was built without it.
    injectConfig(JSON.stringify({ bunnyCdnUrl: 'https://vz-runtime.b-cdn.net' }));

    expect(resolvePublicBunnyCdnHostname()).toBe('vz-runtime.b-cdn.net');
  });

  it('prefers the injected hostname over the one inlined at build time', () => {
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://vz-build.b-cdn.net');
    injectConfig(JSON.stringify({ bunnyCdnUrl: 'https://vz-runtime.b-cdn.net' }));

    expect(resolvePublicBunnyCdnHostname()).toBe('vz-runtime.b-cdn.net');
  });

  it('falls back to the build-time variable when the injected value is empty', () => {
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', 'https://vz-build.b-cdn.net');
    injectConfig(JSON.stringify({ bunnyCdnUrl: '' }));

    expect(resolvePublicBunnyCdnHostname()).toBe('vz-build.b-cdn.net');
  });

  it('returns null when neither source is configured', () => {
    injectConfig(JSON.stringify({ bunnyCdnUrl: '' }));

    expect(resolvePublicBunnyCdnHostname()).toBeNull();
  });
});

describe('resolvePublicDirectDownloadAllowedHosts', () => {
  it('splits, trims and lowercases the injected list', () => {
    injectConfig(
      JSON.stringify({ directDownloadAllowedHosts: ' Files.Example.com , cdn.example.com ,, ' })
    );

    expect(resolvePublicDirectDownloadAllowedHosts()).toEqual([
      'files.example.com',
      'cdn.example.com',
    ]);
  });

  it('falls back to the build-time variable when no config is injected', () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'files.example.com');

    expect(resolvePublicDirectDownloadAllowedHosts()).toEqual(['files.example.com']);
  });

  it('keeps the build-time list when the injected one is empty', () => {
    // An empty injected value means nothing was configured on this deployment, so
    // it must not narrow a source build that already had a list.
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', 'files.example.com');
    injectConfig(JSON.stringify({ directDownloadAllowedHosts: '' }));

    expect(resolvePublicDirectDownloadAllowedHosts()).toEqual(['files.example.com']);
  });

  it('returns an empty list when neither source is configured', () => {
    injectConfig(JSON.stringify({ directDownloadAllowedHosts: '' }));

    expect(resolvePublicDirectDownloadAllowedHosts()).toEqual([]);
  });
});
