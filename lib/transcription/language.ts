/**
 * Transcript rows are keyed by language. Until STT reports what it heard,
 * the pending row uses ISO 639-3 "und" (undetermined) so we do not pretend
 * the audio is English.
 */
export const AUTO_DETECT_TRANSCRIPT_LANGUAGE = 'und';

export const DEFAULT_TRANSLATION_LANGUAGE = 'en';

const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i;

export function isAutoDetectLanguage(language?: string | null): boolean {
  if (typeof language !== 'string') return true;
  const normalized = language.trim().toLowerCase();
  return normalized === '' || normalized === 'und' || normalized === 'auto';
}

/**
 * Language code to send to Whisper / Deepgram / faster-whisper. Empty means
 * "detect it", which is what keeps Italian audio from being forced into English.
 */
export function languageForProvider(language?: string | null): string | undefined {
  if (typeof language !== 'string' || isAutoDetectLanguage(language)) return undefined;
  const primary = language.trim().toLowerCase().split('-')[0] ?? '';
  if (primary.length < 2 || primary.length > 3) return undefined;
  return primary;
}

export function normalizeDetectedLanguage(
  raw?: string | null,
  fallback = AUTO_DETECT_TRANSCRIPT_LANGUAGE
): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || isAutoDetectLanguage(trimmed) || !LANGUAGE_TAG.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}

/**
 * Body `language` from a transcribe request. Missing, blank, or "auto" means
 * detect. An explicit tag is a hint to the provider, not a request to translate.
 */
export function parseRequestedTranscriptLanguage(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    return AUTO_DETECT_TRANSCRIPT_LANGUAGE;
  }
  return normalizeDetectedLanguage(raw, AUTO_DETECT_TRANSCRIPT_LANGUAGE);
}

export function primaryTranscriptLanguage(language?: string | null): string {
  if (typeof language !== 'string' || isAutoDetectLanguage(language)) {
    return AUTO_DETECT_TRANSCRIPT_LANGUAGE;
  }
  return language.trim().toLowerCase().split('-')[0] ?? AUTO_DETECT_TRANSCRIPT_LANGUAGE;
}

export function isEnglishLanguage(language?: string | null): boolean {
  return primaryTranscriptLanguage(language) === 'en';
}
