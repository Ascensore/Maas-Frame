import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useRoughCut,
  useRoughCutHistory,
  ROUGH_CUT_POLL_MS,
} from '@/components/video-page/hooks/use-rough-cut';

const downloadNamedFile = vi.hoisted(() => vi.fn());

vi.mock('@/lib/client/download-file', () => ({
  downloadNamedFile: (...args: unknown[]) => downloadNamedFile(...args),
}));

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
        outputVideoId: null,
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
    expect(result.current.cameras).toEqual([
      expect.objectContaining({ role: 'A', versionId: 'ver-a' }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/proj-1/rough-cuts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ folderId: null }),
      })
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
      const url = String(input);
      if (url === '/api/projects/proj-1/rough-cuts' && init?.method === 'POST') {
        return jsonResponse(roughCutPayload('RUNNING'), 201);
      }
      if (url === '/api/rough-cuts/cut-1') {
        return jsonResponse(roughCutPayload(status));
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const { result } = renderHook(() => useRoughCut());
    await act(async () => {
      await result.current.start({ projectId: 'proj-1', folderId: 'folder-1' });
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/proj-1/rough-cuts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ folderId: 'folder-1' }),
      })
    );

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
      const url = String(input);
      if (url === '/api/projects/proj-1/rough-cuts' && init?.method === 'POST') {
        return jsonResponse(roughCutPayload('PENDING'), 201);
      }
      if (url === '/api/rough-cuts/cut-1') {
        return jsonResponse(roughCutPayload('PENDING'));
      }
      return jsonResponse({ error: 'unexpected' }, 500);
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

  it('downloads through downloadNamedFile once READY', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects/proj-1/rough-cuts' && init?.method === 'POST') {
        return jsonResponse(roughCutPayload('READY'), 201);
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const { result } = renderHook(() => useRoughCut());
    await act(async () => {
      await result.current.start({ projectId: 'proj-1', folderId: null });
    });
    expect(result.current.roughCut?.status).toBe('READY');
    expect(result.current.cameras.map((camera) => camera.role)).toEqual(['A']);

    let downloadError: string | null = 'unset';
    await act(async () => {
      downloadError = await result.current.download('otio');
    });
    expect(downloadError).toBeNull();
    expect(downloadNamedFile).toHaveBeenCalledWith(
      '/api/rough-cuts/cut-1/download?format=otio',
      'rough-cut.otio'
    );
  });

  it('includes layout in the POST body when one is passed', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects/proj-1/rough-cuts' && init?.method === 'POST') {
        return jsonResponse(roughCutPayload('READY'), 201);
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const { result } = renderHook(() => useRoughCut());
    await act(async () => {
      await result.current.start({
        projectId: 'proj-1',
        folderId: null,
        layout: 'SEQUENTIAL',
      });
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/proj-1/rough-cuts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ folderId: null, layout: 'SEQUENTIAL' }),
      })
    );
  });

  it('includes profileId in the POST body when one is passed', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects/proj-1/rough-cuts' && init?.method === 'POST') {
        return jsonResponse(roughCutPayload('READY'), 201);
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const { result } = renderHook(() => useRoughCut());
    await act(async () => {
      await result.current.start({
        projectId: 'proj-1',
        folderId: null,
        profileId: 'profile-1',
      });
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/proj-1/rough-cuts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ folderId: null, profileId: 'profile-1' }),
      })
    );
  });

  it('includes the script in the POST body only when one is passed', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects/proj-1/rough-cuts' && init?.method === 'POST') {
        return jsonResponse(roughCutPayload('READY'), 201);
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const { result } = renderHook(() => useRoughCut());
    await act(async () => {
      await result.current.start({
        projectId: 'proj-1',
        folderId: null,
        script: 'Hello there.',
      });
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/projects/proj-1/rough-cuts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ folderId: null, script: 'Hello there.' }),
      })
    );

    await act(async () => {
      await result.current.start({ projectId: 'proj-1', folderId: null });
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/projects/proj-1/rough-cuts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ folderId: null }),
      })
    );
  });

  it('DELETEs the current cut on cancel and clears it', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects/proj-1/rough-cuts' && init?.method === 'POST') {
        return jsonResponse(roughCutPayload('PENDING'), 201);
      }
      if (url === '/api/rough-cuts/cut-1' && init?.method === 'DELETE') {
        return jsonResponse({ data: { deleted: true } });
      }
      if (url === '/api/rough-cuts/cut-1') {
        return jsonResponse(roughCutPayload('PENDING'));
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const { result } = renderHook(() => useRoughCut());
    await act(async () => {
      await result.current.start({ projectId: 'proj-1', folderId: null });
    });
    expect(result.current.roughCut?.id).toBe('cut-1');

    let cancelError: string | null = 'unset';
    await act(async () => {
      cancelError = await result.current.cancel();
    });
    expect(cancelError).toBeNull();
    expect(result.current.roughCut).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/rough-cuts/cut-1',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('does not flag a PENDING cut as waiting before 30s', async () => {
    vi.setSystemTime(new Date('2026-09-03T00:00:29.000Z'));
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects/proj-1/rough-cuts' && init?.method === 'POST') {
        return jsonResponse(roughCutPayload('PENDING'), 201);
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const { result } = renderHook(() => useRoughCut());
    await act(async () => {
      await result.current.start({ projectId: 'proj-1', folderId: null });
    });
    expect(result.current.roughCut?.status).toBe('PENDING');
    expect(result.current.waitingForWorker).toBe(false);
  });

  it('flags a PENDING cut as waiting for the worker after 30s', async () => {
    vi.setSystemTime(new Date('2026-09-03T00:00:30.000Z'));
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects/proj-1/rough-cuts' && init?.method === 'POST') {
        return jsonResponse(roughCutPayload('PENDING'), 201);
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const { result } = renderHook(() => useRoughCut());
    await act(async () => {
      await result.current.start({ projectId: 'proj-1', folderId: null });
    });
    expect(result.current.waitingForWorker).toBe(true);
  });
});

describe('useRoughCutHistory', () => {
  const fetchMock = vi.fn();

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
  });

  it('loads the folder list and DELETEs a cut on cancel', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        url.startsWith('/api/projects/proj-1/rough-cuts?folderId=root') &&
        init?.method !== 'POST'
      ) {
        return jsonResponse({ data: { roughCuts: [roughCutPayload('PENDING').data.roughCut] } });
      }
      if (url === '/api/rough-cuts/cut-1' && init?.method === 'DELETE') {
        return jsonResponse({ data: { deleted: true } });
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const { result } = renderHook(() => useRoughCutHistory('proj-1', null));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.cuts.map((cut) => cut.id)).toEqual(['cut-1']);
    expect(result.current.cuts[0]?.outputVideoId).toBeNull();

    await act(async () => {
      await result.current.cancel('cut-1');
    });
    expect(result.current.cuts).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/rough-cuts/cut-1',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('POSTs the chosen layout and prepends the new cut', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        url.startsWith('/api/projects/proj-1/rough-cuts?folderId=root') &&
        init?.method !== 'POST'
      ) {
        return jsonResponse({ data: { roughCuts: [] } });
      }
      if (url === '/api/projects/proj-1/rough-cuts' && init?.method === 'POST') {
        return jsonResponse(roughCutPayload('PENDING'), 201);
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const { result } = renderHook(() => useRoughCutHistory('proj-1', null));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.start('LINEAR');
    });
    expect(result.current.cuts[0]?.id).toBe('cut-1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/proj-1/rough-cuts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ folderId: null, layout: 'LINEAR' }),
      })
    );
  });
});
