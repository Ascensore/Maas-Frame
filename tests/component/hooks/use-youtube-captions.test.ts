import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useYoutubeCaptions } from '@/components/video-page/hooks/use-youtube-captions';

type CaptionTrack = { languageCode: string; displayName?: string; languageName?: string };

function makePlayer(getTracklist: () => CaptionTrack[]) {
  return {
    loadModule: vi.fn(),
    unloadModule: vi.fn(),
    setOption: vi.fn(),
    getOption: vi.fn(() => getTracklist()),
  };
}

describe('useYoutubeCaptions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the CC list after YouTube unloads the captions module', async () => {
    let calls = 0;
    const player = makePlayer(() => {
      calls += 1;
      return calls === 1 ? [{ languageCode: 'en', displayName: 'English' }] : [];
    });

    const { result } = renderHook(() =>
      useYoutubeCaptions({
        videoId: 'vid1',
        versionId: 'ver1',
        playerRef: { current: player as unknown as YT.Player },
        enabled: true,
        isReady: true,
        moduleRevision: 1,
      })
    );

    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current.youtubeCaptionTracks).toEqual([
      { id: 'youtube:en', language: 'en', label: 'English', canDelete: false },
    ]);

    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.youtubeCaptionTracks).toEqual([
      { id: 'youtube:en', language: 'en', label: 'English', canDelete: false },
    ]);
  });

  it('replaces the CC list when YouTube reports a different tracklist', async () => {
    let calls = 0;
    const player = makePlayer(() => {
      calls += 1;
      return calls === 1
        ? [{ languageCode: 'fr', languageName: 'French' }]
        : [{ languageCode: 'en', displayName: 'English' }];
    });

    const { result } = renderHook(() =>
      useYoutubeCaptions({
        videoId: 'vid1',
        versionId: 'ver1',
        playerRef: { current: player as unknown as YT.Player },
        enabled: true,
        isReady: true,
        moduleRevision: 1,
      })
    );

    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current.youtubeCaptionTracks.map((track) => track.language)).toEqual(['fr']);

    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.youtubeCaptionTracks.map((track) => track.language)).toEqual(['en']);
  });
});
