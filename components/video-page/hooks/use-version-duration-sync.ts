'use client';

import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { VideoData } from '@/components/video-page/types';

interface UseVersionDurationSyncParams {
  videoDuration: number;
  activeVersionDuration?: number | null;
  activeVersionId: string | null;
  propProjectId?: string;
  videoId: string;
  setVideo: Dispatch<SetStateAction<VideoData | null>>;
}

/**
 * Persist the duration the player just measured for this version.
 *
 * Stored duration is an integer number of seconds. Ceil so a comment at 90.4s on
 * a 90.4s cut is still in range. Only extend (or fill a missing value): a
 * shorter measurement is more often a load glitch than a real recut, and
 * copying V1's duration onto a longer V2 used to stick forever because any
 * stored value > 0 skipped the write.
 */
export function measuredDurationSeconds(videoDuration: number): number | null {
  if (!videoDuration || !Number.isFinite(videoDuration) || videoDuration <= 0) return null;
  return Math.ceil(videoDuration);
}

export function shouldWriteMeasuredDuration(
  measuredSeconds: number,
  storedSeconds: number | null | undefined
): boolean {
  if (storedSeconds == null || storedSeconds <= 0) return true;
  return measuredSeconds > storedSeconds;
}

export function useVersionDurationSync({
  videoDuration,
  activeVersionDuration,
  activeVersionId,
  propProjectId,
  videoId,
  setVideo,
}: UseVersionDurationSyncParams) {
  useEffect(() => {
    if (!activeVersionId || !propProjectId) return;
    const roundedDuration = measuredDurationSeconds(videoDuration);
    if (roundedDuration == null) return;
    if (!shouldWriteMeasuredDuration(roundedDuration, activeVersionDuration)) return;

    fetch(`/api/projects/${propProjectId}/videos/${videoId}/versions/${activeVersionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: roundedDuration }),
    }).catch(() => {
      // ignore save errors
    });

    setVideo((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        versions: prev.versions.map((v) =>
          v.id === activeVersionId ? { ...v, duration: roundedDuration } : v
        ),
      };
    });
  }, [videoDuration, activeVersionDuration, activeVersionId, propProjectId, videoId, setVideo]);
}
