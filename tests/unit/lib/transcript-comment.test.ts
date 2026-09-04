import { describe, expect, it } from 'vitest';
import {
  commentOverlapsSegment,
  commentRangeFromHighlight,
  commentsAnchoredToSegment,
  commentsForSegment,
  isCommentAnchorSegment,
  quoteFromTimedSpans,
  rangeFromSelectionNodes,
  spanOverlapsComment,
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

  it('rebuilds the quote from timed spans when Selection has no spaces', () => {
    expect(
      commentRangeFromHighlight({
        quote: "firsttime,there'saplatform",
        first: { start: 4, end: 4.4 },
        last: { start: 7.2, end: 7.6 },
        spans: [
          { start: 4, end: 4.4, text: 'first' },
          { start: 4.4, end: 4.8, text: 'time,' },
          { start: 6.8, end: 7.2, text: "there's" },
          { start: 7.2, end: 7.6, text: 'a' },
          { start: 7.5, end: 8.1, text: 'platform' },
        ],
      })
    ).toEqual({
      start: 4,
      end: 7.6,
      quote: "first time, there's a platform",
    });
  });
});

describe('quoteFromTimedSpans', () => {
  const words = [
    { start: 1, end: 1.2, text: 'Cut' },
    { start: 1.2, end: 1.5, text: 'the' },
    { start: 1.5, end: 2.1, text: 'wide' },
  ];

  it('joins overlapping words with spaces in time order', () => {
    expect(quoteFromTimedSpans([words[2]!, words[0]!, words[1]!], 1, 2.1)).toBe('Cut the wide');
  });

  it('keeps a word that only partly overlaps In/Out', () => {
    expect(quoteFromTimedSpans(words, 1.3, 1.6)).toBe('the wide');
  });

  it('picks the word that contains a point time', () => {
    expect(quoteFromTimedSpans(words, 1.2, 1.2)).toBe('the');
    expect(quoteFromTimedSpans(words, 1.5, 1.5)).toBe('wide');
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

describe('isCommentAnchorSegment', () => {
  const lines = [
    { startSec: 4, endSec: 7 },
    { startSec: 7, endSec: 8 },
    { startSec: 8, endSec: 10 },
    { startSec: 12, endSec: 16 },
  ];
  const range = { timestamp: 4.2, timestampEnd: 9.5 };

  it('anchors a spanning comment on the first overlapping line only', () => {
    expect(isCommentAnchorSegment(range, lines, 0)).toBe(true);
    expect(isCommentAnchorSegment(range, lines, 1)).toBe(false);
    expect(isCommentAnchorSegment(range, lines, 2)).toBe(false);
    expect(isCommentAnchorSegment(range, lines, 3)).toBe(false);
  });

  it('anchors on the first overlapping line when In sits in a gap before it', () => {
    const lateStart = { timestamp: 10.5, timestampEnd: 14 };
    expect(isCommentAnchorSegment(lateStart, lines, 3)).toBe(true);
    expect(isCommentAnchorSegment(lateStart, lines, 2)).toBe(false);
  });
});

describe('commentsAnchoredToSegment', () => {
  const lines = [
    { startSec: 0, endSec: 5 },
    { startSec: 5, endSec: 10 },
    { startSec: 10, endSec: 15 },
  ];

  it('shows a range comment once, on the line that first overlaps it', () => {
    const comments = [
      { id: 'range', timestamp: 3, timestampEnd: 12 },
      { id: 'point', timestamp: 11, timestampEnd: null },
    ];
    expect(commentsAnchoredToSegment(comments, lines, 0).map((row) => row.id)).toEqual(['range']);
    expect(commentsAnchoredToSegment(comments, lines, 1).map((row) => row.id)).toEqual([]);
    expect(commentsAnchoredToSegment(comments, lines, 2).map((row) => row.id)).toEqual(['point']);
  });
});

describe('spanOverlapsComment', () => {
  const range = { timestamp: 4.2, timestampEnd: 8.1 };

  it('keeps words that overlap In/Out and drops words that only touch the bounds', () => {
    expect(spanOverlapsComment({ start: 4.0, end: 4.4 }, range)).toBe(true);
    expect(spanOverlapsComment({ start: 7.8, end: 8.2 }, range)).toBe(true);
    expect(spanOverlapsComment({ start: 8.1, end: 8.4 }, range)).toBe(false);
    expect(spanOverlapsComment({ start: 3.5, end: 4.0 }, range)).toBe(false);
  });
});
