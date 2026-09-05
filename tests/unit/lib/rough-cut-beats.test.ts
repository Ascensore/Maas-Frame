import { describe, expect, it } from 'vitest';
import {
  analyseSpeech,
  beatText,
  cutWordsFromBeat,
  detectFalseStarts,
  wordsFromSegments,
  type Beat,
} from '@/lib/rough-cut/beats';
import { SILENCE_AGGRESSIVENESS } from '@/lib/rough-cut/brief';
import { fillerWordsFor } from '@/lib/rough-cut/text';
import type { TranscriptSegmentRow } from '@/lib/rough-cut/transcript-source';

const MEDIUM = SILENCE_AGGRESSIVENESS.medium;
const EN = fillerWordsFor('en');

/** Words spaced `gap` apart, each `length` long, starting at `at`. */
function spoken(
  at: number,
  text: string,
  options: { gap?: number; length?: number; speaker?: string | null } = {}
): TranscriptSegmentRow {
  const gap = options.gap ?? 0.1;
  const length = options.length ?? 0.3;
  const words = text.split(' ').map((word, index) => ({
    start: at + index * (length + gap),
    end: at + index * (length + gap) + length,
    text: word,
  }));
  return {
    startSec: words[0]!.start,
    endSec: words[words.length - 1]!.end,
    speaker: options.speaker ?? null,
    text,
    words,
  };
}

function ranges(items: Array<{ start: number; end: number }>): Array<[number, number]> {
  return items.map((item) => [Number(item.start.toFixed(3)), Number(item.end.toFixed(3))]);
}

describe('wordsFromSegments', () => {
  it('uses word timings when present and the segment span otherwise, clamped and sorted', () => {
    const words = wordsFromSegments(
      [
        { startSec: 5, endSec: 7, speaker: 'B', text: 'later words', words: [] },
        {
          startSec: 0,
          endSec: 2,
          speaker: 'A',
          text: 'hi there',
          words: [
            { start: 0.2, end: 0.5, text: 'hi' },
            { start: 0.6, end: 12, text: 'there' },
            { start: 0.9, end: 1.0, text: '  ' },
          ],
        },
      ],
      10
    );

    expect(words).toEqual([
      { start: 0.2, end: 0.5, text: 'hi', speaker: 'A' },
      { start: 0.6, end: 10, text: 'there', speaker: 'A' },
      { start: 5, end: 7, text: 'later words', speaker: 'B' },
    ]);
  });
});

describe('analyseSpeech', () => {
  it('keeps a pause under the inside limit and cuts a stall over it without ending the beat', () => {
    // "we launched" [0.0-0.7] … stall of 1.0 s … "the product" (still mid-sentence, no period)
    const analysis = analyseSpeech([spoken(0, 'we launched'), spoken(1.7, 'the product today.')], {
      versionId: 'v',
      durationSeconds: 3.5,
      policy: MEDIUM,
    });

    expect(analysis.beats).toHaveLength(1);
    expect(ranges(analysis.beats[0]!.runs)).toEqual([
      [0, 0.7],
      [1.7, 2.8],
    ]);
    expect(analysis.cuts).toEqual([
      {
        versionId: 'v',
        start: 0.7,
        end: 1.7,
        code: 'DEAD_AIR',
        summary: '1.0s of dead air mid-sentence',
        text: null,
      },
    ]);
  });

  it('allows a longer pause after a full stop, and ends the beat past the between limit', () => {
    // Sentence ends at 0.7; a 1.2 s breath (over inside 0.8, under between 1.5) is kept.
    // Then a 2.0 s pause after the next sentence ends the beat and is cut.
    const analysis = analyseSpeech(
      [spoken(0, 'first thought.'), spoken(1.9, 'second thought.'), spoken(4.6, 'third one.')],
      { versionId: 'v', durationSeconds: 6, policy: MEDIUM }
    );

    expect(analysis.beats.map((beat) => beatText(beat))).toEqual([
      'first thought. second thought.',
      'third one.',
    ]);
    expect(ranges(analysis.beats[0]!.runs)).toEqual([[0, 2.6]]);
    expect(ranges(analysis.cuts)).toEqual([[2.6, 4.6]]);
    expect(analysis.cuts[0]!.summary).toBe('2.0s of dead air between thoughts');
  });

  it('ends a beat on a speaker change without cutting a short handover', () => {
    const analysis = analyseSpeech(
      [
        spoken(0, 'so what happened', { speaker: 'A' }),
        spoken(1.2, 'well we sold', { speaker: 'B' }),
      ],
      { versionId: 'v', durationSeconds: 3.5, policy: MEDIUM }
    );

    expect(analysis.beats.map((beat) => [beat.speaker, beatText(beat)])).toEqual([
      ['A', 'so what happened'],
      ['B', 'well we sold'],
    ]);
    expect(analysis.cuts).toEqual([]);
  });

  it('records leading and trailing dead air only past the between limit', () => {
    const analysis = analyseSpeech([spoken(3, 'hello everyone tonight')], {
      versionId: 'v',
      durationSeconds: 10,
      policy: MEDIUM,
    });

    expect(ranges(analysis.cuts)).toEqual([
      [0, 3],
      [4.1, 10],
    ]);
    expect(analysis.cuts.map((cut) => cut.summary)).toEqual([
      '3.0s of dead air before the first word',
      '5.9s of dead air after the last word',
    ]);
    expect(
      analyseSpeech([spoken(1, 'hello everyone tonight')], {
        versionId: 'v',
        durationSeconds: 3.5,
        policy: MEDIUM,
      }).cuts
    ).toEqual([]);
  });

  it('follows the policy: high cuts what medium keeps', () => {
    const segments = [spoken(0, 'we launched'), spoken(1.3, 'the product today.')];
    const medium = analyseSpeech(segments, { versionId: 'v', durationSeconds: 3, policy: MEDIUM });
    const high = analyseSpeech(segments, {
      versionId: 'v',
      durationSeconds: 3,
      policy: SILENCE_AGGRESSIVENESS.high,
    });

    expect(medium.cuts).toEqual([]);
    expect(ranges(high.cuts)).toEqual([[0.7, 1.3]]);
  });

  it('returns nothing for a transcript with no words', () => {
    expect(analyseSpeech([], { versionId: 'v', durationSeconds: 10, policy: MEDIUM })).toEqual({
      beats: [],
      cuts: [],
      runs: [],
    });
  });
});

describe('detectFalseStarts', () => {
  const policy = SILENCE_AGGRESSIVENESS.medium;

  it('cuts a short beat whose opening the next beat repeats and extends', () => {
    const { beats } = analyseSpeech(
      [
        spoken(0, 'so the um market'),
        spoken(4, 'so the market for this is enormous and growing fast.'),
      ],
      { versionId: 'v', durationSeconds: 30, policy }
    );

    const result = detectFalseStarts(beats, EN);

    expect(result.beats.map(beatText)).toEqual([
      'so the market for this is enormous and growing fast.',
    ]);
    expect(ranges(result.cuts)).toEqual([[0, 1.5]]);
    expect(result.cuts[0]).toMatchObject({
      versionId: 'v',
      code: 'FALSE_START',
      summary: 'False start of “so the market for this is enormous and growing fast.”',
      text: 'so the um market',
    });
  });

  it('collapses a chain of restarts to the final take, comparing each against the survivor', () => {
    // The first attempt is longer than the second, so it is a false start only
    // of the final take, never of its immediate neighbour.
    const { beats } = analyseSpeech(
      [
        spoken(0, 'our revenue this year'),
        spoken(3.5, 'our revenue this'),
        spoken(7, 'our revenue this year doubled to four million.'),
      ],
      { versionId: 'v', durationSeconds: 30, policy }
    );

    const result = detectFalseStarts(beats, EN);

    expect(result.beats.map(beatText)).toEqual(['our revenue this year doubled to four million.']);
    expect(ranges(result.cuts)).toEqual([
      [0, 1.5],
      [3.5, 4.6],
    ]);
    expect(result.cuts.map((cut) => cut.summary)).toEqual([
      'False start of “our revenue this year doubled to four million.”',
      'False start of “our revenue this year doubled to four million.”',
    ]);
  });

  it('works on an uploaded transcript whose segments carry no word timings', () => {
    const { beats } = analyseSpeech(
      [
        { startSec: 0, endSec: 1.1, speaker: null, text: 'so the market', words: [] },
        {
          startSec: 3,
          endSec: 6,
          speaker: null,
          text: 'so the market for this is enormous.',
          words: [],
        },
      ],
      { versionId: 'v', durationSeconds: 6, policy }
    );

    const result = detectFalseStarts(beats, EN);

    expect(ranges(result.cuts)).toEqual([[0, 1.1]]);
    expect(result.beats.map(beatText)).toEqual(['so the market for this is enormous.']);
  });

  it('needs three opening words, a beat under four seconds, and a retake that goes on', () => {
    // Nine words at 0.4 s pitch last 3.5 s: still a false start.
    const nineWords = analyseSpeech(
      [
        spoken(0, 'so the market for this is enormous and growing'),
        spoken(6, 'so the market for this is enormous and growing fast every year.'),
      ],
      { versionId: 'v', durationSeconds: 30, policy }
    ).beats;
    expect(ranges(detectFalseStarts(nineWords, EN).cuts)).toEqual([[0, 3.5]]);

    // Two opening words are not enough to call it a false start.
    const twoWords = analyseSpeech([spoken(0, 'so the'), spoken(3, 'so the market is huge')], {
      versionId: 'v',
      durationSeconds: 30,
      policy,
    }).beats;
    expect(detectFalseStarts(twoWords, EN).cuts).toEqual([]);

    // A repeat of exactly the same words is a take, not a false start.
    const sameLength = analyseSpeech([spoken(0, 'so the market'), spoken(3, 'so the market')], {
      versionId: 'v',
      durationSeconds: 30,
      policy,
    }).beats;
    expect(detectFalseStarts(sameLength, EN).cuts).toEqual([]);
  });

  it('leaves a long beat, a different opening, a different speaker, and a shorter retake alone', () => {
    const long = analyseSpeech(
      [
        spoken(0, 'this is a deliberately long sentence that runs well past the limit ok'),
        spoken(9, 'this is a deliberately long sentence that runs well past the limit ok and on'),
      ],
      { versionId: 'v', durationSeconds: 30, policy }
    ).beats;
    expect(detectFalseStarts(long, EN).cuts).toEqual([]);

    const different = analyseSpeech(
      [spoken(0, 'so the market'), spoken(3, 'and the market grew')],
      {
        versionId: 'v',
        durationSeconds: 30,
        policy,
      }
    ).beats;
    expect(detectFalseStarts(different, EN).cuts).toEqual([]);

    const speakers = analyseSpeech(
      [
        spoken(0, 'so the market', { speaker: 'A' }),
        spoken(3, 'so the market is huge', { speaker: 'B' }),
      ],
      { versionId: 'v', durationSeconds: 30, policy }
    ).beats;
    expect(detectFalseStarts(speakers, EN).cuts).toEqual([]);

    const shorter = analyseSpeech(
      [spoken(0, 'so the market is huge'), spoken(4, 'so the market')],
      {
        versionId: 'v',
        durationSeconds: 30,
        policy,
      }
    ).beats;
    expect(detectFalseStarts(shorter, EN).cuts).toEqual([]);
  });
});

/** One beat of 0.8 s words a second apart: 0.2 s gaps, well inside the low policy. */
function beatOf(text: string, at = 0): Beat {
  return analyseSpeech([spoken(at, text, { gap: 0.2, length: 0.8 })], {
    versionId: 'v',
    durationSeconds: 1000,
    policy: SILENCE_AGGRESSIVENESS.low,
  }).beats[0]!;
}

describe('cutWordsFromBeat', () => {
  it('removes a suffix span, shortens the beat and its run, and reports the removed range', () => {
    const beat = beatOf('one two three four five six');
    const result = cutWordsFromBeat(beat, [{ wordStart: 4, wordEnd: 6 }]);
    expect(result.beat?.words.map((word) => word.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(result.beat?.end).toBe(3.8);
    // The kept run ends with the last kept word, not where the removed span starts.
    expect(result.beat?.runs).toEqual([{ start: 0, end: 3.8 }]);
    expect(result.removed).toEqual([{ span: 0, start: 4, end: 5.8, text: 'five six' }]);
  });

  it('splits a run around a middle span and returns null when nothing is left', () => {
    const beat = beatOf('one two three four five six');
    const middle = cutWordsFromBeat(beat, [{ wordStart: 2, wordEnd: 4 }]);
    expect(middle.beat?.runs).toEqual([
      { start: 0, end: 1.8 },
      { start: 4, end: 5.8 },
    ]);
    expect(middle.beat?.words.map((word) => word.text)).toEqual(['one', 'two', 'five', 'six']);
    expect(middle.beat?.start).toBe(0);
    expect(middle.beat?.end).toBe(5.8);
    expect(cutWordsFromBeat(beat, [{ wordStart: 0, wordEnd: 6 }]).beat).toBeNull();
  });

  it('ignores an empty or out-of-range span and leaves the beat untouched', () => {
    const beat = beatOf('one two three four five six');
    const result = cutWordsFromBeat(beat, [
      { wordStart: 3, wordEnd: 3 },
      { wordStart: 9, wordEnd: 12 },
    ]);
    expect(result.removed).toEqual([]);
    expect(result.beat?.words).toHaveLength(6);
    expect(result.beat?.runs).toEqual([{ start: 0, end: 5.8 }]);
  });

  it('names the span each removed range came from, skipped spans and all', () => {
    const beat = beatOf('one two three four five six');
    // The first span removes nothing, so the caller cannot pair the ranges it
    // gets back with the spans it gave by position.
    const result = cutWordsFromBeat(beat, [
      { wordStart: 3, wordEnd: 3 },
      { wordStart: 4, wordEnd: 6 },
      { wordStart: 0, wordEnd: 1 },
    ]);
    expect(result.removed.map((removed) => [removed.span, removed.text])).toEqual([
      [1, 'five six'],
      [2, 'one'],
    ]);
    expect(result.beat?.words.map((word) => word.text)).toEqual(['two', 'three', 'four']);
  });
});
