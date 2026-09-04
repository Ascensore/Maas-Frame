/**
 * Helpers for commenting off a transcript: turning a highlight into a time
 * range, and placing existing comments on the lines they overlap.
 */

export type TranscriptRangeNode = {
  start: number;
  end: number;
};

export type TranscriptSelectionRange = {
  start: number;
  end: number;
  quote: string;
};

/**
 * First and last word (or line) nodes from a highlight. Returns null when the
 * span has no duration — an untimed script line, or a collapsed click.
 */
export function rangeFromSelectionNodes(
  first: TranscriptRangeNode | null,
  last: TranscriptRangeNode | null
): { start: number; end: number } | null {
  if (!first || !last) return null;
  const start = Math.min(first.start, last.start);
  const end = Math.max(first.end, last.end);
  if (!(end > start)) return null;
  return { start, end };
}

/**
 * Join timed word (or line) nodes that sit inside a highlight. Word buttons in
 * the transcript have no whitespace between them, so `Selection.toString()`
 * concatenates "firsttime" — this rebuilds the quote from the timed spans.
 */
export function quoteFromTimedSpans(
  spans: Array<{ start: number; end: number; text: string }>,
  rangeStart: number,
  rangeEnd: number
): string {
  const start = Math.min(rangeStart, rangeEnd);
  const end = Math.max(rangeStart, rangeEnd);
  const isPoint = !(end > start);
  return spans
    .filter((span) => {
      if (!span.text.trim()) return false;
      if (isPoint) return start >= span.start && start < span.end;
      return start < span.end && end > span.start;
    })
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((span) => span.text.replace(/\s+/g, ' ').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Timed highlights become a range comment. Untimed ones (0–0) still return the
 * quote so the caller can pin the comment to the playhead.
 */
export function commentRangeFromHighlight(input: {
  quote: string;
  first: TranscriptRangeNode | null;
  last: TranscriptRangeNode | null;
  spans?: Array<{ start: number; end: number; text: string }>;
}): TranscriptSelectionRange | null {
  const span = rangeFromSelectionNodes(input.first, input.last);
  const node = input.first ?? input.last;
  const rangeStart = span?.start ?? node?.start ?? 0;
  const rangeEnd = span?.end ?? node?.end ?? 0;
  const fromSpans = input.spans?.length
    ? quoteFromTimedSpans(input.spans, rangeStart, rangeEnd)
    : '';
  const quote = (fromSpans || input.quote).replace(/\s+/g, ' ').trim();
  if (!quote) return null;

  if (span) {
    return { start: span.start, end: span.end, quote };
  }

  if (node) {
    return { start: node.start, end: node.end, quote };
  }

  return { start: 0, end: 0, quote };
}

export function commentOverlapsSegment(
  comment: { timestamp: number; timestampEnd?: number | null },
  segment: { startSec: number; endSec: number }
): boolean {
  if (!(segment.endSec > segment.startSec)) return false;

  const commentStart = comment.timestamp;
  const commentEnd = comment.timestampEnd;
  if (commentEnd == null || commentEnd === commentStart) {
    return commentStart >= segment.startSec && commentStart < segment.endSec;
  }

  const start = Math.min(commentStart, commentEnd);
  const end = Math.max(commentStart, commentEnd);
  return start < segment.endSec && end > segment.startSec;
}

export function commentsForSegment<T extends { timestamp: number; timestampEnd?: number | null }>(
  comments: T[],
  segment: { startSec: number; endSec: number }
): T[] {
  return comments.filter((comment) => commentOverlapsSegment(comment, segment));
}

/**
 * The chip belongs on the earliest overlapping line, not on every line the
 * In/Out range covers. Highlighting still uses `commentOverlapsSegment`.
 */
export function isCommentAnchorSegment(
  comment: { timestamp: number; timestampEnd?: number | null },
  segments: Array<{ startSec: number; endSec: number }>,
  segmentIndex: number
): boolean {
  const segment = segments[segmentIndex];
  if (!segment || !commentOverlapsSegment(comment, segment)) return false;
  for (let i = 0; i < segmentIndex; i++) {
    const earlier = segments[i];
    if (earlier && commentOverlapsSegment(comment, earlier)) return false;
  }
  return true;
}

export function commentsAnchoredToSegment<
  T extends { timestamp: number; timestampEnd?: number | null },
>(comments: T[], segments: Array<{ startSec: number; endSec: number }>, segmentIndex: number): T[] {
  return comments.filter((comment) => isCommentAnchorSegment(comment, segments, segmentIndex));
}

export function spanOverlapsComment(
  span: { start: number; end: number },
  comment: { timestamp: number; timestampEnd?: number | null }
): boolean {
  return commentOverlapsSegment(comment, { startSec: span.start, endSec: span.end });
}
