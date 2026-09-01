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
 * Timed highlights become a range comment. Untimed ones (0–0) still return the
 * quote so the caller can pin the comment to the playhead.
 */
export function commentRangeFromHighlight(input: {
  quote: string;
  first: TranscriptRangeNode | null;
  last: TranscriptRangeNode | null;
}): TranscriptSelectionRange | null {
  const quote = input.quote.replace(/\s+/g, ' ').trim();
  if (!quote) return null;

  const span = rangeFromSelectionNodes(input.first, input.last);
  if (span) {
    return { start: span.start, end: span.end, quote };
  }

  if (input.first || input.last) {
    const node = input.first ?? input.last;
    return { start: node!.start, end: node!.end, quote };
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
