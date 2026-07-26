import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectProvider,
  fetchVideoMetadata,
  getAllProviders,
  getEmbedUrl,
  getProvider,
  getProviderIcon,
  getThumbnailUrl,
  isValidVideoUrl,
  parseVideoUrl,
  type VideoProviderType,
} from '@/lib/video-providers';
import { getCachedMetadata, setCachedMetadata } from '@/lib/video-providers/metadata-cache';

const YT_ID = 'dQw4w9WgXcQ';
const UUID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

beforeEach(() => {
  vi.stubEnv('BUNNY_CDN_URL', undefined);
  vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', undefined);
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', undefined);
  vi.stubEnv('NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('detectProvider', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${YT_ID}`, 'youtube'],
    [`https://youtube.com/watch?v=${YT_ID}`, 'youtube'],
    [`https://youtu.be/${YT_ID}`, 'youtube'],
    [`https://www.youtube.com/shorts/${YT_ID}`, 'youtube'],
    [`https://www.youtube.com/embed/${YT_ID}`, 'youtube'],
    [`https://www.youtube.com/v/${YT_ID}`, 'youtube'],
    [`https://www.youtube.com/watch?v=${YT_ID}&t=30s`, 'youtube'],
    [`https://www.youtube.com/watch?list=PLabc&v=${YT_ID}`, 'youtube'],
    [`https://youtu.be/${YT_ID}?si=trackingparam`, 'youtube'],
    ['https://cdn.example.com/clip.mp4', 'direct'],
    ['https://cdn.example.com/clip.webm?token=abc', 'direct'],
    ['http://localhost:9000/bucket/clip.mov', 'direct'],
    ['https://iframe.mediadelivery.net/play/12345/abc-def_1', 'bunny'],
    ['https://video.bunnycdn.com/embed/12345/abcdef', 'bunny'],
    [`/api/upload/video/${UUID}.mp4`, 'r2'],
  ])('resolves %s to the %s provider', (url, expectedId) => {
    expect(detectProvider(url)?.id).toBe(expectedId);
  });

  it.each([
    'https://www.youtube.com/watch?v=tooshort',
    'https://example.com/page.html',
    'javascript:alert(1)',
    'ftp://example.com/clip.mp4',
    'data:video/mp4;base64,AAAA',
    `/api/upload/video/${UUID}.mp4?range=1`,
    `/api/upload/image/${UUID}.png`,
    'clip.mp4',
    '',
  ])('returns null for %s', (url) => {
    expect(detectProvider(url)).toBeNull();
  });

  it('lets the direct provider win over Bunny when a Bunny url ends in a video extension', () => {
    // Registry order is youtube, direct, bunny, r2, so the extension test matches first.
    expect(detectProvider('https://iframe.mediadelivery.net/play/12345/abc.mp4')?.id).toBe(
      'direct'
    );
  });

  it('lets YouTube win over the direct provider for a watch url ending in .mp4', () => {
    expect(detectProvider(`https://www.youtube.com/watch?v=${YT_ID}&file=a.mp4`)?.id).toBe(
      'youtube'
    );
  });
});

describe('parseVideoUrl', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${YT_ID}`, YT_ID],
    [`https://youtu.be/${YT_ID}`, YT_ID],
    [`https://www.youtube.com/shorts/${YT_ID}`, YT_ID],
    [`https://www.youtube.com/watch?v=${YT_ID}&list=PLabc`, YT_ID],
    [`https://www.youtube.com/watch?list=PLabc&index=2&v=${YT_ID}`, YT_ID],
  ])('extracts the YouTube id from %s', (url, expected) => {
    expect(parseVideoUrl(url)).toEqual({
      providerId: 'youtube',
      videoId: expected,
      originalUrl: url,
    });
  });

  it('uses the whole url as the id for a direct upload', () => {
    const url = 'https://cdn.example.com/clip.mp4';
    expect(parseVideoUrl(url)).toEqual({
      providerId: 'direct',
      videoId: url,
      originalUrl: url,
    });
  });

  it('uses the proxy path as the id for an r2 upload', () => {
    const url = `/api/upload/video/${UUID}.mp4`;
    expect(parseVideoUrl(url)?.videoId).toBe(url);
  });

  it('extracts the Bunny guid from an iframe url', () => {
    expect(parseVideoUrl('https://iframe.mediadelivery.net/play/12345/guid-abc')).toEqual({
      providerId: 'bunny',
      videoId: 'guid-abc',
      originalUrl: 'https://iframe.mediadelivery.net/play/12345/guid-abc',
    });
  });

  it('returns null when no provider can handle the url', () => {
    expect(parseVideoUrl('https://example.com/not-a-video')).toBeNull();
  });
});

describe('getProvider and getProviderIcon', () => {
  it.each(['youtube', 'direct', 'bunny', 'r2'] as const)('returns the %s provider by id', (id) => {
    expect(getProvider(id)?.id).toBe(id);
  });

  it('returns null for an unregistered id', () => {
    expect(getProvider('vimeo' as VideoProviderType)).toBeNull();
  });

  it.each([
    ['youtube', 'Youtube'],
    ['direct', 'Upload'],
    ['bunny', 'Video'],
    ['r2', 'Upload'],
  ] as const)('reports the %s icon as %s', (id, icon) => {
    expect(getProviderIcon(id)).toBe(icon);
  });

  it('falls back to a generic icon for an unknown provider', () => {
    expect(getProviderIcon('vimeo' as VideoProviderType)).toBe('Video');
  });
});

describe('getAllProviders', () => {
  it('lists every registered provider', () => {
    expect(getAllProviders().map((p) => p.id)).toEqual(['youtube', 'direct', 'bunny', 'r2']);
  });

  it('returns a copy so callers cannot mutate the registry', () => {
    getAllProviders().length = 0;

    expect(getAllProviders()).toHaveLength(4);
  });
});

describe('isValidVideoUrl', () => {
  it('accepts a url a provider can handle', () => {
    expect(isValidVideoUrl(`https://youtu.be/${YT_ID}`)).toBe(true);
  });

  it('rejects a url no provider can handle', () => {
    expect(isValidVideoUrl('https://example.com/article')).toBe(false);
  });
});

describe('youtube embed and thumbnail urls', () => {
  function params(url: string): URLSearchParams {
    return new URL(url).searchParams;
  }

  it('always enables the JS API and the reduced-branding options', () => {
    const url = getEmbedUrl({ providerId: 'youtube', videoId: YT_ID, originalUrl: '' })!;

    expect(url.startsWith(`https://www.youtube.com/embed/${YT_ID}?`)).toBe(true);
    expect(params(url).get('enablejsapi')).toBe('1');
    expect(params(url).get('rel')).toBe('0');
    expect(params(url).get('modestbranding')).toBe('1');
    expect(params(url).get('origin')).toBe('');
  });

  it('omits optional parameters that were not requested', () => {
    const url = getEmbedUrl({ providerId: 'youtube', videoId: YT_ID, originalUrl: '' })!;
    const search = params(url);

    expect(search.has('autoplay')).toBe(false);
    expect(search.has('start')).toBe(false);
    expect(search.has('controls')).toBe(false);
    expect(search.has('mute')).toBe(false);
    expect(search.has('loop')).toBe(false);
  });

  it('floors a fractional start time', () => {
    const url = getEmbedUrl(
      { providerId: 'youtube', videoId: YT_ID, originalUrl: '' },
      { startTime: 30.9 }
    )!;

    expect(params(url).get('start')).toBe('30');
  });

  it('drops a zero start time because the option is falsy', () => {
    const url = getEmbedUrl(
      { providerId: 'youtube', videoId: YT_ID, originalUrl: '' },
      { startTime: 0 }
    )!;

    expect(params(url).has('start')).toBe(false);
  });

  it('sets controls=0 only when controls are explicitly disabled', () => {
    const disabled = getEmbedUrl(
      { providerId: 'youtube', videoId: YT_ID, originalUrl: '' },
      { controls: false }
    )!;
    const enabled = getEmbedUrl(
      { providerId: 'youtube', videoId: YT_ID, originalUrl: '' },
      { controls: true }
    )!;

    expect(params(disabled).get('controls')).toBe('0');
    expect(params(enabled).has('controls')).toBe(false);
  });

  it('maps autoplay, loop and muted onto the YouTube parameter names', () => {
    const url = getEmbedUrl(
      { providerId: 'youtube', videoId: YT_ID, originalUrl: '' },
      { autoplay: true, loop: true, muted: true }
    )!;
    const search = params(url);

    expect(search.get('autoplay')).toBe('1');
    expect(search.get('loop')).toBe('1');
    expect(search.get('mute')).toBe('1');
  });

  it.each([
    ['small', 'default'],
    ['medium', 'mqdefault'],
    ['large', 'hqdefault'],
    ['maxres', 'maxresdefault'],
  ] as const)('renders the %s thumbnail as %s', (size, file) => {
    expect(getThumbnailUrl({ providerId: 'youtube', videoId: YT_ID, originalUrl: '' }, size)).toBe(
      `https://img.youtube.com/vi/${YT_ID}/${file}.jpg`
    );
  });

  it('defaults to the medium thumbnail', () => {
    expect(getThumbnailUrl({ providerId: 'youtube', videoId: YT_ID, originalUrl: '' })).toBe(
      `https://img.youtube.com/vi/${YT_ID}/mqdefault.jpg`
    );
  });
});

describe('direct and r2 embed urls', () => {
  it('returns the direct url unchanged when no start time is given', () => {
    const url = 'https://cdn.example.com/clip.mp4';
    expect(getEmbedUrl({ providerId: 'direct', videoId: url, originalUrl: url })).toBe(url);
  });

  // The direct provider floors the start time into the query params but then
  // appends the unfloored value as the media fragment. Asserted as-is.
  it('appends the unfloored start time as a media fragment for a direct url', () => {
    const url = 'https://cdn.example.com/clip.mp4';
    expect(
      getEmbedUrl({ providerId: 'direct', videoId: url, originalUrl: url }, { startTime: 30.5 })
    ).toBe(`${url}#t=30.5`);
  });

  it('uses a query parameter rather than a fragment for an r2 proxy path', () => {
    const path = `/api/upload/video/${UUID}.mp4`;
    expect(
      getEmbedUrl({ providerId: 'r2', videoId: path, originalUrl: path }, { startTime: 12.9 })
    ).toBe(`${path}?t=12`);
  });

  it('returns the r2 proxy path unchanged without a start time', () => {
    const path = `/api/upload/video/${UUID}.mp4`;
    expect(getEmbedUrl({ providerId: 'r2', videoId: path, originalUrl: path })).toBe(path);
  });

  it.each(['direct', 'r2'] as const)('serves the placeholder thumbnail for %s', (providerId) => {
    expect(getThumbnailUrl({ providerId, videoId: 'anything', originalUrl: '' })).toBe(
      '/placeholder-video-thumbnail.png'
    );
  });
});

describe('bunny embed and thumbnail urls', () => {
  it('falls back to library id 0 when none is configured', () => {
    const url = getEmbedUrl({ providerId: 'bunny', videoId: 'guid-1', originalUrl: '' })!;

    expect(url.startsWith('https://iframe.mediadelivery.net/embed/0/guid-1?')).toBe(true);
  });

  it('prefers the public library id over the server one', () => {
    vi.stubEnv('NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID', '111');
    vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '222');

    expect(getEmbedUrl({ providerId: 'bunny', videoId: 'guid-1', originalUrl: '' })).toContain(
      '/embed/111/guid-1'
    );
  });

  it('passes autoplay, loop and muted through as string booleans', () => {
    const url = getEmbedUrl(
      { providerId: 'bunny', videoId: 'guid-1', originalUrl: '' },
      { autoplay: true, loop: true, muted: true }
    )!;
    const search = new URL(url).searchParams;

    expect(search.get('autoplay')).toBe('true');
    expect(search.get('loop')).toBe('true');
    expect(search.get('muted')).toBe('true');
  });

  it('returns an empty thumbnail url when no Bunny CDN host is configured', () => {
    expect(getThumbnailUrl({ providerId: 'bunny', videoId: 'guid-1', originalUrl: '' })).toBe('');
  });

  it('builds the thumbnail url from the configured Bunny CDN host', () => {
    vi.stubEnv('BUNNY_CDN_URL', 'https://cdn.example.b-cdn.net/');

    expect(getThumbnailUrl({ providerId: 'bunny', videoId: 'guid-1', originalUrl: '' })).toBe(
      'https://cdn.example.b-cdn.net/guid-1/thumbnail.jpg'
    );
  });
});

describe('getEmbedUrl and getThumbnailUrl for an unknown provider', () => {
  it('returns null rather than throwing', () => {
    const source = { providerId: 'vimeo' as VideoProviderType, videoId: 'x', originalUrl: '' };

    expect(getEmbedUrl(source)).toBeNull();
    expect(getThumbnailUrl(source)).toBeNull();
  });
});

describe('fetchVideoMetadata', () => {
  it('returns null for an unregistered provider', async () => {
    await expect(
      fetchVideoMetadata({
        providerId: 'vimeo' as VideoProviderType,
        videoId: 'x',
        originalUrl: '',
      })
    ).resolves.toBeNull();
  });

  it('maps the YouTube oEmbed payload onto VideoMetadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        title: 'Never Gonna Give You Up',
        thumbnail_url: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
        author_name: 'Rick Astley',
        author_url: 'https://www.youtube.com/@RickAstley',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchVideoMetadata({
      providerId: 'youtube',
      videoId: 'oembed-hit-1',
      originalUrl: '',
    });

    expect(result).toEqual({
      title: 'Never Gonna Give You Up',
      thumbnailUrl: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
      author: 'Rick Astley',
      authorUrl: 'https://www.youtube.com/@RickAstley',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves the second request for the same video from the cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'Cached', thumbnail_url: 'https://i.ytimg.com/t.jpg' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const source = { providerId: 'youtube' as const, videoId: 'oembed-hit-2', originalUrl: '' };

    await fetchVideoMetadata(source);
    const second = await fetchVideoMetadata(source);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second?.title).toBe('Cached');
  });

  it('falls back to a generated thumbnail when oEmbed responds with an error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    const result = await fetchVideoMetadata({
      providerId: 'youtube',
      videoId: 'oembed-miss-1',
      originalUrl: '',
    });

    expect(result).toEqual({
      title: 'YouTube Video',
      thumbnailUrl: 'https://img.youtube.com/vi/oembed-miss-1/hqdefault.jpg',
    });
  });

  it('falls back when the oEmbed request rejects outright', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await fetchVideoMetadata({
      providerId: 'youtube',
      videoId: 'oembed-miss-2',
      originalUrl: '',
    });

    expect(result?.title).toBe('YouTube Video');
  });

  it('derives a direct upload title from the file name', async () => {
    const url = 'https://cdn.example.com/uploads/final-cut-v3.mp4';

    await expect(
      fetchVideoMetadata({ providerId: 'direct', videoId: url, originalUrl: url })
    ).resolves.toEqual({
      title: 'final-cut-v3',
      thumbnailUrl: '/placeholder-video-thumbnail.png',
    });
  });

  it('returns a placeholder Bunny title without calling the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchVideoMetadata({
      providerId: 'bunny',
      videoId: 'bunny-guid-1',
      originalUrl: '',
    });

    expect(result?.title).toBe('Bunny Video');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('metadata cache', () => {
  const value = { title: 'Cached title', thumbnailUrl: 'https://example.com/t.jpg' };

  it('returns null for a key that was never written', () => {
    expect(getCachedMetadata('cache-test:absent')).toBeNull();
  });

  it('returns the stored value', () => {
    setCachedMetadata('cache-test:hit', value);

    expect(getCachedMetadata('cache-test:hit')).toEqual(value);
  });

  it('still returns the value at the exact expiry instant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T00:00:00.000Z'));
    setCachedMetadata('cache-test:boundary', value, 1000);

    vi.setSystemTime(new Date('2026-01-15T00:00:01.000Z'));

    expect(getCachedMetadata('cache-test:boundary')).toEqual(value);
    vi.useRealTimers();
  });

  it('drops the value one millisecond past expiry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T00:00:00.000Z'));
    setCachedMetadata('cache-test:expired', value, 1000);

    vi.setSystemTime(new Date('2026-01-15T00:00:01.001Z'));

    expect(getCachedMetadata('cache-test:expired')).toBeNull();
    // The expired entry is evicted, so a later read is also a miss.
    vi.setSystemTime(new Date('2026-01-15T00:00:00.000Z'));
    expect(getCachedMetadata('cache-test:expired')).toBeNull();
    vi.useRealTimers();
  });

  it('evicts the least recently used entry once 500 entries are exceeded', () => {
    for (let i = 0; i < 500; i += 1) {
      setCachedMetadata(`lru:${i}`, { ...value, title: `entry-${i}` });
    }

    // Touching lru:0 makes it the most recently used, so lru:1 becomes the victim.
    expect(getCachedMetadata('lru:0')?.title).toBe('entry-0');
    setCachedMetadata('lru:overflow', value);

    expect(getCachedMetadata('lru:1')).toBeNull();
    expect(getCachedMetadata('lru:0')?.title).toBe('entry-0');
    expect(getCachedMetadata('lru:overflow')).toEqual(value);
  });
});

describe('provider extractVideoId guards', () => {
  it.each(['youtube', 'direct', 'bunny', 'r2'] as const)(
    'the %s provider returns null for a url it cannot handle',
    (id) => {
      expect(getProvider(id)!.extractVideoId('https://example.com/not-a-video')).toBeNull();
    }
  );

  it('the direct provider rejects a video extension behind a non-http scheme', () => {
    expect(getProvider('direct')!.extractVideoId('file:///tmp/clip.mp4')).toBeNull();
  });

  it('the r2 provider rejects a proxy path with a traversal segment', () => {
    expect(getProvider('r2')!.extractVideoId('/api/upload/video/../../secret.mp4')).toBeNull();
  });
});

describe('metadata for the self-hosted providers', () => {
  it('derives an r2 title from the proxy path basename', async () => {
    const path = `/api/upload/video/${UUID}.mp4`;

    await expect(
      fetchVideoMetadata({ providerId: 'r2', videoId: path, originalUrl: path })
    ).resolves.toEqual({
      title: UUID,
      thumbnailUrl: '/placeholder-video-thumbnail.png',
    });
  });

  it('falls back to a generic title when the r2 id has no path segments', async () => {
    await expect(
      fetchVideoMetadata({ providerId: 'r2', videoId: '', originalUrl: '' })
    ).resolves.toMatchObject({ title: 'Video' });
  });

  it('falls back to a generic title when the direct url has no path segments', async () => {
    await expect(
      fetchVideoMetadata({ providerId: 'direct', videoId: '', originalUrl: '' })
    ).resolves.toMatchObject({ title: 'Video' });
  });

  it('returns null and logs when a provider getMetadata throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchVideoMetadata({
      providerId: 'direct',
      videoId: null as unknown as string,
      originalUrl: '',
    });

    expect(result).toBeNull();
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('builds the Bunny thumbnail from a protocol-less CDN host', async () => {
    vi.stubEnv('BUNNY_CDN_URL', 'cdn.example.b-cdn.net/');

    const result = await fetchVideoMetadata({
      providerId: 'bunny',
      videoId: 'bunny-guid-fallback',
      originalUrl: '',
    });

    expect(result?.thumbnailUrl).toBe(
      'https://cdn.example.b-cdn.net/bunny-guid-fallback/thumbnail.jpg'
    );
  });
});
