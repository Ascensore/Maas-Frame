import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchYoutubeTranscript,
  isYoutubeVideoId,
  parseYoutubeJson3Events,
  pickYoutubeCaptionTrack,
} from '@/lib/transcription/youtube';

describe('isYoutubeVideoId', () => {
  it('accepts an 11-character id', () => {
    expect(isYoutubeVideoId('QMRh3oE5BaU')).toBe(true);
  });

  it('rejects factory placeholders', () => {
    expect(isYoutubeVideoId('provider-video-1')).toBe(false);
  });
});

describe('pickYoutubeCaptionTrack', () => {
  it('prefers a human track in the requested language over auto-captions', () => {
    const chosen = pickYoutubeCaptionTrack(
      [
        { languageCode: 'en', kind: 'asr', baseUrl: 'https://example.test/asr' },
        { languageCode: 'en', baseUrl: 'https://example.test/human' },
        { languageCode: 'es', baseUrl: 'https://example.test/es' },
      ],
      'en'
    );
    expect(chosen?.baseUrl).toBe('https://example.test/human');
  });

  it('falls back to auto-captions when no human track matches', () => {
    const chosen = pickYoutubeCaptionTrack(
      [{ languageCode: 'en', kind: 'asr', baseUrl: 'https://example.test/asr' }],
      'en'
    );
    expect(chosen?.baseUrl).toBe('https://example.test/asr');
  });

  it('uses another language when the requested one is missing', () => {
    const chosen = pickYoutubeCaptionTrack(
      [{ languageCode: 'de', baseUrl: 'https://example.test/de' }],
      'en'
    );
    expect(chosen?.baseUrl).toBe('https://example.test/de');
  });
});

describe('parseYoutubeJson3Events', () => {
  it('turns word-timed events into segments and skips blank lines', () => {
    const segments = parseYoutubeJson3Events([
      { tStartMs: 0, dDurationMs: 31039 },
      {
        tStartMs: 160,
        dDurationMs: 4720,
        segs: [
          { utf8: 'Work' },
          { utf8: ' today', tOffsetMs: 320 },
          { utf8: ' is', tOffsetMs: 640 },
          { utf8: ' broken.', tOffsetMs: 880 },
        ],
      },
      { tStartMs: 2629, dDurationMs: 2251, segs: [{ utf8: '\n' }] },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.startSec).toBe(0.16);
    expect(segments[0]?.endSec).toBe(4.88);
    expect(segments[0]?.text).toBe('Work today is broken.');
    expect(segments[0]?.words.map((word) => word.text)).toEqual(['Work', 'today', 'is', 'broken.']);
  });
});

describe('fetchYoutubeTranscript', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not call YouTube when the id is not a video id', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchYoutubeTranscript('provider-video-1', 'en');

    expect(result).toEqual({
      ok: false,
      error: 'This YouTube version has no usable video id',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('imports json3 captions from the Android player response', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/youtubei/v1/player')) {
        return new Response(
          JSON.stringify({
            playabilityStatus: { status: 'OK' },
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  {
                    languageCode: 'en',
                    kind: 'asr',
                    baseUrl: 'https://www.youtube.com/api/timedtext?v=QMRh3oE5BaU&fmt=srv3',
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/api/timedtext')) {
        expect(url).toContain('fmt=json3');
        return new Response(
          JSON.stringify({
            events: [
              {
                tStartMs: 160,
                dDurationMs: 2000,
                segs: [{ utf8: 'Hello' }, { utf8: ' world', tOffsetMs: 400 }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchYoutubeTranscript('QMRh3oE5BaU', 'en');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.language).toBe('en');
    expect(result.segments.map((segment) => segment.text)).toEqual(['Hello world']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails when the video has no caption tracks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            playabilityStatus: { status: 'OK' },
            captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
          }),
          { status: 200 }
        );
      })
    );

    await expect(fetchYoutubeTranscript('QMRh3oE5BaU', 'en')).resolves.toEqual({
      ok: false,
      error: 'This YouTube video has no captions to import',
    });
  });
});
