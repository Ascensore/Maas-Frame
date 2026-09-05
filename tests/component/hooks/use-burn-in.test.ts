import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBurnIn } from '@/components/video-page/hooks/use-burn-in';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PROBE_URL = '/api/videos/video-1/burn-in?versionId=version-1';

describe('useBurnIn', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderBurnIn(onDone?: () => void, versionId: string | null = 'version-1') {
    return renderHook(
      (props: { versionId: string | null }) =>
        useBurnIn({ videoId: 'video-1', versionId: props.versionId, onDone }),
      { initialProps: { versionId } }
    );
  }

  /** Every GET the hook made, in order. */
  function gets() {
    return fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method !== 'POST'
    );
  }

  function posts() {
    return fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST'
    );
  }

  it('start posts the style and begins polling', async () => {
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ data: { job: { id: 'job-1', status: 'PENDING' } } }, 202);
      }
      return jsonResponse({ data: { job: null } });
    });

    const { result } = renderBurnIn();
    // Let the mount probe settle so the POST below is the only thing asserted on.
    await act(async () => {
      await Promise.resolve();
    });

    let error: string | null = 'unset';
    await act(async () => {
      error = await result.current.start({ fontSize: 56 });
    });

    expect(error).toBeNull();
    expect(posts()).toHaveLength(1);
    expect(String(posts()[0][0])).toBe('/api/videos/video-1/burn-in');
    expect((posts()[0][1] as RequestInit).body).toBe(
      JSON.stringify({ versionId: 'version-1', style: { fontSize: 56 } })
    );
    expect(result.current.job).toEqual({ id: 'job-1', status: 'PENDING' });
    expect(result.current.isRunning).toBe(true);
    expect(result.current.starting).toBe(false);
  });

  it('polls every four seconds until the job succeeds, then calls onDone once', async () => {
    vi.useFakeTimers();
    const statuses = ['RUNNING', 'SUCCEEDED'];
    let probed = false;
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ data: { job: { id: 'job-1', status: 'PENDING' } } }, 202);
      }
      if (!probed) {
        probed = true;
        return jsonResponse({ data: { job: null } });
      }
      const status = statuses.shift() ?? 'SUCCEEDED';
      return jsonResponse({ data: { job: { id: 'job-1', status, error: null } } });
    });

    const onDone = vi.fn();
    const { result } = renderBurnIn(onDone);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await result.current.start({});
    });
    expect(result.current.isRunning).toBe(true);

    const afterStart = gets().length;
    // Nothing until the interval fires: a start does not double as a poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3999);
    });
    expect(gets()).toHaveLength(afterStart);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(gets()).toHaveLength(afterStart + 1);
    expect(result.current.job?.status).toBe('RUNNING');
    expect(result.current.isRunning).toBe(true);
    expect(onDone).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(result.current.job?.status).toBe('SUCCEEDED');
    expect(result.current.isRunning).toBe(false);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();

    // The interval is gone: a finished job is not polled forever, and onDone
    // does not fire a second time.
    const settled = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(fetchMock.mock.calls).toHaveLength(settled);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('surfaces the job error on FAILED and the API error on a refused start', async () => {
    vi.useFakeTimers();
    let probed = false;
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ data: { job: { id: 'job-1', status: 'PENDING' } } }, 202);
      }
      if (!probed) {
        probed = true;
        return jsonResponse({ data: { job: null } });
      }
      return jsonResponse({
        data: { job: { id: 'job-1', status: 'FAILED', error: 'ffmpeg exited with 1' } },
      });
    });

    const onDone = vi.fn();
    const failing = renderBurnIn(onDone);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await failing.result.current.start({});
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(failing.result.current.error).toBe('ffmpeg exited with 1');
    expect(failing.result.current.isRunning).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
    failing.unmount();

    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ error: 'A burn-in is already running for this version' }, 409);
      }
      return jsonResponse({ data: { job: null } });
    });

    const refused = renderBurnIn();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    let message: string | null = null;
    await act(async () => {
      message = await refused.result.current.start({ fontSize: 48 });
    });

    expect(message).toBe('A burn-in is already running for this version');
    expect(refused.result.current.error).toBe('A burn-in is already running for this version');
    expect(refused.result.current.job).toBeNull();
    expect(refused.result.current.isRunning).toBe(false);
    expect(refused.result.current.starting).toBe(false);
  });

  it('adopts a job that is already running for the version', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes('version-2')
        ? // The newest job for this version has already finished: nothing to follow.
          jsonResponse({ data: { job: { id: 'job-old', status: 'SUCCEEDED', error: null } } })
        : jsonResponse({ data: { job: { id: 'job-9', status: 'RUNNING', error: null } } })
    );

    const onDone = vi.fn();
    const { result, rerender } = renderBurnIn(onDone);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(gets()).toHaveLength(1);
    expect(String(gets()[0][0])).toBe(PROBE_URL);
    expect(result.current.job).toEqual({ id: 'job-9', status: 'RUNNING', error: null });
    expect(result.current.isRunning).toBe(true);
    // Adopting is not a special case: the same interval follows the job home.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(gets()).toHaveLength(2);

    // Pointing the hook at another version probes once and adopts nothing,
    // because that version's newest burn-in is over.
    rerender({ versionId: 'version-2' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const afterSwitch = gets().length;
    expect(String(gets()[afterSwitch - 1][0])).toBe(
      '/api/videos/video-1/burn-in?versionId=version-2'
    );
    expect(result.current.job).toBeNull();
    expect(result.current.isRunning).toBe(false);
    expect(onDone).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(gets()).toHaveLength(afterSwitch);
  });

  it('answers a start with no version without touching the network', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { job: null } }));

    const { result } = renderBurnIn(undefined, null);
    await act(async () => {
      await Promise.resolve();
    });

    let message: string | null = null;
    await act(async () => {
      message = await result.current.start({});
    });

    expect(message).toBe('No version selected');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
