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
const LOST = 'Lost track of the burn-in. Refresh the page to check again.';
/** The hook's own interval and give-up count, written by hand as the contract. */
const POLL_MS = 4000;
const GIVE_UP_AFTER = 20;

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

  type Props = { versionId: string | null; enabled: boolean };

  function renderBurnIn(
    onDone?: () => void,
    initialProps: Props = { versionId: 'version-1', enabled: true }
  ) {
    return renderHook(
      (props: Props) =>
        useBurnIn({
          videoId: 'video-1',
          versionId: props.versionId,
          enabled: props.enabled,
          onDone,
        }),
      { initialProps }
    );
  }

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

  /** A fetch stub whose mount probe answers "nothing running" and whose POST succeeds. */
  function queueOnPost(job: unknown = { id: 'job-1', status: 'PENDING' }) {
    let probed = false;
    return (statusBody: () => unknown) => {
      fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') return jsonResponse({ data: { job } }, 202);
        if (!probed) {
          probed = true;
          return jsonResponse({ data: { job: null } });
        }
        return statusBody() as Response;
      });
    };
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

  it('names the caption track when one was picked, and omits it otherwise', async () => {
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ data: { job: { id: 'job-1', status: 'PENDING' } } }, 202);
      }
      return jsonResponse({ data: { job: null } });
    });

    const { result } = renderBurnIn();
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.start({ bold: false }, 'track-1');
    });
    expect((posts()[0][1] as RequestInit).body).toBe(
      JSON.stringify({ versionId: 'version-1', style: { bold: false }, subtitleId: 'track-1' })
    );

    await act(async () => {
      await result.current.start({ bold: false });
    });
    // No `subtitleId` key at all: the route reads that as "use the transcript",
    // and an explicit undefined would not survive JSON.stringify anyway.
    expect((posts()[1][1] as RequestInit).body).toBe(
      JSON.stringify({ versionId: 'version-1', style: { bold: false } })
    );
  });

  it('polls every four seconds until the job succeeds, then calls onDone once', async () => {
    vi.useFakeTimers();
    const statuses = ['RUNNING', 'SUCCEEDED'];
    queueOnPost()(() =>
      jsonResponse({
        data: { job: { id: 'job-1', status: statuses.shift() ?? 'SUCCEEDED', error: null } },
      })
    );

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
      await vi.advanceTimersByTimeAsync(POLL_MS - 1);
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
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.job?.status).toBe('SUCCEEDED');
    expect(result.current.isRunning).toBe(false);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();

    // The interval is gone: a finished job is not polled forever, and onDone
    // does not fire a second time.
    const settled = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    });
    expect(fetchMock.mock.calls).toHaveLength(settled);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('surfaces the job error on FAILED and the API error on a refused start', async () => {
    vi.useFakeTimers();
    queueOnPost()(() =>
      jsonResponse({
        data: { job: { id: 'job-1', status: 'FAILED', error: 'ffmpeg exited with 1' } },
      })
    );

    const onDone = vi.fn();
    const failing = renderBurnIn(onDone);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await failing.result.current.start({});
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    // A job that died after the dialog closed has nobody else to report it.
    expect(failing.result.current.error).toBe('ffmpeg exited with 1');
    expect(failing.result.current.isRunning).toBe(false);
    expect(onDone).not.toHaveBeenCalled();

    // Asking for another one puts that failure behind us.
    await act(async () => {
      await failing.result.current.start({});
    });
    expect(failing.result.current.error).toBeNull();
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
    // Returned, never stored: the dialog that asked shows it inline, and
    // storing it too is how one refusal became two messages on screen.
    expect(refused.result.current.error).toBeNull();
    expect(refused.result.current.job).toBeNull();
    expect(refused.result.current.isRunning).toBe(false);
    expect(refused.result.current.starting).toBe(false);
  });

  it('adopts a job that is already running for the version', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes('version-2')
        ? // The newest job for this version has already finished, and this
          // session never followed it: nothing to adopt and nothing to say.
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
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(gets()).toHaveLength(2);

    // Pointing the hook at another version probes once and adopts nothing,
    // because that version's newest burn-in is over.
    rerender({ versionId: 'version-2', enabled: true });
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
      await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    });
    expect(gets()).toHaveLength(afterSwitch);
  });

  it('announces a burn that finished while the operator was on another version', async () => {
    vi.useFakeTimers();
    const newest: Record<string, unknown> = {
      'version-1': { id: 'job-1', status: 'RUNNING', error: null },
      'version-2': null,
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      jsonResponse({
        data: { job: newest[String(input).includes('version-2') ? 'version-2' : 'version-1'] },
      })
    );

    const onDone = vi.fn();
    const { result, rerender } = renderBurnIn(onDone);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.isRunning).toBe(true);

    // Away to another version while it renders.
    rerender({ versionId: 'version-2', enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onDone).not.toHaveBeenCalled();

    // It finished in the meantime; coming back is when they find out.
    newest['version-1'] = { id: 'job-1', status: 'SUCCEEDED', error: null };
    rerender({ versionId: 'version-1', enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.current.isRunning).toBe(false);

    // And not once more on every later visit to the same version.
    rerender({ versionId: 'version-2', enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    rerender({ versionId: 'version-1', enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('does not let a slow probe overwrite the job the operator just started', async () => {
    let releaseProbe: () => void = () => {};
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ data: { job: { id: 'job-new', status: 'PENDING' } } }, 202);
      }
      await probeGate;
      // A stale read: the mount probe was issued before the POST existed.
      return jsonResponse({ data: { job: { id: 'job-old', status: 'RUNNING', error: null } } });
    });

    const { result } = renderBurnIn();
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.start({});
    });
    expect(result.current.job).toEqual({ id: 'job-new', status: 'PENDING' });

    await act(async () => {
      releaseProbe();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.job).toEqual({ id: 'job-new', status: 'PENDING' });
    expect(result.current.isRunning).toBe(true);
  });

  it('does not stack polls when a status request outlives the interval', async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    queueOnPost()(() => {
      inFlight += 1;
      // Never settles, the way a request does behind a stalled proxy.
      return new Promise<Response>(() => {}) as unknown as Response;
    });

    const { result } = renderBurnIn();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await result.current.start({});
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    });
    expect(inFlight).toBe(1);
  });

  it('stops polling and says so after twenty failed status requests', async () => {
    vi.useFakeTimers();
    queueOnPost()(() => jsonResponse({ error: 'bad gateway' }, 502));

    const { result } = renderBurnIn();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await result.current.start({});
    });

    const before = gets().length;
    // One short of the ceiling: a redeploy is allowed to eat a few polls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * (GIVE_UP_AFTER - 1));
    });
    expect(gets()).toHaveLength(before + GIVE_UP_AFTER - 1);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.error).toBe(LOST);

    const settled = gets().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    });
    expect(gets()).toHaveLength(settled);
  });

  it('touches the network for nobody who is not allowed to burn', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { job: null } }));

    const { result } = renderBurnIn(undefined, { versionId: 'version-1', enabled: false });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();

    let message: string | null = null;
    await act(async () => {
      message = await result.current.start({});
    });

    expect(message).toBe('Burn-in is not available');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.job).toBeNull();
  });

  it('answers a start with no version without touching the network', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { job: null } }));

    const { result } = renderBurnIn(undefined, { versionId: null, enabled: true });
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
