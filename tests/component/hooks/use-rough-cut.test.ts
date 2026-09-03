import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRoughCut, ROUGH_CUT_POLL_MS } from '@/components/video-page/hooks/use-rough-cut';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function roughCutPayload(status: string, id = 'cut-1') {
  return {
    data: {
      roughCut: {
        id,
        status,
        projectId: 'proj-1',
        folderId: null,
        profileId: null,
        requestedById: 'user-1',
        warnings: null,
        error: status === 'FAILED' ? 'sync failed' : null,
        hasDecisions: status === 'READY',
        createdAt: '2026-09-03T00:00:00.000Z',
        updatedAt: '2026-09-03T00:00:00.000Z',
      },
      cameras: [
        {
          videoId: 'v-a',
          versionId: 'ver-a',
          title: 'Cam A',
          role: 'A',
          providerId: 'r2',
          fileBacked: true,
        },
      ],
    },
  };
}

describe('useRoughCut', () => {
  const fetchMock = vi.fn();
  const downloadNamedFile = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    downloadNamedFile.mockReset();
    downloadNamedFile.mockResolvedValue(true);
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('POSTs a generate request and polls until READY, then stops', async () => {
    let status = 'PENDING';
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects/proj-1/rough-cuts' && init?.method === 'POST') {
        return jsonResponse(roughCutPayload('PENDING'), 201);
      }
      if (url === '/api/rough-cuts/cut-1') {
        return jsonResponse(roughCutPayload(status));
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const { result } = renderHook(() => useRoughCut());

    let startError: string | null = 'unset';
    await act(async () => {
      startError = await result.current.start({ projectId: 'proj-1', folderId: null });
    });
    expect(startError).toBeNull();
    expect(result.current.roughCut?.status).toBe('PENDING');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/proj-1/rough-cuts',
      expect.objectContaining({ method: 'POST' })
    );

    const callsAfterStart = fetchMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(ROUGH_CUT_POLL_MS - 1);
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterStart);

    status = 'READY';
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(result.current.roughCut?.status).toBe('READY');

    const callsAfterReady = fetchMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(ROUGH_CUT_POLL_MS * 2);
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterReady);
  });

  it('stops polling when the cut fails', async () => {
    let status = 'RUNNING';
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse(roughCutPayload('RUNNING'), 201);
      return jsonResponse(roughCutPayload(status));
    });

    const { result } = renderHook(() => useRoughCut());
    await act(async () => {
      await result.current.start({ projectId: 'proj-1', folderId: 'folder-1' });
    });

    status = 'FAILED';
    await act(async () => {
      vi.advanceTimersByTime(ROUGH_CUT_POLL_MS);
      await Promise.resolve();
    });
    expect(result.current.roughCut?.status).toBe('FAILED');

    const callsAfterFailed = fetchMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(ROUGH_CUT_POLL_MS * 2);
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterFailed);
  });

  it('does not leak an interval after unmount', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse(roughCutPayload('PENDING'), 201);
      return jsonResponse(roughCutPayload('PENDING'));
    });

    const { result, unmount } = renderHook(() => useRoughCut());
    await act(async () => {
      await result.current.start({ projectId: 'proj-1', folderId: null });
    });
    const callsBeforeUnmount = fetchMock.mock.calls.length;
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(ROUGH_CUT_POLL_MS * 3);
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBe(callsBeforeUnmount);
  });
});
