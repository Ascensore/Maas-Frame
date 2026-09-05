'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readClientApiError } from '@/lib/client/api-error';
import type { BurnInStyle } from '@/lib/rough-cut/subtitle-style';

/**
 * One burn-in of the version being watched: starting it, following it, and
 * saying when it landed.
 *
 * The render is a media job, so the POST only queues one and the status comes
 * from polling the same route. The worker adds the result as a new version of
 * this video, which is why `onDone` exists at all: the page has to reload its
 * own data to show what was just produced.
 *
 * The hook probes once per version as well, on mount and on every version
 * change. A burn takes minutes: an operator who reloads the page in the middle
 * of one would otherwise see an idle dialog and get a 409 for their trouble,
 * and one who wanders off to another version and back would never learn that
 * the burn they started has finished.
 *
 * Two failures are deliberately kept apart. A refused *start* is returned to
 * the caller and never stored, because the dialog that asked for it is on
 * screen and shows it inline; `error` is reserved for a job that failed after
 * the dialog was gone, which only the page can report. Reporting both through
 * `error` is how one refusal became two messages at once.
 */

export const BURN_IN_POLL_MS = 4000;

/**
 * Consecutive failed polls before the hook gives up. Eighty seconds of silence
 * is well past a redeploy or a dropped connection, and a poll loop that never
 * stops is a request every four seconds for as long as the tab is open.
 */
export const BURN_IN_MAX_POLL_FAILURES = 20;

const LOST_MESSAGE = 'Lost track of the burn-in. Refresh the page to check again.';

const DISABLED_MESSAGE = 'Burn-in is not available';

export type BurnInJob = { id: string; status: string; error?: string | null };

/** The job is still on its way to an answer. Mirrors ACTIVE_JOB_STATUSES in the route. */
function isActiveStatus(status: string): boolean {
  return status === 'PENDING' || status === 'QUEUED' || status === 'RUNNING';
}

function readJob(payload: unknown): BurnInJob | null {
  return (payload as { data?: { job?: BurnInJob | null } } | null)?.data?.job ?? null;
}

export function useBurnIn(options: {
  videoId: string;
  versionId: string | null;
  /**
   * False for anyone the route would refuse — a viewer, a YouTube embed, an
   * audio review. The hook then makes no request at all rather than collecting
   * a 403 on every page load.
   */
  enabled: boolean;
  onDone?: () => void;
}) {
  const { videoId, versionId, enabled } = options;
  const [job, setJob] = useState<BurnInJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** Polling has given up; only a reload finds out what happened. */
  const [lost, setLost] = useState(false);

  const onDoneRef = useRef(options.onDone);
  useEffect(() => {
    onDoneRef.current = options.onDone;
  }, [options.onDone]);

  /**
   * The jobs this session started or adopted. A success is only announced for
   * one of these: every other page load would otherwise reload the video and
   * toast about a burn somebody finished last week.
   */
  const followedRef = useRef<Set<string>>(new Set());
  /** Of those, the ones already announced, so `onDone` runs once per job. */
  const announcedRef = useRef<Set<string>>(new Set());
  /**
   * Bumped by every start. The adopt probe below carries the value it read at
   * the time, so a slow answer cannot overwrite the job the operator queued
   * while it was in flight — an adopt that says "nothing running" landing after
   * a successful POST would otherwise wipe the new job off the screen.
   */
  const startedRef = useRef(0);
  /** One poll at a time: a GET slower than the interval must not stack. */
  const inFlightRef = useRef(false);
  const failuresRef = useRef(0);

  const statusUrl =
    enabled && versionId
      ? `/api/videos/${videoId}/burn-in?versionId=${encodeURIComponent(versionId)}`
      : null;

  const announce = useCallback((next: BurnInJob) => {
    if (next.status !== 'SUCCEEDED') return;
    if (!followedRef.current.has(next.id)) return;
    if (announcedRef.current.has(next.id)) return;
    announcedRef.current.add(next.id);
    onDoneRef.current?.();
  }, []);

  // Reset on version change, then adopt whatever is already running for the
  // new version. One GET: the polling effect below takes over from here.
  useEffect(() => {
    setJob(null);
    setError(null);
    setLost(false);
    failuresRef.current = 0;
    if (!statusUrl) return;
    const startedAt = startedRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(statusUrl, { cache: 'no-store' });
        const payload = await response.json().catch(() => null);
        if (cancelled || startedRef.current !== startedAt || !response.ok) return;
        const current = readJob(payload);
        if (!current) return;
        if (isActiveStatus(current.status)) {
          followedRef.current.add(current.id);
          setJob(current);
          return;
        }
        // Not running any more. If this session is the one that started it, it
        // finished while the operator was on another version and still owes
        // them the reload.
        announce(current);
      } catch {
        // Nothing to adopt. The operator can start one, and the POST is the
        // thing that refuses if a job really is running.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [announce, statusUrl]);

  const isRunning = job !== null && isActiveStatus(job.status);

  // Depending on `isRunning` rather than on the job keeps one interval running
  // across polls instead of restarting the clock every time a status arrives.
  useEffect(() => {
    if (!isRunning || lost || !statusUrl) return;
    let cancelled = false;
    const giveUp = () => {
      failuresRef.current += 1;
      if (failuresRef.current < BURN_IN_MAX_POLL_FAILURES) return;
      setLost(true);
      setError(LOST_MESSAGE);
    };
    const poll = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const response = await fetch(statusUrl, { cache: 'no-store' });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          giveUp();
          return;
        }
        const next = readJob(payload);
        if (!next) return;
        failuresRef.current = 0;
        setJob(next);
        announce(next);
        if (next.status === 'FAILED') setError(next.error || 'The burn-in failed');
      } catch {
        if (!cancelled) giveUp();
      } finally {
        inFlightRef.current = false;
      }
    };
    const timer = setInterval(() => void poll(), BURN_IN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [announce, isRunning, lost, statusUrl]);

  const start = useCallback(
    async (style: Partial<BurnInStyle>, subtitleId?: string): Promise<string | null> => {
      if (!enabled) return DISABLED_MESSAGE;
      if (!versionId) return 'No version selected';
      startedRef.current += 1;
      failuresRef.current = 0;
      setStarting(true);
      // A previous job's failure is history the moment another is asked for.
      setError(null);
      setLost(false);
      try {
        const response = await fetch(`/api/videos/${videoId}/burn-in`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ versionId, style, ...(subtitleId ? { subtitleId } : {}) }),
        });
        const payload = await response.json().catch(() => null);
        // Returned, not stored: whoever called this is looking at a dialog and
        // shows the refusal there.
        if (!response.ok) return readClientApiError(payload, 'Failed to start the burn-in');
        const queued = readJob(payload);
        if (queued) followedRef.current.add(queued.id);
        setJob(queued);
        return null;
      } catch {
        return 'Failed to start the burn-in';
      } finally {
        setStarting(false);
      }
    },
    [enabled, versionId, videoId]
  );

  return { job, error, starting, isRunning, start };
}
