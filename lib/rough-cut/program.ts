import { secondsToFrames, type FrameRate } from '../timecode';
import type { SourceCut } from './beats';
import type { CutIsland, EditDecision } from './types';

/**
 * Program-level bookkeeping shared by both layouts: turning source cuts into
 * keyed islands, removing timeline ranges from a continuous multicam
 * program, and packing what remains back onto a tight timeline.
 */

const EPSILON = 1e-6;

export type TimeRange = { start: number; end: number };

/** Stable across regenerations: source version plus frame-rounded in and out. */
export function cutIslandKey(
  sourceVersionId: string,
  inSeconds: number,
  outSeconds: number,
  rate: FrameRate
): string {
  return `${sourceVersionId}:${secondsToFrames(inSeconds, rate)}-${secondsToFrames(outSeconds, rate)}`;
}

export function toCutIsland(cut: SourceCut, rate: FrameRate): CutIsland {
  return {
    key: cutIslandKey(cut.versionId, cut.start, cut.end, rate),
    sourceVersionId: cut.versionId,
    inSeconds: cut.start,
    outSeconds: cut.end,
    reason: { code: cut.code, summary: cut.summary },
    transcriptText: cut.text,
  };
}

/** Merge overlapping or touching ranges, sorted by start. */
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter((range) => range.end - range.start > EPSILON)
    .map((range) => ({ ...range }))
    .sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end + EPSILON) {
      last.end = Math.max(last.end, range.end);
    } else {
      out.push(range);
    }
  }
  return out;
}

/**
 * Remove timeline ranges from a continuous program. An edit that straddles a
 * range is split; source in/out follow the timeline because a multicam edit
 * is a straight offset from its clip.
 */
export function subtractTimelineRanges(edits: EditDecision[], ranges: TimeRange[]): EditDecision[] {
  const holes = mergeRanges(ranges);
  const out: EditDecision[] = [];
  for (const edit of edits) {
    let cursor = edit.timelineStartSeconds;
    const end = edit.timelineEndSeconds;
    const sourceOffset = edit.inSeconds - edit.timelineStartSeconds;
    for (const hole of holes) {
      if (hole.end <= cursor + EPSILON) continue;
      if (hole.start >= end - EPSILON) break;
      if (hole.start > cursor + EPSILON) {
        out.push({
          ...edit,
          timelineStartSeconds: cursor,
          timelineEndSeconds: hole.start,
          inSeconds: cursor + sourceOffset,
          outSeconds: hole.start + sourceOffset,
        });
      }
      cursor = Math.max(cursor, hole.end);
    }
    if (end > cursor + EPSILON) {
      out.push({
        ...edit,
        timelineStartSeconds: cursor,
        timelineEndSeconds: end,
        inSeconds: cursor + sourceOffset,
        outSeconds: end + sourceOffset,
      });
    }
  }
  return out;
}

/** Re-place edits back to back from zero, keeping order and durations. */
export function packTimeline(edits: EditDecision[]): EditDecision[] {
  let cursor = 0;
  return edits.map((edit) => {
    const duration = edit.timelineEndSeconds - edit.timelineStartSeconds;
    const packed = { ...edit, timelineStartSeconds: cursor, timelineEndSeconds: cursor + duration };
    cursor += duration;
    return packed;
  });
}
