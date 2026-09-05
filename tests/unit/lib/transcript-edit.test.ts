import { describe, expect, it } from 'vitest';
import { parseSegmentPatch, retimeSegmentWords } from '@/lib/transcript-edit';

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

  it('spreads the words across the segment when the count changes', () => {
    expect(retimeSegmentWords(words, 'we help all founders', 1, 3)).toEqual([
      { start: 1, end: 1.5, text: 'we' },
      { start: 1.5, end: 2, text: 'help' },
      { start: 2, end: 2.5, text: 'all' },
      { start: 2.5, end: 3, text: 'founders' },
    ]);
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
    expect(parseSegmentPatch({ text: '  Hello  ' })).toEqual({
      ok: true,
      value: { text: 'Hello', speaker: undefined },
    });
    expect(parseSegmentPatch({ text: 'Hi', speaker: null })).toEqual({
      ok: true,
      value: { text: 'Hi', speaker: null },
    });
    expect(parseSegmentPatch({ text: '   ' }).ok).toBe(false);
    expect(parseSegmentPatch({ text: 'x'.repeat(2001) }).ok).toBe(false);
    expect(parseSegmentPatch({ text: 'Hi', speaker: 'x'.repeat(81) }).ok).toBe(false);
    expect(parseSegmentPatch({}).ok).toBe(false);
  });
});
