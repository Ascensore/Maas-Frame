'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readClientApiError } from '@/components/video-page/hooks/use-subtitles';
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
 * The hook probes once per version on mount as well. A burn takes minutes, and
 * an operator who reloads the page in the middle of one would otherwise see an
 * idle dialog and get a 409 for their trouble.
 */

export const BURN_IN_POLL_MS = 4000;

export type BurnInJob = { id: string; status: string; error?: string | null };

/** The job is still on its way to an answer. Mirrors ACTIVE_JOB_STATUSES in the route. */
function isActiveStatus(status: string): boolean {
  return status === 'PENDING' || status === 'QUEUED' || status === 'RUNNING';
}

export function useBurnIn(options: {
  videoId: string;
  versionId: string | null;
  onDone?: () => void;
}) {
  const { videoId, versionId } = options;
  const [job, setJob] = useState<BurnInJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const onDoneRef = useRef(options.onDone);
  useEffect(() => {
    onDoneRef.current = options.onDone;
  }, [options.onDone]);

  /**
   * The job whose success has already been announced. The interval is cleared
   * the moment the status stops being active, but a request that was already in
   * flight still lands, and reloading the page twice for one render is a
   * visible bug rather than a wasted fetch.
   */
  const announcedRef = useRef<string | null>(null);

  const statusUrl = versionId
    ? `/api/videos/${videoId}/burn-in?versionId=${encodeURIComponent(versionId)}`
    : null;

  // Reset on version change, then adopt whatever is already running for the
  // new version. One GET: the polling effect below takes over from here.
  useEffect(() => {
    setJob(null);
    setError(null);
    if (!statusUrl) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(statusUrl, { cache: 'no-store' });
        const payload = await response.json().catch(() => null);
        if (cancelled || !response.ok) return;
        const current =
          (payload as { data?: { job?: BurnInJob | null } } | null)?.data?.job ?? null;
        if (current && isActiveStatus(current.status)) setJob(current);
      } catch {
        // Nothing to adopt. The operator can start one, and the POST is the
        // thing that refuses if a job really is running.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [statusUrl]);

  const isRunning = job !== null && isActiveStatus(job.status);

  // Depending on `isRunning` rather than on the job keeps one interval running
  // across polls instead of restarting the clock every time a status arrives.
  useEffect(() => {
    if (!isRunning || !statusUrl) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(statusUrl, { cache: 'no-store' });
        const payload = await response.json().catch(() => null);
        if (cancelled || !response.ok) return;
        const next = (payload as { data?: { job?: BurnInJob | null } } | null)?.data?.job ?? null;
        if (!next) return;
        setJob(next);
        if (next.status === 'SUCCEEDED' && announcedRef.current !== next.id) {
          announcedRef.current = next.id;
          onDoneRef.current?.();
        }
        if (next.status === 'FAILED') setError(next.error || 'The burn-in failed');
      } catch {
        // The next tick retries; a dropped poll is not a failed render.
      }
    };
    const timer = setInterval(() => void poll(), BURN_IN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isRunning, statusUrl]);

  const start = useCallback(
    async (style: Partial<BurnInStyle>, subtitleId?: string): Promise<string | null> => {
      if (!versionId) return 'No version selected';
      setStarting(true);
      setError(null);
      try {
        const response = await fetch(`/api/videos/${videoId}/burn-in`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ versionId, style, ...(subtitleId ? { subtitleId } : {}) }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const message = readClientApiError(payload, 'Failed to start the burn-in');
          setError(message);
          return message;
        }
        const queued = (payload as { data?: { job?: BurnInJob | null } } | null)?.data?.job ?? null;
        setJob(queued);
        return null;
      } catch {
        const message = 'Failed to start the burn-in';
        setError(message);
        return message;
      } finally {
        setStarting(false);
      }
    },
    [versionId, videoId]
  );

  return { job, error, starting, isRunning, start };
}
