import { describe, expect, it } from 'vitest';
import {
  DERIVED_SEGMENT_MAX_SECONDS,
  DERIVED_SEGMENT_MAX_WORDS,
  deriveProgramTranscript,
} from '@/lib/rough-cut/derived-transcript';
import type { TranscriptSegmentRow } from '@/lib/rough-cut/transcript-source';
import type { EditDecision } from '@/lib/rough-cut/types';

/** One word per second, each 0.8s long, so the seconds limit bites before the word limit. */
function timed(at: number, text: string, speaker: string | null = null): TranscriptSegmentRow {
  return spaced(at, text, speaker, 1, 0.8);
}

/** Words 0.3s apart, so 18 of them fit inside the seconds limit and the word limit bites first. */
function tight(at: number, text: string, speaker: string | null = null): TranscriptSegmentRow {
  return spaced(at, text, speaker, 0.3, 0.25);
}

function spaced(
  at: number,
  text: string,
  speaker: string | null,
  everySeconds: number,
  wordSeconds: number
): TranscriptSegmentRow {
  const words = text.split(' ').map((word, index) => ({
    start: at + index * everySeconds,
    end: at + index * everySeconds + wordSeconds,
    text: word,
  }));
  return {
    startSec: words[0]!.start,
    endSec: words[words.length - 1]!.end,
    speaker,
    text,
    words,
  };
}

function edit(
  timelineStart: number,
  inSeconds: number,
  outSeconds: number,
  sourceVersionId = 'v1'
): EditDecision {
  return {
    timelineStartSeconds: timelineStart,
    timelineEndSeconds: timelineStart + (outSeconds - inSeconds),
    inSeconds,
    outSeconds,
    sourceVersionId,
    cameraRole: 'A',
    targetTrack: 1,
  };
}

describe('deriveProgramTranscript', () => {
  it('keeps the words inside each edit, shifts them onto the timeline and splits at edit boundaries', () => {
    const transcripts = new Map([
      ['v1', { language: 'en', segments: [timed(0, 'one two three four five six')] }],
    ]);
    const result = deriveProgramTranscript([edit(0, 0, 2), edit(2, 4, 6)], transcripts);
    expect(result.language).toBe('en');
    // `three` (2–2.8) touches [0,2) for 0s and `four` (3–3.8) is outside [4,6);
    // `five` and `six` shift onto the timeline by −2.
    expect(result.segments.map((segment) => segment.text)).toEqual(['one two', 'five six']);
    expect(result.segments[1]).toMatchObject({ startSec: 2, endSec: 3.8, speaker: null });
    expect(result.segments[1]!.words).toEqual([
      { start: 2, end: 2.8, text: 'five' },
      { start: 3, end: 3.8, text: 'six' },
    ]);
  });

  it('spreads an untimed segment over its range and keeps a word that mostly overlaps the edit', () => {
    const transcripts = new Map([
      [
        'v1',
        {
          language: 'it',
          segments: [
            { startSec: 0, endSec: 4, speaker: 'A', text: 'ciao a tutti quanti', words: [] },
          ],
        },
      ],
    ]);
    const result = deriveProgramTranscript([edit(0, 0.5, 4)], transcripts);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      text: 'ciao a tutti quanti',
      speaker: 'A',
      startSec: 0,
      endSec: 3.5,
    });
    // `ciao` spreads over 0–1 and only half of it is inside the edit, which is enough.
    expect(result.segments[0]!.words[0]).toEqual({ start: 0, end: 0.5, text: 'ciao' });
  });

  it('keeps a long word the edit only clips a second out of', () => {
    const transcripts = new Map([
      [
        'v1',
        {
          language: 'en',
          segments: [
            {
              startSec: 0,
              endSec: 4,
              speaker: null,
              text: 'aaaaah',
              words: [{ start: 0, end: 4, text: 'aaaaah' }],
            },
          ],
        },
      ],
    ]);
    const result = deriveProgramTranscript([edit(0, 0, 1.5)], transcripts);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]!.words).toEqual([{ start: 0, end: 1.5, text: 'aaaaah' }]);
  });

  it('starts a new segment at a source segment boundary and when a segment grows too many words', () => {
    const many = Array.from(
      { length: DERIVED_SEGMENT_MAX_WORDS + 2 },
      (_, index) => `w${index}`
    ).join(' ');
    const transcripts = new Map([
      [
        'v1',
        {
          language: 'en',
          segments: [timed(0, 'first line', 'A'), timed(2, 'second line', 'B'), tight(10, many)],
        },
      ],
    ]);
    const result = deriveProgramTranscript([edit(0, 0, 40)], transcripts);
    expect(result.segments.map((segment) => [segment.text, segment.speaker]).slice(0, 2)).toEqual([
      ['first line', 'A'],
      ['second line', 'B'],
    ]);
    // 0.3s apart, so 20 words span 5.95s: only the word limit can split them.
    expect(result.segments.slice(2).map((segment) => segment.words.length)).toEqual([
      DERIVED_SEGMENT_MAX_WORDS,
      2,
    ]);
  });

  it('starts a new segment when one would run past the caption limit in seconds', () => {
    const many = Array.from({ length: 12 }, (_, index) => `w${index}`).join(' ');
    const transcripts = new Map([['v1', { language: 'en', segments: [timed(0, many)] }]]);
    const result = deriveProgramTranscript([edit(0, 0, 20)], transcripts);
    // A word a second: the ninth would end 8.8s after the segment opened.
    expect(result.segments.map((segment) => segment.words.length)).toEqual([8, 4]);
    expect(result.segments[0]!.endSec - result.segments[0]!.startSec).toBeLessThanOrEqual(
      DERIVED_SEGMENT_MAX_SECONDS
    );
  });

  it('follows the program order across clips and reads the language off the first transcript that has one', () => {
    const transcripts = new Map([
      ['a', { language: 'und', segments: [timed(0, 'from a')] }],
      ['b', { language: 'en', segments: [timed(0, 'from b')] }],
    ]);
    const result = deriveProgramTranscript([edit(0, 0, 2, 'b'), edit(2, 0, 2, 'a')], transcripts);
    expect(result.segments.map((segment) => segment.text)).toEqual(['from b', 'from a']);
    expect(result.segments.map((segment) => segment.startSec)).toEqual([0, 2]);
    expect(result.language).toBe('en');
    expect(deriveProgramTranscript([], new Map())).toEqual({ language: 'und', segments: [] });
  });
});
