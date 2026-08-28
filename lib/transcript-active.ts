export function isTranscriptRangeActive(time: number, start: number, end: number): boolean {
  return time >= start && time < end;
}

type HighlightTarget = {
  dataset: DOMStringMap | { start?: string; end?: string; active?: string };
};

/**
 * Toggle `data-active` on transcript ranges from a live time sample.
 * Returns how many nodes changed so callers can assert the write, not the loop.
 */
export function applyTranscriptHighlight(
  elements: Iterable<HighlightTarget>,
  time: number
): number {
  let writes = 0;
  for (const el of elements) {
    const start = Number(el.dataset.start);
    const end = Number(el.dataset.end);
    const next = isTranscriptRangeActive(time, start, end) ? 'true' : 'false';
    if (el.dataset.active !== next) {
      el.dataset.active = next;
      writes += 1;
    }
  }
  return writes;
}
