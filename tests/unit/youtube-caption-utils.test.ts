import { describe, it, expect } from 'vitest';
import { mergeYoutubeCaptionTracks } from '@/components/video-page/hooks/use-youtube-captions';
import type { SubtitleTrackOption } from '@/components/video-page/types';

const ENGLISH: SubtitleTrackOption = {
  id: 'youtube:en',
  language: 'en',
  label: 'English',
  canDelete: false,
};

const FRENCH: SubtitleTrackOption = {
  id: 'youtube:fr',
  language: 'fr',
  label: 'French',
  canDelete: false,
};

describe('mergeYoutubeCaptionTracks', () => {
  it('keeps the last known list when the module unloads and reports nothing', () => {
    expect(mergeYoutubeCaptionTracks([], [ENGLISH])).toEqual([ENGLISH]);
  });

  it('replaces a previous list when YouTube answers with a different one', () => {
    expect(mergeYoutubeCaptionTracks([ENGLISH], [FRENCH])).toEqual([ENGLISH]);
  });

  it('takes the first non-empty list when nothing was known yet', () => {
    expect(mergeYoutubeCaptionTracks([ENGLISH], [])).toEqual([ENGLISH]);
  });
});
