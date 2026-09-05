import { z } from 'zod';
import type { FrameRate } from '../timecode';
import { cutIslandKey, packTimeline } from './program';
import type { EditDecision, EditReason, RoughCutDecisionList } from './types';

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

/** Read the stored column. A malformed value reads as no overrides rather than failing the render. */
export function parseRoughCutOverrides(value: unknown): RoughCutOverrides | null {
  if (value === null || value === undefined) return null;
  const parsed = roughCutOverridesSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    version: 1,
    cuts: parsed.data.cuts,
    extraCuts: parsed.data.extraCuts.map((cut) => ({
      key: cut.key ?? '',
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
 * one of its clips. Extra cut keys are derived here, never trusted.
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
    if (cut.outSeconds - cut.inSeconds < MIN_EXTRA_CUT_SECONDS) {
      return {
        ok: false,
        error: `extraCuts: a cut must be at least ${MIN_EXTRA_CUT_SECONDS}s long`,
      };
    }
    if (clip.durationSeconds > EPSILON && cut.outSeconds > clip.durationSeconds + EPSILON) {
      return { ok: false, error: `extraCuts: ${cut.outSeconds}s is past the end of the clip` };
    }
    const key = extraCutKey(cut.sourceVersionId, cut.inSeconds, cut.outSeconds, decisions.rate);
    if (seen.has(key)) continue;
    seen.add(key);
    extraCuts.push({
      key,
      sourceVersionId: cut.sourceVersionId,
      inSeconds: cut.inSeconds,
      outSeconds: cut.outSeconds,
      note: cut.note ?? null,
    });
  }
  return { ok: true, value: { version: 1, cuts: parsed.data.cuts, extraCuts } };
}

export function hasProgramChanges(overrides: RoughCutOverrides | null): boolean {
  if (!overrides) return false;
  if (overrides.extraCuts.length > 0) return true;
  return Object.values(overrides.cuts).some((action) => action === 'restore');
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

/** Two edits that continue each other in the same source and camera become one. */
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

/**
 * The program after the reviewer's decisions: restored islands go back where
 * their source time puts them, extra cuts come out, and the timeline is
 * packed again. Every layout leaves assembly packed tight, so the continuous
 * axis (clip offset plus source in-point) orders edits for all of them.
 * Markers keep the timeline positions assembly gave them; the review UI does
 * not depend on them after a change.
 */
export function applyOverrides(
  decisions: RoughCutDecisionList,
  overrides: RoughCutOverrides | null
): RoughCutDecisionList {
  if (!overrides || !hasProgramChanges(overrides)) return decisions;
  const clips = new Map(decisions.clips.map((clip) => [clip.versionId, clip]));
  const axis = (edit: EditDecision) =>
    (clips.get(edit.sourceVersionId)?.offsetSeconds ?? 0) + edit.inSeconds;

  let edits: EditDecision[] = decisions.edits.map((edit) => ({ ...edit }));
  for (const island of decisions.cuts ?? []) {
    if (overrides.cuts[island.key] !== 'restore') continue;
    const clip = clips.get(island.sourceVersionId);
    edits.push({
      timelineStartSeconds: 0,
      timelineEndSeconds: island.outSeconds - island.inSeconds,
      inSeconds: island.inSeconds,
      outSeconds: island.outSeconds,
      sourceVersionId: island.sourceVersionId,
      cameraRole: clip?.role ?? 'A',
      targetTrack: clip?.track ?? 1,
      reason: RESTORED,
    });
  }
  for (const cut of overrides.extraCuts) {
    edits = subtractSourceRange(edits, cut);
  }
  edits = edits
    .filter((edit) => edit.outSeconds - edit.inSeconds > EPSILON)
    .sort((a, b) => axis(a) - axis(b));
  return { ...decisions, edits: packTimeline(mergeContiguous(edits)) };
}

export type OverrideSummary = {
  restored: number;
  kept: number;
  extraCuts: number;
  originalSeconds: number;
  programSeconds: number;
};

function programSeconds(edits: EditDecision[]): number {
  return edits.reduce((sum, edit) => sum + (edit.outSeconds - edit.inSeconds), 0);
}

export function overrideSummary(
  decisions: RoughCutDecisionList,
  overrides: RoughCutOverrides | null
): OverrideSummary {
  const actions = Object.values(overrides?.cuts ?? {});
  return {
    restored: actions.filter((action) => action === 'restore').length,
    kept: actions.filter((action) => action === 'keep').length,
    extraCuts: overrides?.extraCuts.length ?? 0,
    originalSeconds: programSeconds(decisions.edits),
    programSeconds: programSeconds(applyOverrides(decisions, overrides).edits),
  };
}

/** No decisions is no decisions: a null and an empty overrides read the same. */
function canonical(overrides: RoughCutOverrides | null): string {
  const cuts = Object.keys(overrides?.cuts ?? {})
    .sort()
    .map((key) => `${key}=${overrides?.cuts[key]}`);
  const extra = (overrides?.extraCuts ?? [])
    .map((cut) => `${cut.sourceVersionId}:${cut.inSeconds}-${cut.outSeconds}`)
    .sort();
  return JSON.stringify({ cuts, extra });
}

/** Same decisions, whatever the key order; notes do not count. */
export function overridesEqual(a: RoughCutOverrides | null, b: RoughCutOverrides | null): boolean {
  return canonical(a) === canonical(b);
}
