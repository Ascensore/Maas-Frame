export type TimedSpan = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptCommentRange = {
  start: number;
  end: number;
  quote: string;
};

/**
 * Build a comment range from a contiguous slice of timed words or lines.
 * A single span is a seek target, not a range: callers treat equal start/end
 * as a point click.
 */
export function commentRangeFromSpans(
  spans: TimedSpan[],
  fromIndex: number,
  toIndex: number
): TranscriptCommentRange | null {
  if (spans.length === 0) return null;
  const last = spans.length - 1;
  const from = Math.min(Math.max(0, fromIndex), last);
  const to = Math.min(Math.max(0, toIndex), last);
  const startIndex = Math.min(from, to);
  const endIndex = Math.max(from, to);
  const slice = spans.slice(startIndex, endIndex + 1);
  const first = slice[0];
  const lastSpan = slice[slice.length - 1];
  if (!first || !lastSpan) return null;
  return {
    start: first.start,
    end: lastSpan.end,
    quote: slice
      .map((span) => span.text)
      .join(' ')
      .trim(),
  };
}

export function isPointClick(range: TranscriptCommentRange, threshold = 0.05): boolean {
  return range.end - range.start <= threshold;
}
