'use client';

import { useCallback, useMemo, useState } from 'react';
import type { TranscriptSegment } from '@/components/video-page/types';

export interface SegmentEditInput {
  text: string;
  speaker?: string | null;
}

/**
 * The stored row behind a row the pane is displaying.
 *
 * The pane can be showing the English overlay, whose rows carry the same ids as
 * the transcript but translated text. An edit is written to the stored line, so
 * the editor has to be filled from the source row: filling it from what is on
 * screen would save the translation over the original. The pencil is also
 * disabled while the overlay is on, which makes this the second of two guards —
 * and the one that still holds if the first is ever loosened.
 */
export function resolveEditableSegment(
  segment: TranscriptSegment,
  sourceSegments: TranscriptSegment[] | undefined
): TranscriptSegment {
  return sourceSegments?.find((row) => row.id === segment.id) ?? segment;
}

/** What the route rebuilt, or why it did not. */
export type CaptionOutcome = 'updated' | 'skipped' | 'empty' | 'failed';

export interface SegmentEditResult {
  segment: TranscriptSegment;
  captions: CaptionOutcome;
}

/**
 * Saves one corrected transcript line. The route decides how the words are
 * retimed and rebuilds the caption track; the caller gets the saved line to
 * swap in and the caption outcome, which is what tells it whether the player's
 * track list is now stale or whether the subtitles are simply behind.
 */
export function useTranscriptSegmentEdit(versionId: string | null) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const save = useCallback(
    async (segmentId: string, input: SegmentEditInput): Promise<SegmentEditResult | null> => {
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
        const data = (
          payload as { data?: { segment?: TranscriptSegment; captions?: unknown } } | null
        )?.data;
        const segment = data?.segment;
        if (!segment) {
          setError('Failed to save the line');
          return null;
        }
        // An unrecognised value is treated as "not rebuilt", so a caller that
        // trusts 'updated' never skips a refresh it needed.
        const captions: CaptionOutcome =
          data?.captions === 'updated' || data?.captions === 'skipped' || data?.captions === 'empty'
            ? data.captions
            : 'failed';
        return { segment, captions };
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
