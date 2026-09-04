import { TranscriptStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  canShowTranscriptTranslation,
  overlayTranslatedSegmentTexts,
  shapeTranscriptTranslation,
} from '@/lib/transcript-translation';

describe('overlayTranslatedSegmentTexts', () => {
  it('replaces line text and drops original-language words', () => {
    const overlaid = overlayTranslatedSegmentTexts(
      [
        {
          text: 'Ciao a tutti',
          position: 2,
          words: [{ text: 'Ciao', start: 0, end: 0.4 }],
        },
        {
          text: 'Buongiorno',
          position: 0,
          words: [{ text: 'Buongiorno', start: 1, end: 2 }],
        },
      ],
      ['Hello everyone', 'ignored', 'Good morning']
    );

    expect(overlaid.map((segment) => segment.text)).toEqual(['Good morning', 'Hello everyone']);
    expect(overlaid.map((segment) => segment.words)).toEqual([[], []]);
  });

  it('leaves the original lines when no translation exists', () => {
    const original = [{ text: 'Ciao', position: 0, words: [{ text: 'Ciao', start: 0, end: 1 }] }];
    expect(overlayTranslatedSegmentTexts(original, null)).toBe(original);
    expect(overlayTranslatedSegmentTexts(original, [])).toBe(original);
  });
});

describe('shapeTranscriptTranslation', () => {
  it('is null until a translation has been requested', () => {
    expect(
      shapeTranscriptTranslation({
        translationLanguage: null,
        translationStatus: null,
        translationError: null,
        translatedTexts: null,
      })
    ).toBeNull();
  });

  it('exposes texts only once the translation is READY', () => {
    expect(
      shapeTranscriptTranslation({
        translationLanguage: 'en',
        translationStatus: TranscriptStatus.RUNNING,
        translationError: null,
        translatedTexts: ['Hello'],
      })?.texts
    ).toBeNull();
    expect(
      shapeTranscriptTranslation({
        translationLanguage: 'en',
        translationStatus: TranscriptStatus.READY,
        translationError: null,
        translatedTexts: ['Hello'],
      })
    ).toEqual({
      language: 'en',
      status: 'READY',
      error: null,
      texts: ['Hello'],
    });
  });
});

describe('canShowTranscriptTranslation', () => {
  it('offers English for Italian and not for English', () => {
    expect(canShowTranscriptTranslation('it')).toBe(true);
    expect(canShowTranscriptTranslation('en')).toBe(false);
    expect(canShowTranscriptTranslation('en-US')).toBe(false);
  });
});
