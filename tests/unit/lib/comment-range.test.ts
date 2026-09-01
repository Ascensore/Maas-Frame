import { describe, expect, it } from 'vitest';
import {
  draftRangeSpan,
  markRangeIn,
  markRangeOut,
  resolveCommentTimestamp,
} from '@/lib/comment-range';

describe('markRangeIn', () => {
  it('sets In at the playhead and leaves Out empty', () => {
    expect(markRangeIn(12, { start: null, end: null })).toEqual({ start: 12, end: null });
  });

  it('keeps Out when the new In is still before it', () => {
    expect(markRangeIn(8, { start: 12, end: 30 })).toEqual({ start: 8, end: 30 });
  });

  it('drops Out when the new In is after it', () => {
    expect(markRangeIn(40, { start: 12, end: 30 })).toEqual({ start: 40, end: null });
  });

  it('keeps an Out-only mark when In is still before it', () => {
    expect(markRangeIn(12, { start: null, end: 30 })).toEqual({ start: 12, end: 30 });
  });

  it('drops an Out-only mark when In is after it', () => {
    expect(markRangeIn(40, { start: null, end: 30 })).toEqual({ start: 40, end: null });
  });
});

describe('markRangeOut', () => {
  it('sets Out without requiring In first', () => {
    expect(markRangeOut(30, { start: null, end: null })).toEqual({ start: null, end: 30 });
  });

  it('keeps In when Out is later', () => {
    expect(markRangeOut(30, { start: 12, end: null })).toEqual({ start: 12, end: 30 });
  });

  it('swaps when Out is marked before In', () => {
    expect(markRangeOut(8, { start: 12, end: null })).toEqual({ start: 8, end: 12 });
  });
});

describe('resolveCommentTimestamp', () => {
  it('uses the playhead when nothing is marked', () => {
    expect(resolveCommentTimestamp(null, null, 7)).toEqual({ timestamp: 7, timestampEnd: null });
  });

  it('stores a point comment when only In is marked', () => {
    expect(resolveCommentTimestamp(12, null, 7)).toEqual({ timestamp: 12, timestampEnd: null });
  });

  it('stores a point comment when only Out is marked', () => {
    expect(resolveCommentTimestamp(null, 30, 7)).toEqual({ timestamp: 30, timestampEnd: null });
  });

  it('orders a range low to high', () => {
    expect(resolveCommentTimestamp(30, 12, 7)).toEqual({ timestamp: 12, timestampEnd: 30 });
  });

  it('collapses a zero-length range to a point', () => {
    expect(resolveCommentTimestamp(12, 12, 7)).toEqual({ timestamp: 12, timestampEnd: null });
  });
});

describe('draftRangeSpan', () => {
  it('returns null when nothing is marked', () => {
    expect(draftRangeSpan({ start: null, end: null }, 10)).toBeNull();
  });

  it('stretches from In to the playhead while Out is empty', () => {
    expect(draftRangeSpan({ start: 12, end: null }, 20)).toEqual({ start: 12, end: 20 });
  });

  it('stretches from the playhead to Out while In is empty', () => {
    expect(draftRangeSpan({ start: null, end: 30 }, 10)).toEqual({ start: 10, end: 30 });
  });

  it('uses both marks when they are set', () => {
    expect(draftRangeSpan({ start: 30, end: 12 }, 40)).toEqual({ start: 12, end: 30 });
  });
});
