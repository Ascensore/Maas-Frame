import { describe, expect, it } from 'vitest';
import { applyTranscriptHighlight, isTranscriptRangeActive } from '@/lib/transcript-active';

function target(start: number, end: number, active = 'false') {
  return { dataset: { start: String(start), end: String(end), active } };
}

describe('isTranscriptRangeActive', () => {
  it('is active at the start and inactive at the end', () => {
    expect(isTranscriptRangeActive(1, 1, 2)).toBe(true);
    expect(isTranscriptRangeActive(2, 1, 2)).toBe(false);
  });
});

describe('applyTranscriptHighlight', () => {
  it('writes data-active on the word that contains the playhead', () => {
    const words = [target(0, 1), target(1, 2), target(2, 3)];
    expect(applyTranscriptHighlight(words, 1.5)).toBe(1);
    expect(words.map((word) => word.dataset.active)).toEqual(['false', 'true', 'false']);
  });

  it('does not write when the active word has not changed', () => {
    const words = [target(0, 1, 'false'), target(1, 2, 'true')];
    expect(applyTranscriptHighlight(words, 1.2)).toBe(0);
    expect(words[1]?.dataset.active).toBe('true');
  });

  it('clears the previous word when the playhead moves on', () => {
    const words = [target(0, 1, 'true'), target(1, 2, 'false')];
    expect(applyTranscriptHighlight(words, 1.2)).toBe(2);
    expect(words.map((word) => word.dataset.active)).toEqual(['false', 'true']);
  });
});
