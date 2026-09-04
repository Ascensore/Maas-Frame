import { describe, expect, it } from 'vitest';
import {
  isAutoDetectLanguage,
  languageForProvider,
  normalizeDetectedLanguage,
  parseRequestedTranscriptLanguage,
} from '@/lib/transcription/language';

describe('parseRequestedTranscriptLanguage', () => {
  it('treats a missing or blank body as auto-detect, not English', () => {
    expect(parseRequestedTranscriptLanguage(undefined)).toBe('und');
    expect(parseRequestedTranscriptLanguage('')).toBe('und');
    expect(parseRequestedTranscriptLanguage('auto')).toBe('und');
    expect(parseRequestedTranscriptLanguage('und')).toBe('und');
    expect(parseRequestedTranscriptLanguage(undefined)).not.toBe('en');
  });

  it('keeps an explicit language tag', () => {
    expect(parseRequestedTranscriptLanguage('IT')).toBe('it');
    expect(parseRequestedTranscriptLanguage('en')).toBe('en');
  });
});

describe('languageForProvider', () => {
  it('omits auto-detect so Whisper is not told the audio is English', () => {
    expect(languageForProvider(undefined)).toBeUndefined();
    expect(languageForProvider('und')).toBeUndefined();
    expect(languageForProvider('auto')).toBeUndefined();
  });

  it('sends the primary subtag when the caller asked for a language', () => {
    expect(languageForProvider('it')).toBe('it');
    expect(languageForProvider('en-US')).toBe('en');
  });
});

describe('normalizeDetectedLanguage', () => {
  it('keeps a Whisper ISO code and rejects junk', () => {
    expect(normalizeDetectedLanguage('it')).toBe('it');
    expect(normalizeDetectedLanguage('ITALIAN')).toBe('und');
    expect(normalizeDetectedLanguage('ITALIAN')).not.toBe('en');
  });
});

describe('isAutoDetectLanguage', () => {
  it('is true only for empty, und, and auto', () => {
    expect(isAutoDetectLanguage('it')).toBe(false);
    expect(isAutoDetectLanguage('en')).toBe(false);
    expect(isAutoDetectLanguage('und')).toBe(true);
    expect(isAutoDetectLanguage('auto')).toBe(true);
    expect(isAutoDetectLanguage('')).toBe(true);
    expect(isAutoDetectLanguage(undefined)).toBe(true);
  });
});
