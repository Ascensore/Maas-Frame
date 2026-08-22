import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import { useDownloadActions } from '@/components/video-page/hooks/use-download-actions';
import type { Comment, Version, VideoData } from '@/components/video-page/types';

const toastError = vi.fn();
const toastCustom = vi.fn();
const toastDismiss = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    custom: (...args: unknown[]) => toastCustom(...args),
    dismiss: (...args: unknown[]) => toastDismiss(...args),
  },
}));

type Params = Parameters<typeof useDownloadActions>[0];

const VERSION_ID = 'ver1';
const BUNNY_HOST = 'cdn.example.test';
const ALLOWED_DIRECT_HOST = 'files.example.test';
/** Just over the 10 GiB ceiling in lib/client/download-file.ts. */
const OVERSIZED_BYTES = String(11 * 1024 * 1024 * 1024);

function makeVersion(overrides: Partial<Version> = {}): Version & { comments: Comment[] } {
  return {
    id: VERSION_ID,
    versionNumber: 1,
    versionLabel: null,
    providerId: 'bunny',
    videoId: 'vid1',
    originalUrl: `https://${BUNNY_HOST}/abc/play.mp4`,
    title: null,
    thumbnailUrl: null,
    duration: 600,
    isActive: true,
    _count: { comments: 0 },
    comments: [],
    ...overrides,
  };
}

function makeVideo(overrides: Partial<VideoData> = {}): VideoData {
  return {
    id: 'vid1',
    title: 'Cut 3',
    description: null,
    projectId: 'proj1',
    project: { name: 'Ad campaign', ownerId: 'user1' },
    versions: [],
    isAuthenticated: true,
    currentUserId: 'user1',
    currentUserName: 'Ada',
    canDownload: true,
    ...overrides,
  };
}

interface FileResponseInit {
  ok?: boolean;
  contentLength?: string | null;
  contentType?: string | null;
}

/** What the CDN answers when the bytes are pulled for renaming. */
function fileResponse({
  ok = true,
  contentLength = '2048',
  contentType = 'video/mp4',
}: FileResponseInit = {}) {
  return {
    ok,
    status: ok ? 200 : 502,
    headers: {
      get: (name: string) => {
        if (name === 'content-length') return contentLength;
        if (name === 'content-type') return contentType;
        return null;
      },
    },
    // Null body sends downloadNamedFile down its res.blob() path, which is what
    // a jsdom fetch mock can honestly represent.
    body: null,
    blob: () => Promise.resolve(new Blob(['bytes'])),
    json: () => Promise.reject(new SyntaxError('not json')),
  };
}

function prepareResponse(ok: boolean, payload: unknown = {}) {
  return {
    ok,
    status: ok ? 200 : 404,
    headers: { get: () => null },
    json: () => Promise.resolve(payload),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let fetchMock: ReturnType<typeof vi.fn>;
let clicked: { href: string; download: string }[];
/** The response the byte-pulling fetch answers with; reassign per test. */
let downloadResponse: ReturnType<typeof fileResponse>;

type Harness = RenderHookResult<ReturnType<typeof useDownloadActions>, Params>;

function renderDownload(overrides: Partial<Params> = {}): Harness {
  const initialProps: Params = {
    activeVersion: makeVersion(),
    video: makeVideo(),
    ...overrides,
  };
  return renderHook((props: Params) => useDownloadActions(props), { initialProps });
}

function urlsFetched(): string[] {
  return fetchMock.mock.calls.map((call) => call[0] as string);
}

beforeEach(() => {
  // The runtime resolver reads BUNNY_CDN_URL first, so pin it rather than
  // inheriting the value a developer has in .env.
  vi.stubEnv('BUNNY_CDN_URL', undefined);
  vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', `https://${BUNNY_HOST}`);
  vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', ALLOWED_DIRECT_HOST);
  clicked = [];
  downloadResponse = fileResponse();
  fetchMock = vi.fn((url: string) => {
    if (typeof url === 'string' && url.includes('prepare=1')) {
      return Promise.resolve(prepareResponse(true, { data: {} }));
    }
    return Promise.resolve(downloadResponse);
  });
  vi.stubGlobal('fetch', fetchMock);
  // jsdom would try to navigate on a real anchor click. Record the anchor
  // instead: its href and download attribute are the whole observable result.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push({ href: this.getAttribute('href') ?? '', download: this.download });
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toastError.mockReset();
  toastCustom.mockReset();
  toastDismiss.mockReset();
});

describe('useDownloadActions refusing to start', () => {
  it('does nothing before a version is loaded', async () => {
    const harness = renderDownload({ activeVersion: undefined });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('does nothing before the video is loaded', async () => {
    const harness = renderDownload({ video: null });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when the share link has downloads switched off', async () => {
    const harness = renderDownload({ video: makeVideo({ canDownload: false }) });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(toastError).toHaveBeenCalledWith('Download is disabled for this shared link');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // canDownload is optional on VideoData, and the guard is a plain falsy check,
  // so a payload that never mentions the flag is treated as "no downloads".
  it('refuses when the payload never mentioned canDownload', async () => {
    const video = makeVideo();
    delete video.canDownload;
    const harness = renderDownload({ video });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(toastError).toHaveBeenCalledWith('Download is disabled for this shared link');
  });

  it('refuses a provider with no direct file behind it', async () => {
    const harness = renderDownload({
      activeVersion: makeVersion({ providerId: 'youtube', originalUrl: 'https://youtu.be/abc' }),
    });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(toastError).toHaveBeenCalledWith('This video source does not support direct download');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.result.current.activeDownloadTarget).toBeNull();
  });
});

describe('useDownloadActions from Bunny', () => {
  it('asks the route to prepare the file before pulling it', async () => {
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload('compressed');
    });

    expect(urlsFetched()).toEqual([
      `/api/versions/${VERSION_ID}/download?source=compressed&prepare=1`,
      `/api/versions/${VERSION_ID}/download?source=compressed`,
    ]);
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: 'no-store' });
    expect(clicked).toEqual([{ href: 'blob:openframe-test', download: 'Cut 3 v1.mp4' }]);
  });

  it('carries the original preference through both requests', async () => {
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload('original');
    });

    expect(urlsFetched()).toEqual([
      `/api/versions/${VERSION_ID}/download?source=original&prepare=1`,
      `/api/versions/${VERSION_ID}/download?source=original`,
    ]);
  });

  it('defaults to the compressed file when no preference is given', async () => {
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(urlsFetched()[0]).toContain('source=compressed');
  });

  it('reports which file it is fetching while the download runs', async () => {
    const pending = deferred<unknown>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const harness = renderDownload();

    let started: Promise<void> | undefined;
    act(() => {
      started = harness.result.current.startDownload('original');
    });

    expect(harness.result.current.activeDownloadTarget).toBe('original');
    expect(harness.result.current.isDownloadingVideo).toBe(true);

    await act(async () => {
      pending.resolve(prepareResponse(true, { data: {} }));
      await started;
    });

    expect(harness.result.current.activeDownloadTarget).toBeNull();
    expect(harness.result.current.isDownloadingVideo).toBe(false);
  });

  it('shows the message the route sent when the file is not ready', async () => {
    fetchMock.mockResolvedValueOnce(
      prepareResponse(false, { error: 'Original file is still processing' })
    );
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload('original');
    });

    expect(toastError).toHaveBeenCalledWith('Original file is still processing');
    expect(clicked).toEqual([]);
    expect(harness.result.current.activeDownloadTarget).toBeNull();
  });

  it('names the missing original when the failure body says nothing', async () => {
    fetchMock.mockResolvedValueOnce(prepareResponse(false, {}));
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload('original');
    });

    expect(toastError).toHaveBeenCalledWith('Original file is not available for this video');
  });

  it('names the missing compressed file when the failure body says nothing', async () => {
    fetchMock.mockResolvedValueOnce(prepareResponse(false, {}));
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload('compressed');
    });

    expect(toastError).toHaveBeenCalledWith('Compressed file is not available for this video');
  });

  it('clears the progress panel before showing the error', async () => {
    fetchMock.mockResolvedValueOnce(prepareResponse(false, { error: 'Nope' }));
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload();
    });

    // The prepare step fails before the panel is opened, so nothing to dismiss.
    expect(toastCustom).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Nope');
  });

  it('opens a progress panel and leaves a success message behind', async () => {
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload();
    });

    // One render for the initial panel, more as progress and success arrive.
    expect(toastCustom).toHaveBeenCalled();
    expect(toastCustom.mock.calls[0][1]).toMatchObject({ id: `download-${VERSION_ID}` });
    expect(toastDismiss).not.toHaveBeenCalled();
  });

  it('falls back to a plain navigation for a file too large to rename', async () => {
    downloadResponse = fileResponse({ contentLength: OVERSIZED_BYTES });
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(toastDismiss).toHaveBeenCalledWith(`download-${VERSION_ID}`);
    // Cross-origin, so no download attribute: the CDN picks the filename.
    expect(clicked).toEqual([
      { href: `/api/versions/${VERSION_ID}/download?source=compressed`, download: '' },
    ]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('falls back to a plain navigation when the CDN refuses the byte request', async () => {
    downloadResponse = fileResponse({ ok: false });
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('');
    expect(toastDismiss).toHaveBeenCalledWith(`download-${VERSION_ID}`);
  });
});

describe('useDownloadActions naming the file', () => {
  it('uses the version label when the editor set one', async () => {
    const harness = renderDownload({
      activeVersion: makeVersion({ versionLabel: '  Client cut  ', versionNumber: 4 }),
    });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(clicked[0].download).toBe('Cut 3 Client cut.mp4');
  });

  it('falls back to the version number when there is no label', async () => {
    const harness = renderDownload({ activeVersion: makeVersion({ versionNumber: 7 }) });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(clicked[0].download).toBe('Cut 3 v7.mp4');
  });

  it('strips path separators and other characters a filesystem rejects', async () => {
    const harness = renderDownload({ video: makeVideo({ title: 'Q3/Q4: "final"  cut' }) });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(clicked[0].download).toBe('Q3-Q4- -final- cut v1.mp4');
  });

  // The `|| 'video'` fallback in the hook is unreachable in practice:
  // sanitising replaces forbidden characters with '-' instead of dropping them,
  // and the "v<number>" suffix survives any title. Pinned so that a rewrite of
  // sanitizeDownloadFileName has to decide about it deliberately.
  it('still produces a name when the title is nothing but separators', async () => {
    const harness = renderDownload({ video: makeVideo({ title: '///' }) });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(clicked[0].download).toBe('--- v1.mp4');
  });

  it('takes the extension from the content type the CDN reported', async () => {
    downloadResponse = fileResponse({ contentType: 'video/quicktime' });
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(clicked[0].download).toBe('Cut 3 v1.mov');
  });
});

describe('useDownloadActions from R2', () => {
  const r2Version = makeVersion({
    providerId: 'r2',
    originalUrl: '/api/upload/video/proj1/clip.webm',
  });

  it('navigates to the same-origin proxy with the download attribute set', async () => {
    const harness = renderDownload({ activeVersion: r2Version });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    // No prepare step and no byte pulling: the proxy streams it.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clicked).toEqual([
      { href: '/api/upload/video/proj1/clip.webm', download: 'Cut 3 v1.webm' },
    ]);
    expect(toastCustom).not.toHaveBeenCalled();
  });

  // The R2 branch never awaits, so the busy flag is set and cleared inside one
  // batch: the button never renders as downloading. That is correct here (the
  // browser takes over immediately) but it means the target is unobservable.
  it('never renders as busy because the R2 branch never awaits', async () => {
    const harness = renderDownload({ activeVersion: r2Version });

    let started: Promise<void> | undefined;
    act(() => {
      started = harness.result.current.startDownload('original');
    });

    expect(harness.result.current.activeDownloadTarget).toBeNull();
    expect(clicked).toHaveLength(1);

    await act(async () => {
      await started;
    });
  });

  it('defaults the extension to mp4 when the proxy path has none', async () => {
    const harness = renderDownload({
      activeVersion: makeVersion({ providerId: 'r2', originalUrl: '/api/upload/video/proj1/clip' }),
    });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(clicked[0].download).toBe('Cut 3 v1.mp4');
  });

  it('refuses an R2 version whose URL is not the media proxy', async () => {
    const harness = renderDownload({
      activeVersion: makeVersion({
        providerId: 'r2',
        originalUrl: 'https://evil.example.test/clip.mp4',
      }),
    });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(toastError).toHaveBeenCalledWith('This direct download host is not allowed');
    expect(clicked).toEqual([]);
  });
});

describe('useDownloadActions from a direct host', () => {
  function directVersion(url: string) {
    return makeVersion({ providerId: 'direct', originalUrl: url });
  }

  it('pulls the bytes from a host on the allow list', async () => {
    downloadResponse = fileResponse({ contentType: null });
    const harness = renderDownload({
      activeVersion: directVersion(`https://${ALLOWED_DIRECT_HOST}/clip.mov`),
    });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(urlsFetched()).toEqual([`https://${ALLOWED_DIRECT_HOST}/clip.mov`]);
    expect(clicked).toEqual([{ href: 'blob:openframe-test', download: 'Cut 3 v1.mov' }]);
  });

  it('accepts the Bunny CDN hostname without it being listed explicitly', async () => {
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', '');
    const harness = renderDownload({
      activeVersion: directVersion(`https://${BUNNY_HOST}/clip.mp4`),
    });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(toastError).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(1);
  });

  it('refuses a host that is not on the allow list', async () => {
    const harness = renderDownload({
      activeVersion: directVersion('https://evil.example.test/clip.mp4'),
    });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(toastError).toHaveBeenCalledWith('This direct download host is not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses every host when neither allow list is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_BUNNY_CDN_URL', '');
    vi.stubEnv('NEXT_PUBLIC_DIRECT_DOWNLOAD_ALLOWED_HOSTS', '');
    const harness = renderDownload({
      activeVersion: directVersion(`https://${ALLOWED_DIRECT_HOST}/clip.mp4`),
    });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(toastError).toHaveBeenCalledWith('This direct download host is not allowed');
  });

  it('refuses a non-http scheme even on an allowed host', async () => {
    const harness = renderDownload({
      activeVersion: directVersion(`javascript:alert(1)//${ALLOWED_DIRECT_HOST}`),
    });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(toastError).toHaveBeenCalledWith('This direct download host is not allowed');
    expect(clicked).toEqual([]);
  });

  it('refuses a URL that does not parse at all', async () => {
    const harness = renderDownload({ activeVersion: directVersion('not a url') });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(toastError).toHaveBeenCalledWith('This direct download host is not allowed');
  });

  it('matches the host case-insensitively', async () => {
    const harness = renderDownload({
      activeVersion: directVersion(`https://FILES.EXAMPLE.TEST/clip.mp4`),
    });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(toastError).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(1);
  });
});

describe('useDownloadActions repeated clicks', () => {
  it('ignores a second click once the button has re-rendered as busy', async () => {
    const pending = deferred<unknown>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const harness = renderDownload();

    let first: Promise<void> | undefined;
    act(() => {
      first = harness.result.current.startDownload();
    });
    expect(harness.result.current.isDownloadingVideo).toBe(true);

    await act(async () => {
      await harness.result.current.startDownload();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(prepareResponse(true, { data: {} }));
      await first;
    });
  });

  // The in-flight guard used to read `isDownloadingVideo` out of the closure the callback
  // was created in, so two calls made from the SAME render (a double click landing before
  // React commits the state update) both got through and the file was fetched twice. It
  // reads a ref now.
  it('refuses a second call from the same render', async () => {
    const startDownload = renderDownload().result.current.startDownload;

    await act(async () => {
      await Promise.all([startDownload(), startDownload()]);
    });

    expect(urlsFetched().filter((url) => url.includes('prepare=1'))).toHaveLength(1);
    expect(clicked).toHaveLength(1);
  });

  it('is ready to download again after a failure', async () => {
    fetchMock.mockResolvedValueOnce(prepareResponse(false, { error: 'Nope' }));
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload();
    });
    expect(harness.result.current.isDownloadingVideo).toBe(false);

    await act(async () => {
      await harness.result.current.startDownload();
    });
    expect(clicked).toHaveLength(1);
  });
});

describe('useDownloadActions guarding the tab', () => {
  function fireBeforeUnload(): BeforeUnloadEvent {
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);
    return event;
  }

  // Closing the tab used to throw away a half-pulled file without a word,
  // because the browser has no idea a fetch-driven download is running.
  it('warns before the tab closes while the bytes are being pulled', async () => {
    const pending = deferred<unknown>();
    const harness = renderDownload();
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('prepare=1')) {
        return Promise.resolve(prepareResponse(true, { data: {} }));
      }
      return pending.promise;
    });

    let started: Promise<void> | undefined;
    await act(async () => {
      started = harness.result.current.startDownload();
      // Let the prepare call settle so the byte fetch is the pending one.
      await Promise.resolve();
    });

    expect(fireBeforeUnload().defaultPrevented).toBe(true);

    await act(async () => {
      pending.resolve(fileResponse());
      await started;
    });

    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('releases the guard when the download fails', async () => {
    downloadResponse = fileResponse({ ok: false });
    const harness = renderDownload();

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  // A same-origin proxy download is handed to the browser, which keeps going
  // after the tab closes, so nothing should block the unload there.
  it('does not warn for a browser-owned download', async () => {
    const harness = renderDownload({
      activeVersion: makeVersion({
        providerId: 'r2',
        originalUrl: '/api/upload/video/abc.mp4',
      }),
    });

    await act(async () => {
      await harness.result.current.startDownload();
    });

    expect(clicked).toHaveLength(1);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });
});
