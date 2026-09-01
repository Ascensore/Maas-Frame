import { describe, expect, it } from 'vitest';
import {
  commentOverlapsSegment,
  commentRangeFromHighlight,
  commentsForSegment,
  rangeFromSelectionNodes,
} from '@/lib/transcript-comment';

describe('rangeFromSelectionNodes', () => {
  it('uses the first word start and the last word end', () => {
    expect(rangeFromSelectionNodes({ start: 1.2, end: 1.5 }, { start: 2.0, end: 2.4 })).toEqual({
      start: 1.2,
      end: 2.4,
    });
  });

  it('survives a backwards drag', () => {
    expect(rangeFromSelectionNodes({ start: 2.0, end: 2.4 }, { start: 1.2, end: 1.5 })).toEqual({
      start: 1.2,
      end: 2.4,
    });
  });

  it('returns null when the span has no duration', () => {
    expect(rangeFromSelectionNodes({ start: 0, end: 0 }, { start: 0, end: 0 })).toBeNull();
    expect(rangeFromSelectionNodes(null, { start: 1, end: 2 })).toBeNull();
  });
});

describe('commentRangeFromHighlight', () => {
  it('reads start and end from the first and last range nodes', () => {
    expect(
      commentRangeFromHighlight({
        quote: '  Hello   world ',
        first: { start: 1, end: 1.4 },
        last: { start: 2, end: 2.5 },
      })
    ).toEqual({ start: 1, end: 2.5, quote: 'Hello world' });
  });

  it('keeps a single zero-width node instead of collapsing it to 0', () => {
    expect(
      commentRangeFromHighlight({
        quote: 'Hello',
        first: { start: 5, end: 5 },
        last: null,
      })
    ).toEqual({ start: 5, end: 5, quote: 'Hello' });
  });

  it('drops a highlight that is only whitespace', () => {
    expect(
      commentRangeFromHighlight({
        quote: '   ',
        first: { start: 1, end: 2 },
        last: { start: 1, end: 2 },
      })
    ).toBeNull();
  });
});

describe('commentOverlapsSegment', () => {
  const segment = { startSec: 10, endSec: 20 };

  it('places a point comment inside the half-open segment', () => {
    expect(commentOverlapsSegment({ timestamp: 10 }, segment)).toBe(true);
    expect(commentOverlapsSegment({ timestamp: 10, timestampEnd: 10 }, segment)).toBe(true);
    expect(commentOverlapsSegment({ timestamp: 19.9 }, segment)).toBe(true);
    expect(commentOverlapsSegment({ timestamp: 20 }, segment)).toBe(false);
    expect(commentOverlapsSegment({ timestamp: 20, timestampEnd: 20 }, segment)).toBe(false);
    expect(commentOverlapsSegment({ timestamp: 9.9 }, segment)).toBe(false);
  });

  it('places a range comment that overlaps the segment', () => {
    expect(commentOverlapsSegment({ timestamp: 8, timestampEnd: 11 }, segment)).toBe(true);
    expect(commentOverlapsSegment({ timestamp: 19, timestampEnd: 22 }, segment)).toBe(true);
    expect(commentOverlapsSegment({ timestamp: 4, timestampEnd: 9 }, segment)).toBe(false);
    expect(commentOverlapsSegment({ timestamp: 20, timestampEnd: 25 }, segment)).toBe(false);
    expect(commentOverlapsSegment({ timestamp: 5, timestampEnd: 10 }, segment)).toBe(false);
  });

  it('never marks an untimed line', () => {
    expect(commentOverlapsSegment({ timestamp: 0 }, { startSec: 0, endSec: 0 })).toBe(false);
  });
});

describe('commentsForSegment', () => {
  it('keeps only the comments that overlap the line', () => {
    const comments = [
      { id: 'a', timestamp: 5, timestampEnd: null },
      { id: 'b', timestamp: 12, timestampEnd: 14 },
      { id: 'c', timestamp: 30, timestampEnd: null },
    ];
    expect(commentsForSegment(comments, { startSec: 10, endSec: 20 }).map((row) => row.id)).toEqual(
      ['b']
    );
  });
});
