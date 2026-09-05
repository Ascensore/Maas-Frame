'use client';

import { useCallback, useMemo, useState } from 'react';
import type { TranscriptSegment } from '@/components/video-page/types';

export interface SegmentEditInput {
  text: string;
  speaker?: string | null;
}

/**
 * Saves one corrected transcript line. The route decides how the words are
 * retimed and rebuilds the caption track, so the only thing left here is to hand
 * back the saved line for the pane to swap in.
 */
export function useTranscriptSegmentEdit(versionId: string | null) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const save = useCallback(
    async (segmentId: string, input: SegmentEditInput): Promise<TranscriptSegment | null> => {
      if (!versionId) return null;

      setSaving(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/versions/${versionId}/transcript/segments/${segmentId}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          }
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const message = (payload as { error?: unknown } | null)?.error;
          setError(typeof message === 'string' && message ? message : 'Failed to save the line');
          return null;
        }
        const segment = (payload as { data?: { segment?: TranscriptSegment } } | null)?.data
          ?.segment;
        if (!segment) {
          setError('Failed to save the line');
          return null;
        }
        return segment;
      } catch {
        setError('Failed to save the line');
        return null;
      } finally {
        setSaving(false);
      }
    },
    [versionId]
  );

  return useMemo(() => ({ save, saving, error, clearError }), [save, saving, error, clearError]);
}
