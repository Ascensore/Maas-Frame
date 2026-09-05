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
 * How many leading words two lists share, by text.
 */
function commonPrefixLength(previous: TranscriptWord[], next: string[]): number {
  let count = 0;
  while (count < previous.length && count < next.length && previous[count]!.text === next[count]) {
    count += 1;
  }
  return count;
}

/**
 * How many trailing words two lists share, by text, without overlapping the
 * prefix already claimed.
 */
function commonSuffixLength(previous: TranscriptWord[], next: string[], prefix: number): number {
  const room = Math.min(previous.length, next.length) - prefix;
  let count = 0;
  while (
    count < room &&
    previous[previous.length - 1 - count]!.text === next[next.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

/**
 * New words for an edited segment.
 *
 * When the count matches the stored timed words, each keeps its timing: a
 * misheard word fixed in place moves nothing around it. When the count changes,
 * the words the edit did not touch — the longest matching run at each end — keep
 * their real timings too, and only the changed middle is guessed at, spread
 * across the gap the untouched neighbours leave. Falling back to spreading the
 * whole line, the rule an uploaded SRT follows, would throw away timings the
 * provider measured for words nobody edited.
 */
export function retimeSegmentWords(
  previousWords: unknown,
  text: string,
  startSec: number,
  endSec: number
): TranscriptWord[] {
  const next = splitWords(text);
  const previous = timedWords(previousWords);

  const fullSpread = () => spreadWordsAcrossRange(next, startSec, endSec);

  if (previous.length === 0) return fullSpread();
  if (previous.length === next.length) {
    return previous.map((word, index) => ({
      start: word.start,
      end: word.end,
      text: next[index]!,
    }));
  }

  const prefix = commonPrefixLength(previous, next);
  const suffix = commonSuffixLength(previous, next, prefix);
  if (prefix === 0 && suffix === 0) return fullSpread();

  const head = previous.slice(0, prefix);
  const tail = suffix > 0 ? previous.slice(previous.length - suffix) : [];
  const middleTexts = next.slice(prefix, next.length - suffix);

  if (middleTexts.length === 0) {
    return [...head, ...tail].map((word) => ({
      start: word.start,
      end: word.end,
      text: word.text,
    }));
  }

  const middleStart = prefix > 0 ? head[head.length - 1]!.end : startSec;
  const middleEnd = suffix > 0 ? tail[0]!.start : endSec;
  const middle = spreadWordsAcrossRange(middleTexts, middleStart, middleEnd);
  // No gap to put the new words in (the kept neighbours touch, or run
  // backwards). Guessing every timing beats dropping a word the user typed.
  if (middle.length !== middleTexts.length) return fullSpread();

  return [
    ...head.map((word) => ({ start: word.start, end: word.end, text: word.text })),
    ...middle,
    ...tail.map((word) => ({ start: word.start, end: word.end, text: word.text })),
  ];
}
