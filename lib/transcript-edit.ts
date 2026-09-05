import { z } from 'zod';
import { splitWords, spreadWordsAcrossRange } from '@/lib/transcript-import';
import type { TranscriptWord } from '@/lib/transcription/types';

export const MAX_SEGMENT_TEXT = 2000;
export const MAX_SPEAKER_LABEL = 80;

const patchSchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_SEGMENT_TEXT),
    speaker: z.string().trim().max(MAX_SPEAKER_LABEL).nullable().optional(),
  })
  .strict();

export type SegmentPatch = z.infer<typeof patchSchema>;

export function parseSegmentPatch(
  input: unknown
): { ok: true; value: SegmentPatch } | { ok: false; error: string } {
  const parsed = patchSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid segment',
    };
  }
  return { ok: true, value: parsed.data };
}

function timedWords(value: unknown): TranscriptWord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (word): word is TranscriptWord =>
      typeof word === 'object' &&
      word !== null &&
      typeof (word as TranscriptWord).start === 'number' &&
      typeof (word as TranscriptWord).end === 'number' &&
      typeof (word as TranscriptWord).text === 'string'
  );
}

/**
 * New words for an edited segment. When the count matches the stored timed
 * words, each keeps its timing (a misheard word fixed in place); otherwise
 * the words are spread evenly across the segment, as an uploaded SRT is.
 */
export function retimeSegmentWords(
  previousWords: unknown,
  text: string,
  startSec: number,
  endSec: number
): TranscriptWord[] {
  const next = splitWords(text);
  const previous = timedWords(previousWords);
  if (previous.length > 0 && previous.length === next.length) {
    return previous.map((word, index) => ({
      start: word.start,
      end: word.end,
      text: next[index]!,
    }));
  }
  return spreadWordsAcrossRange(next, startSec, endSec);
}
