import { TranscriptStatus } from '@prisma/client';
import { DEFAULT_TRANSLATION_LANGUAGE, isEnglishLanguage } from '@/lib/transcription/language';

export { DEFAULT_TRANSLATION_LANGUAGE };

export type TranscriptTranslationPayload = {
  language: string;
  status: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';
  error: string | null;
  texts: string[] | null;
};

export function parseTranslatedTexts(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((entry): entry is string => typeof entry === 'string')) return null;
  return value;
}

export function shapeTranscriptTranslation(input: {
  translationLanguage: string | null;
  translationStatus: TranscriptStatus | null;
  translationError: string | null;
  translatedTexts: unknown;
}): TranscriptTranslationPayload | null {
  if (!input.translationLanguage && !input.translationStatus) return null;
  const status = input.translationStatus ?? TranscriptStatus.PENDING;
  const texts =
    status === TranscriptStatus.READY ? parseTranslatedTexts(input.translatedTexts) : null;
  return {
    language: input.translationLanguage ?? DEFAULT_TRANSLATION_LANGUAGE,
    status,
    error: input.translationError,
    texts,
  };
}

export function canShowTranscriptTranslation(language?: string | null): boolean {
  return !isEnglishLanguage(language);
}

/**
 * Swap in translated line text for display. Word timings stay on the original
 * language, so they are dropped — otherwise the pane would show Italian words
 * under an English sentence.
 */
export function overlayTranslatedSegmentTexts<
  T extends { text: string; position: number; words?: unknown },
>(segments: T[], translatedTexts: string[] | null | undefined): T[] {
  if (!translatedTexts || translatedTexts.length === 0) return segments;
  return segments.map((segment, index) => {
    const translated = translatedTexts[segment.position] ?? translatedTexts[index];
    if (typeof translated !== 'string' || !translated) return segment;
    return { ...segment, text: translated, words: [] };
  });
}
