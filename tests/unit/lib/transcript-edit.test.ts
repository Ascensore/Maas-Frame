import { describe, expect, it } from 'vitest';
import { parseSegmentPatch, retimeSegmentWords } from '@/lib/transcript-edit';
import type { TranscriptWord } from '@/lib/transcription/types';

/**
 * What the rest of the app assumes about a segment's words: one per word of the
 * text, in order, never running backwards and never outside the line. A cue
 * built from words that break any of these is a cue that draws at the wrong
 * time or not at all.
 */
function expectWellTimed(
  words: TranscriptWord[],
  text: string,
  startSec: number,
  endSec: number
): void {
  expect(words.map((word) => word.text)).toEqual(text.split(' '));
  let cursor = startSec;
  for (const word of words) {
    expect(word.start).toBeGreaterThanOrEqual(cursor);
    expect(word.end).toBeGreaterThanOrEqual(word.start);
    expect(word.end).toBeLessThanOrEqual(endSec);
    cursor = word.end;
  }
}

describe('retimeSegmentWords', () => {
  const words = [
    { start: 1, end: 1.4, text: 'we' },
    { start: 1.5, end: 1.9, text: 'held' },
    { start: 2, end: 2.6, text: 'founders' },
  ];

  it('keeps the timings when the word count is unchanged', () => {
    expect(retimeSegmentWords(words, 'we help founders', 1, 3)).toEqual([
      { start: 1, end: 1.4, text: 'we' },
      { start: 1.5, end: 1.9, text: 'help' },
      { start: 2, end: 2.6, text: 'founders' },
    ]);
  });

  it('keeps the untouched neighbours when a word is inserted', () => {
    // Only 'all' is new, so only 'all' is guessed at: it lands in the silence
    // between 'help' and 'founders' and the three real timings survive.
    expect(retimeSegmentWords(words, 'we held all founders', 1, 3)).toEqual([
      { start: 1, end: 1.4, text: 'we' },
      { start: 1.5, end: 1.9, text: 'held' },
      { start: 1.9, end: 2, text: 'all' },
      { start: 2, end: 2.6, text: 'founders' },
    ]);
  });

  it('keeps the untouched neighbours when a word is deleted', () => {
    expect(retimeSegmentWords(words, 'we founders', 1, 3)).toEqual([
      { start: 1, end: 1.4, text: 'we' },
      { start: 2, end: 2.6, text: 'founders' },
    ]);
  });

  it('respreads only the changed middle', () => {
    expect(retimeSegmentWords(words, 'we really love founders', 1, 3)).toEqual([
      { start: 1, end: 1.4, text: 'we' },
      { start: 1.4, end: 1.7, text: 'really' },
      { start: 1.7, end: 2, text: 'love' },
      { start: 2, end: 2.6, text: 'founders' },
    ]);
  });

  it('spreads across the whole segment when nothing is in common', () => {
    expect(retimeSegmentWords(words, 'entirely different line here', 1, 3)).toEqual([
      { start: 1, end: 1.5, text: 'entirely' },
      { start: 1.5, end: 2, text: 'different' },
      { start: 2, end: 2.5, text: 'line' },
      { start: 2.5, end: 3, text: 'here' },
    ]);
  });

  it('falls back to a full spread when the kept words leave no room', () => {
    // 'we' ends exactly where 'founders' begins, so the inserted word has no
    // gap to sit in. Guessing every timing beats dropping the word.
    const touching = [
      { start: 1, end: 2, text: 'we' },
      { start: 2, end: 3, text: 'founders' },
    ];
    expect(retimeSegmentWords(touching, 'we help founders', 1, 3)).toEqual([
      { start: 1, end: 1 + 2 / 3, text: 'we' },
      { start: 1 + 2 / 3, end: 1 + 4 / 3, text: 'help' },
      { start: 1 + 4 / 3, end: 3, text: 'founders' },
    ]);
  });

  it('retimes a line of repeated words without losing or inventing one', () => {
    // Every word matches every other by text, so the prefix run and the suffix
    // run each look like the whole line. Only the `- prefix` in the suffix
    // search keeps them from claiming the same words twice; without it a
    // shortened line comes back with words the text no longer has, and a
    // lengthened one repeats a timing.
    const three = [
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'a' },
      { start: 2, end: 3, text: 'a' },
    ];

    const shortened = retimeSegmentWords(three, 'a a', 0, 3);
    expect(shortened).toEqual([
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'a' },
    ]);
    expectWellTimed(shortened, 'a a', 0, 3);

    const lengthened = retimeSegmentWords(shortened, 'a a a', 0, 3);
    // The two kept words hold their measured timings and the third is guessed
    // into the tail of the line, not squeezed on top of one of them.
    expect(lengthened).toEqual([
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'a' },
      { start: 2, end: 3, text: 'a' },
    ]);
    expectWellTimed(lengthened, 'a a a', 0, 3);
  });

  it('spreads when the stored words are not timed', () => {
    expect(retimeSegmentWords([], 'hello there', 0, 1)).toEqual([
      { start: 0, end: 0.5, text: 'hello' },
      { start: 0.5, end: 1, text: 'there' },
    ]);
    expect(retimeSegmentWords('garbage', 'hello', 0, 0)).toEqual([]);
  });
});

describe('parseSegmentPatch', () => {
  it('accepts text and an optional speaker and refuses blanks and oversize', () => {
    // zod 4 omits an absent optional key rather than setting it to undefined,
    // and the PATCH route depends on that: `'speaker' in value` is what tells
    // "the patch did not mention the speaker" from "clear the speaker".
    // toStrictEqual is what pins the difference; toEqual would accept either.
    expect(parseSegmentPatch({ text: '  Hello  ' })).toStrictEqual({
      ok: true,
      value: { text: 'Hello' },
    });
    expect(parseSegmentPatch({ text: 'Hi', speaker: null })).toStrictEqual({
      ok: true,
      value: { text: 'Hi', speaker: null },
    });
    expect(parseSegmentPatch({ text: '   ' }).ok).toBe(false);
    expect(parseSegmentPatch({ text: 'x'.repeat(2001) }).ok).toBe(false);
    expect(parseSegmentPatch({ text: 'Hi', speaker: 'x'.repeat(81) }).ok).toBe(false);
    expect(parseSegmentPatch({}).ok).toBe(false);
  });
});
