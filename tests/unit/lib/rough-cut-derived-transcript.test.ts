import { describe, expect, it } from 'vitest';
import {
  DERIVED_SEGMENT_MAX_SECONDS,
  DERIVED_SEGMENT_MAX_WORDS,
  deriveProgramTranscript,
  persistDerivedTranscript,
  type DerivedTranscriptDeps,
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

  it('says a word straddling a reviewer cut once, on the side that keeps most of it', () => {
    // Ten tokens spread over 30s, so each spans 3s; the cut takes 4.0-4.8,
    // which is inside the second token and leaves 1s of it before the cut and
    // 1.2s after. Both sides clear the "a full second of it" rule.
    const many = Array.from({ length: 10 }, (_, index) => `t${index}`).join(' ');
    const transcripts = new Map([
      [
        'v1',
        {
          language: 'en',
          segments: [{ startSec: 0, endSec: 30, speaker: null, text: many, words: [] }],
        },
      ],
    ]);
    const result = deriveProgramTranscript([edit(0, 0, 4), edit(4, 4.8, 30)], transcripts);
    const spoken = result.segments.flatMap((segment) => segment.words.map((word) => word.text));
    expect(spoken).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']);
    // The larger share is after the cut, so t1 is spoken there.
    expect(result.segments[0]!.text).toBe('t0');
  });

  it('gives a word cut exactly down the middle to the earlier side', () => {
    // `bb` runs 2-6 and the cut takes 3.5-4.5, leaving 1.5s of it on each
    // side. Neither side is more than half the word, so both clear only the
    // "a full second of it" rule and the program order breaks the tie.
    const transcripts = new Map([
      [
        'v1',
        {
          language: 'en',
          segments: [
            {
              startSec: 0,
              endSec: 10,
              speaker: null,
              text: 'a bb c',
              words: [
                { start: 0, end: 2, text: 'a' },
                { start: 2, end: 6, text: 'bb' },
                { start: 6, end: 10, text: 'c' },
              ],
            },
          ],
        },
      ],
    ]);
    const result = deriveProgramTranscript([edit(0, 0, 3.5), edit(3.5, 4.5, 10)], transcripts);
    expect(result.segments.map((segment) => segment.text)).toEqual(['a bb', 'c']);
  });

  it('follows the program order across clips and skips a source with no language of its own', () => {
    const transcripts = new Map([
      ['a', { language: 'und', segments: [timed(0, 'from a')] }],
      ['b', { language: 'en', segments: [timed(0, 'from b')] }],
    ]);
    // `a` carries 6s of the program to `b`'s 2s, so it is asked first and
    // passed over for having no language.
    const result = deriveProgramTranscript([edit(0, 0, 2, 'b'), edit(2, 0, 6, 'a')], transcripts);
    expect(result.segments.map((segment) => segment.text)).toEqual(['from b', 'from a']);
    expect(result.segments.map((segment) => segment.startSec)).toEqual([0, 2]);
    expect(result.language).toBe('en');
    expect(deriveProgramTranscript([], new Map())).toEqual({ language: 'und', segments: [] });
  });

  it('takes the language of the source that carries most of the program, not the map order', () => {
    const transcripts = new Map([
      ['de-1', { language: 'de', segments: [timed(0, 'eins zwei')] }],
      ['en-1', { language: 'en', segments: [timed(0, 'one two three four')] }],
    ]);
    const result = deriveProgramTranscript(
      [edit(0, 0, 4, 'en-1'), edit(4, 0, 2, 'de-1')],
      transcripts
    );
    expect(result.language).toBe('en');
    // A tie goes to the source the program opens on.
    expect(
      deriveProgramTranscript([edit(0, 0, 2, 'de-1'), edit(2, 0, 2, 'en-1')], transcripts).language
    ).toBe('de');
  });
});

describe('persistDerivedTranscript', () => {
  /** A pool that answers the four statements this function and the caption writer issue. */
  function fakePool() {
    const uploads: Array<{ key: string; body: string }> = [];
    const query = async (sql: string) => {
      if (sql.includes('INSERT INTO transcripts')) return { rows: [{ id: 'transcript-1' }] };
      if (sql.includes('SELECT p."ownerId"')) return { rows: [{ owner_id: 'owner-1' }] };
      return { rows: [] };
    };
    const deps = {
      pool: {
        query,
        connect: async () => ({ query, release: () => {} }),
      },
      uploadObject: async (key: string, body: Buffer) => {
        uploads.push({ key, body: body.toString('utf8') });
      },
    } as unknown as DerivedTranscriptDeps;
    return { deps, uploads };
  }

  it('carries an untimed line into the transcript but never into the caption file', async () => {
    // What a burn-in of a partly-timed transcript hands over: one line the
    // provider timed and one pasted paragraph left at 0-0. The rows keep both,
    // because an untimed line is still text to read and search. A cue written
    // `00:00:00.000 --> 00:00:00.000` is one no player shows and some parsers
    // refuse outright, so the caption file keeps only the timed line.
    const { deps, uploads } = fakePool();

    await persistDerivedTranscript(deps, {
      versionId: 'version-1',
      language: 'en',
      provider: 'burn-in',
      segments: [
        {
          startSec: 1,
          endSec: 3,
          speaker: null,
          text: 'one two',
          words: [
            { start: 1, end: 2, text: 'one' },
            { start: 2, end: 3, text: 'two' },
          ],
        },
        { startSec: 0, endSec: 0, speaker: null, text: 'A pasted paragraph.', words: [] },
      ],
    });

    const vtt = uploads.find((upload) => upload.key.startsWith('subtitles/'));
    expect(vtt?.body).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\none two\n');
  });

  it('writes no caption track at all when nothing in the transcript is timed', async () => {
    // A header with no cues is worse than no track: the player lists it, offers
    // it in the subtitle menu, and then shows nothing for the whole video.
    const { deps, uploads } = fakePool();

    await persistDerivedTranscript(deps, {
      versionId: 'version-1',
      language: 'en',
      provider: 'burn-in',
      segments: [
        { startSec: 0, endSec: 0, speaker: null, text: 'A pasted paragraph.', words: [] },
        { startSec: 0, endSec: 0, speaker: null, text: 'And the one after it.', words: [] },
      ],
    });

    expect(uploads.filter((upload) => upload.key.startsWith('subtitles/'))).toEqual([]);
  });
});
