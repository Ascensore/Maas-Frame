import { z } from 'zod';
import { framesToSeconds, secondsToFrames, type FrameRate } from '../timecode';
import { cutIslandKey, packTimeline } from './program';
import type { EditDecision, EditReason, Marker, RoughCutDecisionList } from './types';

/**
 * The reviewer's decisions on a run, stored on the RoughCut row and applied
 * by materialization. Islands are addressed by the key assembly gave them;
 * extra cuts are source ranges, so both survive a re-render. Pure, and
 * copied into the worker image with the rest of lib/rough-cut.
 */

export const CUT_OVERRIDE_ACTIONS = ['restore', 'keep'] as const;
export type CutOverrideAction = (typeof CUT_OVERRIDE_ACTIONS)[number];

export type ExtraCut = {
  key: string;
  sourceVersionId: string;
  inSeconds: number;
  outSeconds: number;
  note: string | null;
};

export type RoughCutOverrides = {
  version: 1;
  cuts: Record<string, CutOverrideAction>;
  extraCuts: ExtraCut[];
};

export const MAX_EXTRA_CUTS = 200;
export const MIN_EXTRA_CUT_SECONDS = 0.1;
const NOTE_MAX = 300;
const EPSILON = 1e-6;

const RESTORED: EditReason = { code: 'KEPT', summary: 'Restored by the reviewer' };

export const roughCutOverridesSchema = z
  .object({
    version: z.literal(1),
    cuts: z.record(z.string().min(1), z.enum(CUT_OVERRIDE_ACTIONS)).default({}),
    extraCuts: z
      .array(
        z
          .object({
            key: z.string().min(1).optional(),
            sourceVersionId: z.string().min(1),
            inSeconds: z.number().finite().nonnegative(),
            outSeconds: z.number().finite().nonnegative(),
            note: z.string().trim().max(NOTE_MAX).nullable().optional(),
          })
          .strict()
      )
      .max(MAX_EXTRA_CUTS)
      .default([]),
  })
  .strict();

export function emptyOverrides(): RoughCutOverrides {
  return { version: 1, cuts: {}, extraCuts: [] };
}

/** Stable across renders: the island key convention with a prefix that says a person drew it. */
export function extraCutKey(
  sourceVersionId: string,
  inSeconds: number,
  outSeconds: number,
  rate: FrameRate
): string {
  return `manual:${cutIslandKey(sourceVersionId, inSeconds, outSeconds, rate)}`;
}

/** The frame the key names, back in seconds, so a stored cut and its key agree. */
function snapToFrame(seconds: number, rate: FrameRate): number {
  return framesToSeconds(secondsToFrames(seconds, rate), rate);
}

/**
 * A key for a stored cut written before keys were derived, or by something
 * that left the field out. Seconds rather than frames because a stored row
 * carries no rate; deterministic, so the same row always reads back the same.
 */
function storedExtraCutKey(sourceVersionId: string, inSeconds: number, outSeconds: number): string {
  return `manual:${sourceVersionId}:${inSeconds}-${outSeconds}`;
}

/** Read the stored column. A malformed value reads as no overrides rather than failing the render. */
export function parseRoughCutOverrides(value: unknown): RoughCutOverrides | null {
  if (value === null || value === undefined) return null;
  const parsed = roughCutOverridesSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    version: 1,
    cuts: parsed.data.cuts,
    extraCuts: parsed.data.extraCuts.map((cut) => ({
      key: cut.key ?? storedExtraCutKey(cut.sourceVersionId, cut.inSeconds, cut.outSeconds),
      sourceVersionId: cut.sourceVersionId,
      inSeconds: cut.inSeconds,
      outSeconds: cut.outSeconds,
      note: cut.note ?? null,
    })),
  };
}

export type OverridesValidation =
  | { ok: true; value: RoughCutOverrides }
  | { ok: false; error: string };

/**
 * A body from the review UI checked against the run it is for: every key
 * must name one of the run's islands and every extra cut must lie inside
 * one of its clips. Extra cut keys are derived here, never trusted, and the
 * range is snapped to the frames that key names.
 */
export function validateOverridesForDecisions(
  input: unknown,
  decisions: RoughCutDecisionList
): OverridesValidation {
  const parsed = roughCutOverridesSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
    return { ok: false, error: `${path}${first?.message ?? 'Invalid overrides'}` };
  }
  const islandKeys = new Set((decisions.cuts ?? []).map((cut) => cut.key));
  const unknown = Object.keys(parsed.data.cuts).filter((key) => !islandKeys.has(key));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown cut keys: ${unknown.slice(0, 5).join(', ')}` };
  }
  const clips = new Map(decisions.clips.map((clip) => [clip.versionId, clip]));
  const extraCuts: ExtraCut[] = [];
  const seen = new Set<string>();
  for (const cut of parsed.data.extraCuts) {
    const clip = clips.get(cut.sourceVersionId);
    if (!clip) {
      return { ok: false, error: `extraCuts: ${cut.sourceVersionId} is not a clip of this cut` };
    }
    if (cut.outSeconds < cut.inSeconds) {
      return {
        ok: false,
        error: `extraCuts: a cut cannot end (${cut.outSeconds}s) before it starts (${cut.inSeconds}s)`,
      };
    }
    // The epsilon keeps a range the reviewer drew as exactly the minimum (0.3 - 0.2
    // is 0.09999999999999998 in binary floating point) from being refused.
    if (cut.outSeconds - cut.inSeconds < MIN_EXTRA_CUT_SECONDS - EPSILON) {
      return {
        ok: false,
        error: `extraCuts: a cut must be at least ${MIN_EXTRA_CUT_SECONDS}s long`,
      };
    }
    // A clip whose duration never got probed is stored as 0. That is "unknown",
    // not "empty", so the end-of-clip bound is skipped rather than refusing
    // every cut on the clip.
    if (clip.durationSeconds > EPSILON && cut.outSeconds > clip.durationSeconds + EPSILON) {
      return { ok: false, error: `extraCuts: ${cut.outSeconds}s is past the end of the clip` };
    }
    const key = extraCutKey(cut.sourceVersionId, cut.inSeconds, cut.outSeconds, decisions.rate);
    if (seen.has(key)) continue;
    seen.add(key);
    extraCuts.push({
      key,
      sourceVersionId: cut.sourceVersionId,
      inSeconds: snapToFrame(cut.inSeconds, decisions.rate),
      outSeconds: snapToFrame(cut.outSeconds, decisions.rate),
      note: cut.note ?? null,
    });
  }
  return { ok: true, value: { version: 1, cuts: parsed.data.cuts, extraCuts } };
}

/** Keys the reviewer decided on that name no island of this run, sorted. Stale after a re-render. */
function staleCutKeys(
  decisions: RoughCutDecisionList,
  overrides: RoughCutOverrides | null
): string[] {
  const islandKeys = new Set((decisions.cuts ?? []).map((cut) => cut.key));
  return Object.keys(overrides?.cuts ?? {})
    .filter((key) => !islandKeys.has(key))
    .sort();
}

/**
 * Whether the reviewer's decisions change the program at all. Given the run,
 * a restore of a key the run no longer has counts for nothing; without it,
 * every restore counts.
 */
export function hasProgramChanges(
  overrides: RoughCutOverrides | null,
  decisions?: RoughCutDecisionList
): boolean {
  if (!overrides) return false;
  if (overrides.extraCuts.length > 0) return true;
  const islandKeys = decisions ? new Set((decisions.cuts ?? []).map((cut) => cut.key)) : null;
  return Object.entries(overrides.cuts).some(
    ([key, action]) => action === 'restore' && (!islandKeys || islandKeys.has(key))
  );
}

function programSeconds(edits: EditDecision[]): number {
  return edits.reduce((sum, edit) => sum + (edit.outSeconds - edit.inSeconds), 0);
}

function subtractSourceRange(
  edits: EditDecision[],
  cut: { sourceVersionId: string; inSeconds: number; outSeconds: number }
): EditDecision[] {
  const out: EditDecision[] = [];
  for (const edit of edits) {
    const misses =
      edit.sourceVersionId !== cut.sourceVersionId ||
      cut.outSeconds <= edit.inSeconds + EPSILON ||
      cut.inSeconds >= edit.outSeconds - EPSILON;
    if (misses) {
      out.push(edit);
      continue;
    }
    if (cut.inSeconds > edit.inSeconds + EPSILON) {
      out.push({
        ...edit,
        outSeconds: cut.inSeconds,
        timelineEndSeconds: edit.timelineStartSeconds + (cut.inSeconds - edit.inSeconds),
      });
    }
    if (cut.outSeconds < edit.outSeconds - EPSILON) {
      out.push({
        ...edit,
        inSeconds: cut.outSeconds,
        timelineStartSeconds: edit.timelineStartSeconds + (cut.outSeconds - edit.inSeconds),
      });
    }
  }
  return out;
}

/**
 * Two edits that continue each other in the same source and camera become one.
 * A merged edit that spans original and restored material is labelled restored
 * as a whole: the reason is a label on a range, and the review UI reads restore
 * state off the islands and the applied report, not off this field.
 */
function mergeContiguous(edits: EditDecision[]): EditDecision[] {
  const out: EditDecision[] = [];
  for (const edit of edits) {
    const last = out[out.length - 1];
    if (
      last &&
      last.sourceVersionId === edit.sourceVersionId &&
      last.cameraRole === edit.cameraRole &&
      Math.abs(last.outSeconds - edit.inSeconds) < EPSILON
    ) {
      out[out.length - 1] = {
        ...last,
        outSeconds: edit.outSeconds,
        timelineEndSeconds: last.timelineEndSeconds + (edit.outSeconds - edit.inSeconds),
        reason: edit.reason?.summary === RESTORED.summary ? edit.reason : last.reason,
      };
    } else {
      out.push({ ...edit });
    }
  }
  return out;
}

type SourcePoint = { sourceVersionId: string; seconds: number };

/** Where a timeline position sits in the footage, or null if no edit covers it. */
function timelineToSource(edits: EditDecision[], timelineSeconds: number): SourcePoint | null {
  for (const edit of edits) {
    if (
      timelineSeconds >= edit.timelineStartSeconds - EPSILON &&
      timelineSeconds < edit.timelineEndSeconds - EPSILON
    ) {
      return {
        sourceVersionId: edit.sourceVersionId,
        seconds: edit.inSeconds + (timelineSeconds - edit.timelineStartSeconds),
      };
    }
  }
  return null;
}

/** Where a source position lands on the program, or null if that material is not in it. */
function sourceToTimeline(edits: EditDecision[], point: SourcePoint): number | null {
  for (const edit of edits) {
    if (edit.sourceVersionId !== point.sourceVersionId) continue;
    if (point.seconds >= edit.inSeconds - EPSILON && point.seconds < edit.outSeconds - EPSILON) {
      return edit.timelineStartSeconds + (point.seconds - edit.inSeconds);
    }
  }
  return null;
}

/**
 * Markers are placed on the program, so a changed program moves them: each one
 * goes through the original edits to the frame of footage it was pointing at,
 * and back through the new ones. A marker whose footage is no longer in the
 * program is dropped. Durations are left alone; a marker is a placeholder, and
 * the editor sizes what goes there.
 */
function replaceMarkers(
  markers: Marker[],
  original: EditDecision[],
  effective: EditDecision[]
): Marker[] {
  const out: Marker[] = [];
  for (const marker of markers) {
    const point = timelineToSource(original, marker.timelineSeconds);
    if (!point) continue;
    const timelineSeconds = sourceToTimeline(effective, point);
    if (timelineSeconds === null) continue;
    out.push({ ...marker, timelineSeconds });
  }
  return out;
}

/** What applying the reviewer's decisions did, for the review API and the render log. */
export type AppliedOverrides = {
  decisions: RoughCutDecisionList;
  /** Islands actually put back, deduplicated by key. */
  restoredKeys: string[];
  /** Decided keys that name no island of this run any more. */
  staleCutKeys: string[];
  /** Islands asked for whose source is not a clip of this run. */
  skippedIslands: string[];
  /** Extra cuts that took material out; one drawn over already-removed material does not. */
  extraCutsApplied: number;
};

/**
 * The program after the reviewer's decisions, with a report of what applied:
 * restored islands go back where their source time puts them, extra cuts come
 * out, markers follow the footage they pointed at, and the timeline is packed
 * again. Every layout leaves assembly packed tight, so the continuous axis
 * (clip offset plus source in-point) orders edits for all of them.
 */
export function applyOverridesWithReport(
  decisions: RoughCutDecisionList,
  overrides: RoughCutOverrides | null
): AppliedOverrides {
  const stale = staleCutKeys(decisions, overrides);
  if (!overrides || !hasProgramChanges(overrides, decisions)) {
    return {
      decisions,
      restoredKeys: [],
      staleCutKeys: stale,
      skippedIslands: [],
      extraCutsApplied: 0,
    };
  }
  const clips = new Map(decisions.clips.map((clip) => [clip.versionId, clip]));
  const axis = (edit: EditDecision) =>
    (clips.get(edit.sourceVersionId)?.offsetSeconds ?? 0) + edit.inSeconds;

  // Copied up front: nothing below writes into the caller's list today, and
  // this keeps that true if a later change ever pushes before it subtracts.
  let edits: EditDecision[] = decisions.edits.map((edit) => ({ ...edit }));
  const restoredKeys: string[] = [];
  const skippedIslands: string[] = [];
  const seen = new Set<string>();
  for (const island of decisions.cuts ?? []) {
    if (overrides.cuts[island.key] !== 'restore') continue;
    // One decision per key, whatever the list holds: a key is what the
    // reviewer clicked, and restoring it twice is still one restore.
    if (seen.has(island.key)) continue;
    seen.add(island.key);
    const clip = clips.get(island.sourceVersionId);
    if (!clip) {
      skippedIslands.push(island.key);
      continue;
    }
    // The program can already hold the island's range: computeLinearDecisions
    // keeps every clip in full when no island clears minShotSeconds, and the
    // cuts are recorded all the same. Take the range out before putting it
    // back so a restore never doubles material.
    edits = subtractSourceRange(edits, island);
    edits.push({
      timelineStartSeconds: 0,
      timelineEndSeconds: island.outSeconds - island.inSeconds,
      inSeconds: island.inSeconds,
      outSeconds: island.outSeconds,
      sourceVersionId: island.sourceVersionId,
      cameraRole: clip.role,
      targetTrack: clip.track,
      reason: RESTORED,
    });
    restoredKeys.push(island.key);
  }
  let extraCutsApplied = 0;
  for (const cut of overrides.extraCuts) {
    const before = programSeconds(edits);
    edits = subtractSourceRange(edits, cut);
    if (programSeconds(edits) < before - EPSILON) extraCutsApplied += 1;
  }
  edits = edits
    .filter((edit) => edit.outSeconds - edit.inSeconds > EPSILON)
    .sort((a, b) => axis(a) - axis(b));
  const packed = packTimeline(mergeContiguous(edits));
  const markers = decisions.markers
    ? replaceMarkers(decisions.markers, decisions.edits, packed)
    : null;
  return {
    decisions: { ...decisions, edits: packed, ...(markers ? { markers } : {}) },
    restoredKeys,
    staleCutKeys: stale,
    skippedIslands,
    extraCutsApplied,
  };
}

/** The program alone. The same object back when the decisions change nothing. */
export function applyOverrides(
  decisions: RoughCutDecisionList,
  overrides: RoughCutOverrides | null
): RoughCutDecisionList {
  return applyOverridesWithReport(decisions, overrides).decisions;
}

export type OverrideSummary = {
  restored: number;
  kept: number;
  extraCuts: number;
  originalSeconds: number;
  programSeconds: number;
  /** Decided keys this run no longer has; counted in neither restored nor kept. */
  staleKeys: string[];
};

/**
 * What the reviewer has decided and what it costs the program. Decisions on
 * islands the run no longer has are reported as stale rather than counted;
 * an island that was decided but could not be applied (its source is gone)
 * still counts as a decision, and applyOverridesWithReport says it skipped it.
 */
export function overrideSummary(
  decisions: RoughCutDecisionList,
  overrides: RoughCutOverrides | null
): OverrideSummary {
  const applied = applyOverridesWithReport(decisions, overrides);
  const islandKeys = new Set((decisions.cuts ?? []).map((cut) => cut.key));
  const entries = Object.entries(overrides?.cuts ?? {}).filter(([key]) => islandKeys.has(key));
  return {
    restored: entries.filter(([, action]) => action === 'restore').length,
    kept: entries.filter(([, action]) => action === 'keep').length,
    extraCuts: overrides?.extraCuts.length ?? 0,
    originalSeconds: programSeconds(decisions.edits),
    programSeconds: programSeconds(applied.decisions.edits),
    staleKeys: applied.staleCutKeys,
  };
}

/**
 * No decisions is no decisions: a null and an empty overrides read the same.
 * Extra cuts compare by key, which is frame-rounded, because that is what
 * validation deduplicates on: two ranges inside the same frame are one cut.
 */
function canonical(overrides: RoughCutOverrides | null): string {
  const cuts = Object.keys(overrides?.cuts ?? {})
    .sort()
    .map((key) => `${key}=${overrides?.cuts[key]}`);
  const extra = (overrides?.extraCuts ?? []).map((cut) => cut.key).sort();
  return JSON.stringify({ cuts, extra });
}

/** Same decisions, whatever the key order; notes do not count. */
export function overridesEqual(a: RoughCutOverrides | null, b: RoughCutOverrides | null): boolean {
  return canonical(a) === canonical(b);
}
