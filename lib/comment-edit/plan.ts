import { z } from 'zod';
import { editPlanSchema } from '@/lib/agents/edit-plan';
import { roughCutDecisionListSchema } from '@/lib/rough-cut/decision-list';
import type { RoughCutDecisionList } from '@/lib/rough-cut/types';
import { graphicPresetSchema, remapEffects, type TimelineEffect } from '@/lib/rough-cut/effects';

export const editOptionsSchema = z.object({
  assetVersionId: z.string().min(1).max(128).optional(),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type EditOptions = z.infer<typeof editOptionsSchema>;

export const commentEditSnapshotSchema = z.object({
  versionId: z.string(),
  content: z.string().min(1),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  decisions: roughCutDecisionListSchema,
  presets: z.array(graphicPresetSchema).default([]),
  assets: z
    .array(
      z.object({
        versionId: z.string(),
        title: z.string(),
        duration: z.number().finite().positive(),
        description: z.string().optional(),
        clip: roughCutDecisionListSchema.shape.clips.element,
      })
    )
    .max(100)
    .default([]),
});
export type CommentEditSnapshot = z.input<typeof commentEditSnapshotSchema>;
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
  const temporal = plan.operations.filter((op) => op.op === 'cut' || op.op === 'keep');
  const kinds = new Set(temporal.map((op) => op.op));
  if (kinds.size > 1) throw new Error('A plan cannot mix cut and keep operations.');
  for (const op of plan.operations) {
    if (
      op.start < start ||
      op.end > end ||
      op.end <= op.start ||
      frame(op.end) <= frame(op.start) ||
      frame(op.start) < start - 1e-6 ||
      frame(op.end) > end + 1e-6
    )
      throw new Error(
        'The AI plan goes outside this comment’s marked range or does not fit on whole frames.'
      );
  }
  const ranges = mergeRanges(
    temporal.map((op) => {
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
  const effects: TimelineEffect[] = [];
  const clips = [...decisions.clips];
  for (const op of plan.operations) {
    if (op.op === 'graphic') {
      const preset = snapshot.presets?.find((p) => p.id === op.presetId);
      if (!preset) throw new Error('The graphic preset is not available in this request.');
      if (op.end - op.start > 30) throw new Error('Graphics can last at most 30 seconds.');
      effects.push({
        kind: 'graphic',
        start: frame(op.start),
        end: frame(op.end),
        preset: { ...preset },
        title: op.title,
        subtitle: op.subtitle,
      });
    } else if (op.op === 'broll') {
      const asset = snapshot.assets?.find((a) => a.versionId === op.assetVersionId);
      if (!asset) throw new Error('Choose an available B-roll asset from this project.');
      const sourceIn = frame(op.sourceIn);
      if (sourceIn + frame(op.end) - frame(op.start) > asset.duration + 1e-6)
        throw new Error('The B-roll range exceeds the source duration.');
      effects.push({
        kind: 'broll',
        start: frame(op.start),
        end: frame(op.end),
        sourceVersionId: asset.versionId,
        sourceIn,
        preset: 'cover-muted-v1',
      });
      if (!clips.some((c) => c.versionId === asset.versionId)) clips.push(asset.clip);
    }
  }
  // A shared visual lane makes ambiguous competing B-roll/graphic instructions explicit.
  for (let i = 0; i < effects.length; i++)
    for (let j = i + 1; j < effects.length; j++) {
      if (
        effects[i].kind === effects[j].kind &&
        effects[i].start < effects[j].end &&
        effects[j].start < effects[i].end
      )
        throw new Error(
          'Two effects compete for the same visual layer. Split the feedback into separate ranges.'
        );
    }
  const addedEffects = remapEffects(effects, mapping);
  if (removedSeconds < 1 / fps - 1e-6 && addedEffects.length === 0)
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
  const outputEffects = [...remapEffects(decisions.effects ?? [], mapping), ...addedEffects];
  return {
    decisions: {
      ...decisions,
      edits,
      clips,
      cuts: removed,
      markers,
      ...(outputEffects.length || decisions.effects ? { effects: outputEffects } : {}),
    },
    removedSeconds,
  };
}

export function validateBatchSnapshots(snapshots: CommentEditSnapshot[]): void {
  if (snapshots.length < 2 || snapshots.length > 20)
    throw new Error('Choose between 2 and 20 queued comments.');
  const first = snapshots[0];
  const ordered = [...snapshots].sort((a, b) => a.start - b.start);
  snapshots.forEach((snapshot) => {
    if (
      snapshot.versionId !== first.versionId ||
      JSON.stringify(snapshot.decisions) !== JSON.stringify(first.decisions)
    )
      throw new Error(
        'Batch comments must review the same source map. Queue them again on the same version.'
      );
    if (JSON.stringify(snapshot.presets) !== JSON.stringify(first.presets))
      throw new Error('Batch comments must use the same graphic colors.');
  });
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start < ordered[i - 1].end - 1e-6)
      throw new Error(
        'These comment ranges overlap. Run them separately or narrow the ranges before batching.'
      );
  }
}

/** Validate each request in isolation, then apply all changes once in reviewed coordinates. */
export function applyCommentEditBatch(snapshots: CommentEditSnapshot[], plans: unknown[]) {
  validateBatchSnapshots(snapshots);
  if (plans.length !== snapshots.length)
    throw new Error('A plan is required for every batch comment.');
  const operations: z.infer<typeof editPlanSchema>['operations'] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i];
    applyCommentEditPlan(snapshot, plans[i]);
    const plan = editPlanSchema.parse(plans[i]);
    const keeps = plan.operations.filter((op) => op.op === 'keep');
    operations.push(...plan.operations.filter((op) => op.op !== 'keep'));
    if (keeps.length) {
      let cursor = snapshot.start;
      for (const range of mergeRanges(keeps)) {
        if (range.start > cursor) operations.push({ op: 'cut', start: cursor, end: range.start });
        cursor = range.end;
      }
      if (cursor < snapshot.end) operations.push({ op: 'cut', start: cursor, end: snapshot.end });
    }
  }
  const first = snapshots[0];
  const assets = [
    ...new Map(snapshots.flatMap((s) => s.assets ?? []).map((a) => [a.versionId, a])).values(),
  ];
  return applyCommentEditPlan(
    {
      ...first,
      assets,
      start: 0,
      end: first.decisions.edits.at(-1)!.timelineEndSeconds,
      content: snapshots.map((s) => s.content).join('\n'),
    },
    { version: 1, operations }
  );
}
