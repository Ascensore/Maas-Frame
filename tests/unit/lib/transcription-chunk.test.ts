import { describe, expect, it } from 'vitest';
import {
  mergeChunkTranscriptions,
  openaiChunkOffsets,
  shiftTranscriptCue,
  shouldSplitForOpenAI,
} from '@/lib/transcription/chunk';

describe('shouldSplitForOpenAI', () => {
  it('keeps 24 MiB in a single upload and splits one byte over', () => {
    expect(shouldSplitForOpenAI(25165824)).toBe(false);
    expect(shouldSplitForOpenAI(25165825)).toBe(true);
  });
});

describe('openaiChunkOffsets', () => {
  it('returns a single start for a clip shorter than one chunk', () => {
    expect(openaiChunkOffsets(90)).toEqual([0]);
  });

  it('returns a single start when duration is missing', () => {
    expect(openaiChunkOffsets(0)).toEqual([0]);
  });

  it('covers a two-hour file with overlapping 10-minute windows', () => {
    const offsets = openaiChunkOffsets(7200);
    expect(offsets).toEqual([
      0, 598.5, 1197, 1795.5, 2394, 2992.5, 3591, 4189.5, 4788, 5386.5, 5985, 6583.5, 7182,
    ]);
  });

  it('caps runaway durations at 200 chunks', () => {
    expect(openaiChunkOffsets(1_000_000)).toHaveLength(200);
  });
});

describe('shiftTranscriptCue', () => {
  it('adds the same offset to the cue and every word', () => {
    expect(
      shiftTranscriptCue(
        {
          start: 1,
          end: 2,
          text: 'hi',
          words: [{ start: 1, end: 1.5, text: 'hi' }],
        },
        10
      )
    ).toEqual({
      start: 11,
      end: 12,
      text: 'hi',
      words: [{ start: 11, end: 11.5, text: 'hi' }],
    });
  });
});

describe('mergeChunkTranscriptions', () => {
  it('drops overlap from later chunks and shifts remaining timestamps', () => {
    const merged = mergeChunkTranscriptions([
      {
        offsetSeconds: 0,
        overlapSeconds: 0,
        result: {
          language: 'und',
          segments: [
            {
              start: 0,
              end: 1,
              text: 'hello',
              words: [{ start: 0, end: 1, text: 'hello' }],
            },
          ],
        },
      },
      {
        offsetSeconds: 598.5,
        overlapSeconds: 1.5,
        result: {
          language: 'en',
          segments: [
            {
              start: 0.4,
              end: 1.2,
              text: 'overlap',
              words: [{ start: 0.4, end: 1.2, text: 'overlap' }],
            },
            {
              start: 1.2,
              end: 2.0,
              text: 'straddle',
              words: [{ start: 1.2, end: 2.0, text: 'straddle' }],
            },
            {
              start: 2,
              end: 3,
              text: 'kept',
              words: [{ start: 2, end: 2.5, text: 'kept' }],
            },
          ],
        },
      },
    ]);

    expect(merged.language).toBe('en');
    expect(merged.segments.map((segment) => segment.text)).toEqual(['hello', 'kept']);
    expect(merged.segments[0]).toEqual({
      start: 0,
      end: 1,
      text: 'hello',
      words: [{ start: 0, end: 1, text: 'hello' }],
    });
    expect(merged.segments[1]).toEqual({
      start: 600.5,
      end: 601.5,
      text: 'kept',
      words: [{ start: 600.5, end: 601, text: 'kept' }],
    });
  });

  it('prefers the first real language over und', () => {
    const merged = mergeChunkTranscriptions([
      {
        offsetSeconds: 0,
        overlapSeconds: 0,
        result: { language: 'und', segments: [] },
      },
      {
        offsetSeconds: 598.5,
        overlapSeconds: 1.5,
        result: { language: 'it', segments: [] },
      },
      {
        offsetSeconds: 1197,
        overlapSeconds: 1.5,
        result: { language: 'en', segments: [] },
      },
    ]);
    expect(merged.language).toBe('it');
  });
});
