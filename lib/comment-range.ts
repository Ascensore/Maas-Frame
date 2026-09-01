export type CommentRange = {
  start: number | null;
  end: number | null;
};

/** Set In at the playhead. A later Out is kept only when it is still after In. */
export function markRangeIn(currentTime: number, range: CommentRange): CommentRange {
  if (range.end !== null && currentTime > range.end) {
    return { start: currentTime, end: null };
  }
  return { start: currentTime, end: range.end };
}

/**
 * Set Out at the playhead. If In is still empty, Out stands alone until In is
 * marked (submit treats a single end as a point comment).
 */
export function markRangeOut(currentTime: number, range: CommentRange): CommentRange {
  if (range.start !== null && currentTime < range.start) {
    return { start: currentTime, end: range.start };
  }
  return { start: range.start, end: currentTime };
}

export function resolveCommentTimestamp(
  start: number | null,
  end: number | null,
  fallback: number
): { timestamp: number; timestampEnd: number | null } {
  if (start !== null && end !== null) {
    const timestamp = Math.min(start, end);
    const timestampEnd = Math.max(start, end);
    if (timestampEnd > timestamp) return { timestamp, timestampEnd };
    return { timestamp, timestampEnd: null };
  }
  if (start !== null) return { timestamp: start, timestampEnd: null };
  if (end !== null) return { timestamp: end, timestampEnd: null };
  return { timestamp: fallback, timestampEnd: null };
}

/** Inclusive span drawn on the timeline while a range is being marked. */
export function draftRangeSpan(
  range: CommentRange,
  playhead: number
): { start: number; end: number } | null {
  if (range.start === null && range.end === null) return null;
  const start = range.start ?? playhead;
  const end = range.end ?? playhead;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}
