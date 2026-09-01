import { describe, expect, it } from 'vitest';
import { commentRangeFromSpans, isPointClick } from '@/lib/transcript-selection';

const WORDS = [
  { start: 1, end: 1.2, text: 'Cut' },
  { start: 1.2, end: 1.5, text: 'the' },
  { start: 1.5, end: 2.1, text: 'wide' },
];

describe('commentRangeFromSpans', () => {
  it('returns null for an empty list', () => {
    expect(commentRangeFromSpans([], 0, 1)).toBeNull();
  });

  it('uses the first and last timed word in the slice', () => {
    expect(commentRangeFromSpans(WORDS, 0, 1)).toEqual({
      start: 1,
      end: 1.5,
      quote: 'Cut the',
    });
  });

  it('orders a backwards drag', () => {
    expect(commentRangeFromSpans(WORDS, 2, 0)).toEqual({
      start: 1,
      end: 2.1,
      quote: 'Cut the wide',
    });
  });

  it('clamps indexes that sit outside the list', () => {
    expect(commentRangeFromSpans(WORDS, 5, 5)).toEqual({
      start: 1.5,
      end: 2.1,
      quote: 'wide',
    });
    expect(commentRangeFromSpans(WORDS, -1, 0)).toEqual({
      start: 1,
      end: 1.2,
      quote: 'Cut',
    });
  });

  it('keeps a one-word slice as a point span', () => {
    expect(commentRangeFromSpans(WORDS, 1, 1)).toEqual({
      start: 1.2,
      end: 1.5,
      quote: 'the',
    });
  });
});

describe('isPointClick', () => {
  it('treats a short span as a click, not a range', () => {
    expect(isPointClick({ start: 1.2, end: 1.24, quote: 'the' })).toBe(true);
    expect(isPointClick({ start: 1, end: 2.1, quote: 'Cut the wide' })).toBe(false);
  });
});
