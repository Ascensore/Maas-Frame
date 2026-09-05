import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  resolveEditableSegment,
  useTranscriptSegmentEdit,
} from '@/components/video-page/hooks/use-transcript-segment-edit';
import type { SegmentEditResult } from '@/components/video-page/hooks/use-transcript-segment-edit';
import type { TranscriptSegment } from '@/components/video-page/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SAVED_SEGMENT: TranscriptSegment = {
  id: 'segment-1',
  startSec: 1,
  endSec: 3,
  speaker: 'Tom',
  text: 'we help founders',
  words: [
    { start: 1, end: 1.4, text: 'we' },
    { start: 1.5, end: 1.9, text: 'help' },
    { start: 2, end: 2.6, text: 'founders' },
  ],
  position: 0,
};

describe('resolveEditableSegment', () => {
  const source: TranscriptSegment = {
    ...SAVED_SEGMENT,
    text: 'kurucularla bulustuk',
    speaker: 'Tom',
  };
  /** What the English overlay renders: same id, translated text, no words. */
  const overlaid: TranscriptSegment = {
    ...source,
    text: 'we met founders',
    speaker: null,
    words: [],
  };

  it('answers with the stored row behind a translated one', () => {
    // Without this the editor opens on 'we met founders' and Save writes the
    // English translation over the Turkish line it came from.
    expect(resolveEditableSegment(overlaid, [source])).toBe(source);
  });

  it('falls back to the row it was given when the source is gone', () => {
    expect(resolveEditableSegment(overlaid, [])).toBe(overlaid);
    expect(resolveEditableSegment(overlaid, undefined)).toBe(overlaid);
  });

  it('matches on id, not on position or text', () => {
    const other: TranscriptSegment = { ...source, id: 'segment-2', text: 'another line' };
    expect(resolveEditableSegment(overlaid, [other, source])).toBe(source);
  });
});

describe('useTranscriptSegmentEdit', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PATCHes the segment route and returns the saved line with the caption outcome', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { segment: SAVED_SEGMENT, captions: 'updated' } })
    );

    const { result } = renderHook(() => useTranscriptSegmentEdit('version-1'));

    let saved: SegmentEditResult | null = null;
    await act(async () => {
      saved = await result.current.save('segment-1', { text: 'we help founders', speaker: 'Tom' });
    });

    expect(saved).toEqual({ segment: SAVED_SEGMENT, captions: 'updated' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/versions/version-1/transcript/segments/segment-1');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ text: 'we help founders', speaker: 'Tom' }));
    expect(result.current.error).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  it('surfaces the API error and returns null', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'text: Too small' }, 400));

    const { result } = renderHook(() => useTranscriptSegmentEdit('version-1'));

    let saved: SegmentEditResult | null = { segment: SAVED_SEGMENT, captions: 'updated' };
    await act(async () => {
      saved = await result.current.save('segment-1', { text: '   ' });
    });

    expect(saved).toBeNull();
    expect(result.current.error).toBe('text: Too small');
    expect(result.current.saving).toBe(false);

    act(() => {
      result.current.clearError();
    });
    expect(result.current.error).toBeNull();
  });

  it('returns null without fetching when there is no version', async () => {
    const { result } = renderHook(() => useTranscriptSegmentEdit(null));

    let saved: SegmentEditResult | null = { segment: SAVED_SEGMENT, captions: 'updated' };
    await act(async () => {
      saved = await result.current.save('segment-1', { text: 'we help founders' });
    });

    expect(saved).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a caption outcome the route could not deliver', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { segment: SAVED_SEGMENT, captions: 'failed' } })
    );

    const { result } = renderHook(() => useTranscriptSegmentEdit('version-1'));

    let saved: SegmentEditResult | null = null;
    await act(async () => {
      saved = await result.current.save('segment-1', { text: 'we help founders' });
    });

    // The line saved; the subtitles are behind. The caller has to be able to
    // tell those apart, so this is not folded into the error path.
    expect(saved).toEqual({ segment: SAVED_SEGMENT, captions: 'failed' });
    expect(result.current.error).toBeNull();
  });

  it('treats an unrecognised caption outcome as not rebuilt', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { segment: SAVED_SEGMENT, captions: 'who knows' } })
    );

    const { result } = renderHook(() => useTranscriptSegmentEdit('version-1'));

    let saved: SegmentEditResult | null = null;
    await act(async () => {
      saved = await result.current.save('segment-1', { text: 'we help founders' });
    });

    expect(saved).toEqual({ segment: SAVED_SEGMENT, captions: 'failed' });
  });
});
