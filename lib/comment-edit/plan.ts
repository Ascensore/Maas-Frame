import { z } from 'zod';
import { editPlanSchema } from '@/lib/agents/edit-plan';
import { roughCutDecisionListSchema } from '@/lib/rough-cut/decision-list';
import type { RoughCutDecisionList } from '@/lib/rough-cut/types';

export const commentEditSnapshotSchema = z.object({
  versionId: z.string(),
  content: z.string().min(1),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  decisions: roughCutDecisionListSchema,
});
export type CommentEditSnapshot = z.infer<typeof commentEditSnapshotSchema>;
type Range = { start: number; end: number };

function mergeRanges(ranges: Range[]): Range[] {
  const result: Range[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = result[result.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

/** All operations refer to the immutable reviewed timeline, never a partly edited one. */
export function applyCommentEditPlan(
  snapshot: CommentEditSnapshot,
  value: unknown
): { decisions: RoughCutDecisionList; removedSeconds: number } {
  const plan = editPlanSchema.parse(value);
  const { decisions, start, end } = snapshot;
  const fps = decisions.rate.num / decisions.rate.den;
  const frame = (seconds: number) => Math.round(seconds * fps) / fps;
  const duration = decisions.edits.at(-1)?.timelineEndSeconds ?? 0;
  if (!(fps > 0) || end <= start || end > duration || plan.operations.length === 0) {
    throw new Error(
      'No executable cut was found. Adjust the marked range or hand this to an editor.'
    );
  }
  const kinds = new Set(plan.operations.map((op) => op.op));
  if (kinds.size !== 1) throw new Error('A plan cannot mix cut and keep operations.');
  const ranges = mergeRanges(
    plan.operations.map((op) => {
      if (op.start < start || op.end > end || op.end <= op.start) {
        throw new Error('The AI plan goes outside this comment’s marked range.');
      }
      const range = { start: frame(op.start), end: frame(op.end) };
      if (range.start < start - 1e-6 || range.end > end + 1e-6 || range.end <= range.start) {
        throw new Error('The cut must fit inside the marked range on whole frames.');
      }
      return range;
    })
  );
  let cuts = ranges;
  if (kinds.has('keep')) {
    cuts = [];
    let cursor = start;
    for (const range of ranges) {
      if (range.start > cursor) cuts.push({ start: cursor, end: range.start });
      cursor = range.end;
    }
    if (cursor < end) cuts.push({ start: cursor, end });
  }
  const edits: RoughCutDecisionList['edits'] = [];
  const removed = [...(decisions.cuts ?? [])];
  const mapping: Array<Range & { output: number }> = [];
  let output = 0;
  for (const edit of decisions.edits) {
    let cursor = edit.timelineStartSeconds;
    const append = (from: number, to: number) => {
      if (to <= from + 1e-6) return;
      mapping.push({ start: from, end: to, output });
      edits.push({
        ...edit,
        inSeconds: edit.inSeconds + from - edit.timelineStartSeconds,
        outSeconds: edit.inSeconds + to - edit.timelineStartSeconds,
        timelineStartSeconds: output,
        timelineEndSeconds: output + to - from,
      });
      output += to - from;
    };
    for (const cut of cuts) {
      const from = Math.max(cut.start, edit.timelineStartSeconds);
      const to = Math.min(cut.end, edit.timelineEndSeconds);
      if (to <= from) continue;
      append(cursor, from);
      const inSeconds = edit.inSeconds + from - edit.timelineStartSeconds;
      const outSeconds = edit.inSeconds + to - edit.timelineStartSeconds;
      removed.push({
        key: `feedback:${edit.sourceVersionId}:${from}:${to}`,
        sourceVersionId: edit.sourceVersionId,
        inSeconds,
        outSeconds,
        reason: { code: 'REVIEWER', summary: snapshot.content },
        transcriptText: null,
      });
      cursor = to;
    }
    append(cursor, edit.timelineEndSeconds);
  }
  const removedSeconds = duration - output;
  if (removedSeconds < 1 / fps - 1e-6)
    throw new Error('The AI plan makes no change. Hand this to an editor or clarify the feedback.');
  if (edits.length === 0) throw new Error('The edit would remove the entire video.');
  const markers = (decisions.markers ?? []).flatMap((marker) => {
    const segment = mapping.find(
      (part) => marker.timelineSeconds >= part.start && marker.timelineSeconds < part.end
    );
    return segment
      ? [
          {
            ...marker,
            timelineSeconds: segment.output + marker.timelineSeconds - segment.start,
            durationSeconds:
              marker.durationSeconds === null
                ? null
                : Math.min(marker.durationSeconds, segment.end - marker.timelineSeconds),
          },
        ]
      : [];
  });
  return { decisions: { ...decisions, edits, cuts: removed, markers }, removedSeconds };
}
