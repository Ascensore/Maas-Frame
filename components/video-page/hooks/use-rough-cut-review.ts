'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  emptyOverrides,
  extraCutKey,
  needsRender as computeNeedsRender,
  overridesEqual,
  type CutOverrideAction,
  type ExtraCut,
  type RoughCutOverrides,
} from '@/lib/rough-cut/overrides';
import type {
  RoughCutRenderState,
  RoughCutReview,
  RoughCutReviewSource,
} from '@/lib/rough-cut/review';
import type { RoughCutDecisionList } from '@/lib/rough-cut/types';
import { parseRoughCut, type RoughCutRecord } from '@/components/video-page/hooks/use-rough-cut';

/**
 * The review behind the video being watched: what the run cut and why, what the
 * reviewer has decided about it, and where the output's seconds sit in the
 * footage. The decisions live here as a draft until they are saved, and saving
 * changes nothing on the delivered file until a render is asked for.
 *
 * The API withholds the review from anyone who may not edit the project, so a
 * loaded review is by itself the permission to act on it.
 */

export const ROUGH_CUT_REVIEW_POLL_MS = 4000;

const EPSILON = 1e-6;

/** Stable identity for a review with nothing to show, so the pane does not rerender on it. */
const NO_SOURCES: RoughCutReviewSource[] = [];

const BUSY_MESSAGE = 'Another change is already running';

type ReviewPayload = {
  roughCut: unknown;
  review: RoughCutReview | null;
  canEdit?: boolean;
};

export type SourceRange = { sourceVersionId: string; inSeconds: number; outSeconds: number };

export type SourcePoint = { sourceVersionId: string; seconds: number };

function readClientApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

/** The edit under a timeline second, or null between programs. */
function editAt(decisions: RoughCutDecisionList, seconds: number) {
  return (
    decisions.edits.find(
      (edit) => seconds >= edit.timelineStartSeconds && seconds < edit.timelineEndSeconds
    ) ?? null
  );
}

function isRendering(status: RoughCutRenderState['status']): boolean {
  return status === 'queued' || status === 'running';
}

export function useRoughCutReview(options: {
  videoId: string;
  enabled: boolean;
  onRendered?: () => void;
}) {
  const { videoId, enabled, onRendered } = options;

  const [roughCut, setRoughCut] = useState<RoughCutRecord | null>(null);
  const [review, setReview] = useState<RoughCutReview | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [draft, setDraft] = useState<RoughCutOverrides>(emptyOverrides);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  /** One mutation at a time: a save and a render disagree about what is stored. */
  const busyRef = useRef(false);
  const loadedRef = useRef(false);
  /** The overrides the delivered file was cut from, as last seen. */
  const lastRenderedRef = useRef<string | null>(null);
  const draftRef = useRef<RoughCutOverrides>(draft);
  const savedRef = useRef<RoughCutOverrides | null>(null);
  const onRenderedRef = useRef(onRendered);
  /**
   * Bumped every time the hook is pointed at another video. The page reuses one
   * mounted hook across videos, so a reply from the one just left — a load, a
   * save, a render — must not land on the one now open.
   */
  const generationRef = useRef(0);

  useEffect(() => {
    onRenderedRef.current = onRendered;
  }, [onRendered]);

  const commitDraft = useCallback((value: RoughCutOverrides) => {
    draftRef.current = value;
    setDraft(value);
  }, []);

  /**
   * The draft is read from a ref rather than from state so a poll landing
   * between a click and its render still sees what the reviewer has decided.
   */
  const updateDraft = useCallback(
    (update: (current: RoughCutOverrides) => RoughCutOverrides) => {
      commitDraft(update(draftRef.current));
    },
    [commitDraft]
  );

  // Declared above the load effect on purpose: effects run in order, so the
  // state of the video being left is gone before the next one is asked for.
  // Without it the second video's saved decisions were never adopted (the
  // "already loaded" branch kept the first one's draft) and one Save wrote the
  // first video's decisions onto the second one's run.
  useEffect(() => {
    generationRef.current += 1;
    inFlightRef.current = false;
    loadedRef.current = false;
    lastRenderedRef.current = null;
    savedRef.current = null;
    commitDraft(emptyOverrides());
    setRoughCut(null);
    setReview(null);
    setCanEdit(false);
    setError(null);
  }, [commitDraft, videoId]);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const generation = generationRef.current;
    try {
      const response = await fetch(`/api/videos/${videoId}/rough-cut`, { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (generationRef.current !== generation) return;
      if (!response.ok) {
        setError(readClientApiError(payload, 'Failed to load the cut review'));
        return;
      }
      const data = (payload as { data?: ReviewPayload } | null)?.data ?? null;
      const nextReview = data?.review ?? null;
      setRoughCut(parseRoughCut(data?.roughCut));
      setReview(nextReview);
      setCanEdit(data?.canEdit === true);
      setError(null);
      if (!nextReview) return;

      const rendered = JSON.stringify(nextReview.renderedOverrides ?? null);
      if (!loadedRef.current) {
        loadedRef.current = true;
        lastRenderedRef.current = rendered;
        savedRef.current = nextReview.overrides;
        commitDraft(nextReview.overrides ?? emptyOverrides());
        return;
      }
      // Unsaved work outlives a reload: only a draft that still matches what
      // was stored follows the row.
      const wasDirty = !overridesEqual(draftRef.current, savedRef.current);
      savedRef.current = nextReview.overrides;
      if (isRendering(nextReview.render.status)) return;
      if (rendered === lastRenderedRef.current) return;
      lastRenderedRef.current = rendered;
      if (!wasDirty) commitDraft(nextReview.overrides ?? emptyOverrides());
      onRenderedRef.current?.();
    } catch {
      if (generationRef.current === generation) setError('Failed to load the cut review');
    } finally {
      // A reply from a video already left never frees the current video's slot.
      if (generationRef.current === generation) inFlightRef.current = false;
    }
  }, [commitDraft, videoId]);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [enabled, load]);

  const renderStatus = review?.render.status ?? 'idle';

  // Depending on the status alone rather than on the whole review keeps one
  // interval running across polls instead of restarting the clock on each.
  useEffect(() => {
    if (!enabled || !isRendering(renderStatus)) return;
    const timer = setInterval(() => {
      void load();
    }, ROUGH_CUT_REVIEW_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, load, renderStatus]);

  /**
   * The program the output video actually plays. A row written before renders
   * recorded their program falls back to the run's own decisions.
   */
  const rendered = review?.renderedDecisions ?? review?.decisions ?? null;

  const sourceTimeAt = useCallback(
    (seconds: number): SourcePoint | null => {
      if (!rendered) return null;
      const edit = editAt(rendered, seconds);
      if (!edit) return null;
      return {
        sourceVersionId: edit.sourceVersionId,
        seconds: edit.inSeconds + (seconds - edit.timelineStartSeconds),
      };
    },
    [rendered]
  );

  /**
   * One range drawn on the output can be several ranges of footage: the program
   * between them was cut, and the reviewer meant the frames they saw.
   */
  const sourceRangesForTimeline = useCallback(
    (startSeconds: number, endSeconds: number): SourceRange[] => {
      if (!rendered || endSeconds - startSeconds <= EPSILON) return [];
      const ranges: SourceRange[] = [];
      for (const edit of rendered.edits) {
        const from = Math.max(startSeconds, edit.timelineStartSeconds);
        const to = Math.min(endSeconds, edit.timelineEndSeconds);
        if (to - from <= EPSILON) continue;
        ranges.push({
          sourceVersionId: edit.sourceVersionId,
          inSeconds: edit.inSeconds + (from - edit.timelineStartSeconds),
          outSeconds: edit.inSeconds + (to - edit.timelineStartSeconds),
        });
      }
      return ranges;
    },
    [rendered]
  );

  /** Where a source position lands on the output, or null when it was cut. */
  const timelineTimeForSource = useCallback(
    (sourceVersionId: string, seconds: number): number | null => {
      if (!rendered) return null;
      for (const edit of rendered.edits) {
        if (edit.sourceVersionId !== sourceVersionId) continue;
        if (seconds >= edit.inSeconds - EPSILON && seconds < edit.outSeconds - EPSILON) {
          return edit.timelineStartSeconds + (seconds - edit.inSeconds);
        }
      }
      return null;
    },
    [rendered]
  );

  const setCutAction = useCallback(
    (key: string, action: CutOverrideAction | null) => {
      updateDraft((current) => {
        const cuts = { ...current.cuts };
        if (action === null) delete cuts[key];
        else cuts[key] = action;
        return { ...current, cuts };
      });
    },
    [updateDraft]
  );

  const addExtraCutFromTimeline = useCallback(
    (startSeconds: number, endSeconds: number, note?: string | null) => {
      if (!review) return;
      const ranges = sourceRangesForTimeline(startSeconds, endSeconds);
      if (ranges.length === 0) return;
      const trimmed = note?.trim() ? note.trim() : null;
      updateDraft((current) => {
        const keys = new Set(current.extraCuts.map((cut) => cut.key));
        const added: ExtraCut[] = [];
        for (const range of ranges) {
          const key = extraCutKey(
            range.sourceVersionId,
            range.inSeconds,
            range.outSeconds,
            review.decisions.rate
          );
          // Two ranges inside the same frame are one cut, and the API stores
          // them that way; drawing the same range twice adds nothing.
          if (keys.has(key)) continue;
          keys.add(key);
          added.push({ key, ...range, note: trimmed });
        }
        if (added.length === 0) return current;
        return { ...current, extraCuts: [...current.extraCuts, ...added] };
      });
    },
    [review, sourceRangesForTimeline, updateDraft]
  );

  const removeExtraCut = useCallback(
    (key: string) => {
      updateDraft((current) => ({
        ...current,
        extraCuts: current.extraCuts.filter((cut) => cut.key !== key),
      }));
    },
    [updateDraft]
  );

  const save = useCallback(async (): Promise<string | null> => {
    const id = roughCut?.id;
    if (!id) return 'There is no cut to save';
    if (busyRef.current) {
      setError(BUSY_MESSAGE);
      return BUSY_MESSAGE;
    }
    busyRef.current = true;
    setSaving(true);
    setError(null);
    const generation = generationRef.current;
    try {
      const response = await fetch(`/api/rough-cuts/${id}/overrides`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftRef.current),
      });
      const payload = await response.json().catch(() => null);
      if (generationRef.current !== generation) return null;
      if (!response.ok) {
        const message = readClientApiError(payload, 'Failed to save the review');
        setError(message);
        return message;
      }
      const data = (
        payload as {
          data?: { overrides?: RoughCutOverrides | null; needsRender?: boolean };
        } | null
      )?.data;
      // The API derives the extra cut keys and snaps their ranges to frames, so
      // the draft becomes what was stored rather than what was sent.
      const stored = data?.overrides ?? null;
      savedRef.current = stored;
      commitDraft(stored ?? emptyOverrides());
      setReview((current) =>
        current
          ? { ...current, overrides: stored, needsRender: data?.needsRender === true }
          : current
      );
      return null;
    } catch {
      const message = 'Failed to save the review';
      if (generationRef.current === generation) setError(message);
      return message;
    } finally {
      setSaving(false);
      busyRef.current = false;
    }
  }, [commitDraft, roughCut]);

  const render = useCallback(async (): Promise<string | null> => {
    const id = roughCut?.id;
    if (!id) return 'There is no cut to render';
    if (busyRef.current) {
      setError(BUSY_MESSAGE);
      return BUSY_MESSAGE;
    }
    busyRef.current = true;
    setRendering(true);
    setError(null);
    const generation = generationRef.current;
    try {
      const response = await fetch(`/api/rough-cuts/${id}/render`, { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (generationRef.current !== generation) return null;
      if (!response.ok) {
        const message = readClientApiError(payload, 'Failed to start the render');
        // 409 is "somebody already started one" — an answer about a job that
        // exists. Reload before reporting it, so the pane follows that job to
        // its new version instead of sitting on an idle it no longer has.
        if (response.status === 409) await load();
        setError(message);
        return message;
      }
      setReview((current) =>
        current
          ? {
              ...current,
              render: { status: 'queued', error: null, updatedAt: new Date().toISOString() },
            }
          : current
      );
      return null;
    } catch {
      const message = 'Failed to start the render';
      if (generationRef.current === generation) setError(message);
      return message;
    } finally {
      setRendering(false);
      busyRef.current = false;
    }
  }, [load, roughCut]);

  const isDirty = useMemo(() => !overridesEqual(draft, review?.overrides ?? null), [draft, review]);

  const needsRender = useMemo(
    () =>
      review
        ? computeNeedsRender(review.decisions, review.overrides, review.renderedOverrides)
        : false,
    [review]
  );

  return {
    roughCut,
    review,
    canEdit,
    draft,
    rendered,
    sources: review?.sources ?? NO_SOURCES,
    loading,
    saving,
    rendering,
    error,
    isDirty,
    needsRender,
    renderStatus,
    // The API serves the review to editors alone, so a review in hand is the
    // whole test; `canEdit` is named here so the rule reads at the call site.
    isRoughCutOutput: Boolean(roughCut && review && canEdit),
    setCutAction,
    addExtraCutFromTimeline,
    removeExtraCut,
    sourceTimeAt,
    sourceRangesForTimeline,
    timelineTimeForSource,
    save,
    render,
    reload: load,
  };
}
