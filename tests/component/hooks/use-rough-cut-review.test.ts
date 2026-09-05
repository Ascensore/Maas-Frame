import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRoughCutReview } from '@/components/video-page/hooks/use-rough-cut-review';
import type { RoughCutDecisionList } from '@/lib/rough-cut/types';

/**
 * The hook's own polling interval, written by hand as the contract rather than
 * imported from it. Advancing the fake clock by the constant the hook reads
 * would follow any change to it, so a poll slowed to a minute would still pass
 * here; this way it goes red and someone decides whether that was intended.
 */
const POLL_MS = 4000;

const VIDEO_ID = 'vid-out';
const OTHER_VIDEO_ID = 'vid-two';
const REVIEW_URL = `/api/videos/${VIDEO_ID}/rough-cut`;
const OTHER_REVIEW_URL = `/api/videos/${OTHER_VIDEO_ID}/rough-cut`;
const OVERRIDES_URL = '/api/rough-cuts/cut-1/overrides';
const RENDER_URL = '/api/rough-cuts/cut-1/render';

/**
 * The island the run cut, keyed the way assembly keys one: 4-6s at 24 fps is
 * frames 96-144. Written out rather than derived, so a change to the key
 * convention shows up here as a failure instead of following along.
 */
const ISLAND_KEY = 'ver-a:96-144';

const EMPTY_DRAFT = { version: 1, cuts: {}, extraCuts: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A two-edit program on one clip: timeline 0-3 plays source 1-4, timeline 3-7
 * plays source 6-10, and the 4-6s island between them is what got cut.
 */
function decisions(): RoughCutDecisionList {
  return {
    version: 1,
    edits: [
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 3,
        inSeconds: 1,
        outSeconds: 4,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
      },
      {
        timelineStartSeconds: 3,
        timelineEndSeconds: 7,
        inSeconds: 6,
        outSeconds: 10,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
      },
    ],
    clips: [
      {
        versionId: 'ver-a',
        videoId: 'vid-a',
        role: 'A',
        offsetSeconds: 0,
        durationSeconds: 30,
        track: 1,
        fileName: 'cam-a.mp4',
        targetUrl: 'media/cam-a.mp4',
      },
    ],
    rate: { num: 24, den: 1, dropFrame: false },
    cuts: [
      {
        key: ISLAND_KEY,
        sourceVersionId: 'ver-a',
        inSeconds: 4,
        outSeconds: 6,
        reason: { code: 'DEAD_AIR', summary: 'Two seconds of silence' },
        transcriptText: 'um…',
      },
    ],
  };
}

function reviewFixture(overrides: Record<string, unknown> = {}) {
  const list = decisions();
  return {
    decisions: list,
    effective: list,
    applied: { restoredKeys: [], staleCutKeys: [], skippedIslands: [], extraCutsApplied: 0 },
    overrides: null,
    renderedOverrides: null,
    renderedDecisions: list,
    needsRender: false,
    script: null,
    sources: [
      {
        versionId: 'ver-a',
        videoId: 'vid-a',
        title: 'Cam A',
        role: 'A',
        offsetSeconds: 0,
        durationSeconds: 30,
        playbackUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
        playbackKind: 'file',
        missing: false,
      },
    ],
    render: { status: 'idle', error: null, updatedAt: null },
    ...overrides,
  };
}

function roughCutFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cut-1',
    status: 'READY',
    projectId: 'proj-1',
    folderId: null,
    profileId: null,
    requestedById: 'user-1',
    warnings: [],
    error: null,
    hasDecisions: true,
    outputVideoId: VIDEO_ID,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

function payload(
  reviewOverrides: Record<string, unknown> = {},
  roughCutOverrides: Record<string, unknown> = {}
) {
  return {
    data: {
      roughCut: roughCutFixture(roughCutOverrides),
      review: reviewFixture(reviewOverrides),
      canEdit: true,
    },
  };
}

describe('useRoughCutReview', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderReview(options: { videoId?: string; enabled?: boolean; onRendered?: () => void }) {
    return renderHook(() =>
      useRoughCutReview({
        videoId: options.videoId ?? VIDEO_ID,
        enabled: options.enabled ?? true,
        onRendered: options.onRendered,
      })
    );
  }

  it('loads the review for a rough-cut output and reports none for other videos', async () => {
    fetchMock.mockResolvedValue(jsonResponse(payload()));

    const { result } = renderReview({});
    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      REVIEW_URL,
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(result.current.review).toEqual(reviewFixture());
    expect(result.current.roughCut?.id).toBe('cut-1');
    expect(result.current.isRoughCutOutput).toBe(true);
    expect(result.current.canEdit).toBe(true);
    expect(result.current.sources).toHaveLength(1);
    expect(result.current.draft).toEqual(EMPTY_DRAFT);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.error).toBeNull();

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ data: { roughCut: null } }));
    const plain = renderReview({ videoId: 'vid-plain' });
    expect(plain.result.current.loading).toBe(true);
    await waitFor(() => {
      expect(plain.result.current.loading).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/videos/vid-plain/rough-cut',
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(plain.result.current.review).toBeNull();
    expect(plain.result.current.roughCut).toBeNull();
    expect(plain.result.current.isRoughCutOutput).toBe(false);

    // A commenter is served the row and no review at all; there is no pane to
    // show them, so the tab must stay away.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { roughCut: roughCutFixture(), review: null, canEdit: false } })
    );
    const viewer = renderReview({ videoId: 'vid-viewer' });
    await waitFor(() => {
      expect(viewer.result.current.roughCut?.id).toBe('cut-1');
    });
    expect(viewer.result.current.canEdit).toBe(false);
    expect(viewer.result.current.isRoughCutOutput).toBe(false);

    // Belt and braces: a review that arrives anyway without the permission to
    // act on it still opens no tab, because the pane it feeds only edits.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { roughCut: roughCutFixture(), review: reviewFixture(), canEdit: false },
      })
    );
    const readOnly = renderReview({ videoId: 'vid-read-only' });
    await waitFor(() => {
      expect(readOnly.result.current.review).not.toBeNull();
    });
    expect(readOnly.result.current.isRoughCutOutput).toBe(false);

    // A row the client cannot read is not a rough-cut output either.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { roughCut: { id: 'cut-1', status: 'WHAT' }, review: reviewFixture(), canEdit: true },
      })
    );
    const unreadable = renderReview({ videoId: 'vid-unreadable' });
    await waitFor(() => {
      expect(unreadable.result.current.review).not.toBeNull();
    });
    expect(unreadable.result.current.roughCut).toBeNull();
    expect(unreadable.result.current.isRoughCutOutput).toBe(false);

    fetchMock.mockReset();
    const disabled = renderReview({ enabled: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(disabled.result.current.loading).toBe(false);
    expect(disabled.result.current.isRoughCutOutput).toBe(false);
  });

  it('starts from the decisions already saved on the run', async () => {
    const saved = {
      version: 1,
      cuts: { [ISLAND_KEY]: 'keep' },
      extraCuts: [
        {
          key: 'manual:ver-a:72-96',
          sourceVersionId: 'ver-a',
          inSeconds: 3,
          outSeconds: 4,
          note: 'boring',
        },
      ],
    };
    fetchMock.mockResolvedValue(jsonResponse(payload({ overrides: saved })));

    const { result } = renderReview({});
    await waitFor(() => {
      expect(result.current.review).not.toBeNull();
    });

    expect(result.current.draft).toEqual(saved);
    expect(result.current.isDirty).toBe(false);
    // The extra cut takes material out, so the delivered file is out of date.
    expect(result.current.needsRender).toBe(true);
  });

  it('starts over when the page moves to another video', async () => {
    const savedOnSecond = { version: 1, cuts: { [ISLAND_KEY]: 'keep' }, extraCuts: [] };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === REVIEW_URL) return jsonResponse(payload());
      if (url === OTHER_REVIEW_URL) {
        return jsonResponse(payload({ overrides: savedOnSecond }, { id: 'cut-2' }));
      }
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });

    const onRendered = vi.fn();
    const { result, rerender } = renderHook(
      (props: { videoId: string }) =>
        useRoughCutReview({ videoId: props.videoId, enabled: true, onRendered }),
      { initialProps: { videoId: VIDEO_ID } }
    );
    await waitFor(() => {
      expect(result.current.roughCut?.id).toBe('cut-1');
    });

    act(() => {
      result.current.setCutAction(ISLAND_KEY, 'restore');
    });
    expect(result.current.isDirty).toBe(true);

    rerender({ videoId: OTHER_VIDEO_ID });
    await waitFor(() => {
      expect(result.current.roughCut?.id).toBe('cut-2');
    });

    // The second video's own saved decisions, not the first video's draft: a
    // Save here must not write what was pending on the video just left.
    expect(result.current.draft).toEqual(savedOnSecond);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.review?.overrides).toEqual(savedOnSecond);
    // Opening another video is not a render finishing on this one; the page
    // must not be told to reload its version list over a navigation.
    expect(onRendered).not.toHaveBeenCalled();
  });

  it('tracks pending decisions locally and saves them with PUT', async () => {
    const savedOverrides = { version: 1, cuts: { [ISLAND_KEY]: 'restore' }, extraCuts: [] };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === OVERRIDES_URL && init?.method === 'PUT') {
        return jsonResponse({
          data: {
            overrides: savedOverrides,
            summary: {
              restored: 1,
              kept: 0,
              extraCuts: 0,
              originalSeconds: 7,
              programSeconds: 9,
              staleKeys: [],
            },
            needsRender: true,
          },
        });
      }
      if (url === REVIEW_URL) return jsonResponse(payload());
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });

    const { result } = renderReview({});
    await waitFor(() => {
      expect(result.current.review).not.toBeNull();
    });

    act(() => {
      result.current.setCutAction(ISLAND_KEY, 'restore');
    });
    expect(result.current.draft.cuts).toEqual({ [ISLAND_KEY]: 'restore' });
    expect(result.current.isDirty).toBe(true);
    // Nothing is saved yet, so nothing needs a render.
    expect(result.current.needsRender).toBe(false);

    let saveError: string | null = 'unset';
    await act(async () => {
      saveError = await result.current.save();
    });
    expect(saveError).toBeNull();

    const put = fetchMock.mock.calls.find((call) => String(call[0]) === OVERRIDES_URL);
    expect(put?.[1]?.method).toBe('PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      version: 1,
      cuts: { [ISLAND_KEY]: 'restore' },
      extraCuts: [],
    });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.needsRender).toBe(true);
    expect(result.current.saving).toBe(false);

    act(() => {
      result.current.setCutAction(ISLAND_KEY, null);
    });
    expect(result.current.draft.cuts).toEqual({});
    expect(result.current.isDirty).toBe(true);
  });

  it('maps an output time range to source ranges through the rendered program', async () => {
    fetchMock.mockResolvedValue(jsonResponse(payload()));
    const { result, unmount } = renderReview({});
    await waitFor(() => {
      expect(result.current.review).not.toBeNull();
    });

    expect(result.current.sourceRangesForTimeline(2, 4)).toEqual([
      { sourceVersionId: 'ver-a', inSeconds: 3, outSeconds: 4 },
      { sourceVersionId: 'ver-a', inSeconds: 6, outSeconds: 7 },
    ]);
    expect(result.current.sourceTimeAt(5)).toEqual({ sourceVersionId: 'ver-a', seconds: 8 });
    expect(result.current.sourceTimeAt(99)).toBeNull();
    expect(result.current.timelineTimeForSource('ver-a', 8)).toBe(5);
    // 5s of the source is inside the cut island, so it is nowhere on the output.
    expect(result.current.timelineTimeForSource('ver-a', 5)).toBeNull();
    unmount();

    // The mapping follows the program the current output was rendered from, not
    // the run's own decision list: reading `decisions` here would say 3s.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          renderedDecisions: {
            ...decisions(),
            edits: [
              {
                timelineStartSeconds: 0,
                timelineEndSeconds: 6,
                inSeconds: 20,
                outSeconds: 26,
                sourceVersionId: 'ver-a',
                cameraRole: 'A',
                targetTrack: 1,
              },
            ],
          },
        })
      )
    );
    const older = renderReview({});
    await waitFor(() => {
      expect(older.result.current.review).not.toBeNull();
    });
    expect(older.result.current.sourceTimeAt(2)).toEqual({
      sourceVersionId: 'ver-a',
      seconds: 22,
    });
  });

  it('adds an extra cut from a timeline range and removes it again', async () => {
    fetchMock.mockResolvedValue(jsonResponse(payload()));
    const { result } = renderReview({});
    await waitFor(() => {
      expect(result.current.review).not.toBeNull();
    });

    act(() => {
      result.current.addExtraCutFromTimeline(2, 4, 'boring');
    });
    // Timeline 2-4 crosses the island, so one drawn range is two source cuts:
    // 3-4s (frames 72-96) and 6-7s (frames 144-168) of ver-a at 24 fps.
    expect(result.current.draft.extraCuts.map((cut) => cut.key)).toEqual([
      'manual:ver-a:72-96',
      'manual:ver-a:144-168',
    ]);
    expect(result.current.draft.extraCuts.map((cut) => cut.note)).toEqual(['boring', 'boring']);
    expect(result.current.draft.extraCuts[0]).toEqual({
      key: 'manual:ver-a:72-96',
      sourceVersionId: 'ver-a',
      inSeconds: 3,
      outSeconds: 4,
      note: 'boring',
    });
    expect(result.current.isDirty).toBe(true);

    act(() => {
      result.current.addExtraCutFromTimeline(2, 4, 'boring again');
    });
    expect(result.current.draft.extraCuts).toHaveLength(2);

    act(() => {
      result.current.removeExtraCut('manual:ver-a:72-96');
    });
    expect(result.current.draft.extraCuts.map((cut) => cut.key)).toEqual(['manual:ver-a:144-168']);
  });

  it('starts a render and polls until the job leaves the queue, then reloads', async () => {
    vi.useFakeTimers();
    const onRendered = vi.fn();
    let renderStatus = 'idle';
    let renderedOverrides: unknown = null;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === RENDER_URL && init?.method === 'POST') {
        renderStatus = 'running';
        return jsonResponse({ data: { job: { id: 'job-1', status: 'QUEUED' } } }, 202);
      }
      if (url === REVIEW_URL) {
        return jsonResponse(
          payload({
            render: { status: renderStatus, error: null, updatedAt: null },
            renderedOverrides,
          })
        );
      }
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });

    const { result } = renderReview({ onRendered });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.review).not.toBeNull();

    // A reload that finds the same rendered overrides is not a render finishing.
    await act(async () => {
      await result.current.reload();
    });
    expect(onRendered).not.toHaveBeenCalled();

    const callsBeforeRender = fetchMock.mock.calls.length;
    let renderError: string | null = 'unset';
    await act(async () => {
      renderError = await result.current.render();
    });
    expect(renderError).toBeNull();
    expect(fetchMock.mock.calls[callsBeforeRender]?.[0]).toBe(RENDER_URL);
    expect(fetchMock.mock.calls[callsBeforeRender]?.[1]?.method).toBe('POST');
    expect(result.current.renderStatus).toBe('queued');

    const callsAfterRender = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterRender + 1);
    expect(result.current.renderStatus).toBe('running');
    expect(onRendered).not.toHaveBeenCalled();

    // The reviewer keeps working while the render runs; the finished render
    // must not throw their unsaved decision away.
    act(() => {
      result.current.setCutAction(ISLAND_KEY, 'keep');
    });

    renderStatus = 'idle';
    renderedOverrides = { version: 1, cuts: { [ISLAND_KEY]: 'restore' }, extraCuts: [] };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.renderStatus).toBe('idle');
    expect(onRendered).toHaveBeenCalledTimes(1);
    expect(result.current.draft.cuts).toEqual({ [ISLAND_KEY]: 'keep' });

    const callsAfterDone = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterDone);
    expect(onRendered).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.reload();
    });
    expect(onRendered).toHaveBeenCalledTimes(1);
  });

  it('adopts the saved decisions when a render finishes on a clean draft', async () => {
    vi.useFakeTimers();
    const onRendered = vi.fn();
    let renderStatus = 'queued';
    let overrides: unknown = null;
    let renderedOverrides: unknown = null;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === REVIEW_URL) {
        return jsonResponse(
          payload({
            render: { status: renderStatus, error: null, updatedAt: null },
            overrides,
            renderedOverrides,
          })
        );
      }
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });

    const { result } = renderReview({ onRendered });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.draft).toEqual(EMPTY_DRAFT);
    expect(result.current.renderStatus).toBe('queued');

    // The render that was already running was started from decisions this tab
    // never saw; an untouched draft follows the row rather than fighting it.
    const saved = { version: 1, cuts: { [ISLAND_KEY]: 'restore' }, extraCuts: [] };
    renderStatus = 'idle';
    overrides = saved;
    renderedOverrides = saved;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(result.current.draft).toEqual(saved);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.needsRender).toBe(false);
    expect(onRendered).toHaveBeenCalledTimes(1);
  });

  it('recovers from a 409 by following the render that is already running', async () => {
    vi.useFakeTimers();
    let renderStatus = 'idle';
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === RENDER_URL && init?.method === 'POST') {
        renderStatus = 'running';
        return jsonResponse({ error: 'A render is already running for this cut' }, 409);
      }
      if (url === REVIEW_URL) {
        return jsonResponse(
          payload({ render: { status: renderStatus, error: null, updatedAt: null } })
        );
      }
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });

    const { result } = renderReview({});
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.renderStatus).toBe('idle');

    let renderError: string | null = 'unset';
    await act(async () => {
      renderError = await result.current.render();
    });
    expect(renderError).toBe('A render is already running for this cut');
    expect(result.current.error).toBe('A render is already running for this cut');
    // The refusal named a job that exists; the pane follows it rather than
    // sitting on the idle it was refused from.
    expect(result.current.renderStatus).toBe('running');

    const callsAfterRefusal = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterRefusal + 1);
  });

  it('refuses to save or render while another operation runs and surfaces API errors', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === OVERRIDES_URL) {
        return jsonResponse({ error: 'extraCuts: a cut must be at least 0.1s long' }, 400);
      }
      if (url === REVIEW_URL) return jsonResponse(payload());
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });

    const { result } = renderReview({});
    await waitFor(() => {
      expect(result.current.review).not.toBeNull();
    });

    act(() => {
      result.current.setCutAction(ISLAND_KEY, 'keep');
    });
    let saveError: string | null = null;
    await act(async () => {
      saveError = await result.current.save();
    });
    expect(saveError).toBe('extraCuts: a cut must be at least 0.1s long');
    expect(result.current.error).toBe('extraCuts: a cut must be at least 0.1s long');
    expect(result.current.draft).toEqual({
      version: 1,
      cuts: { [ISLAND_KEY]: 'keep' },
      extraCuts: [],
    });
    expect(result.current.isDirty).toBe(true);

    // A render asked for while a save is still in flight never reaches the API.
    const renderCallsBefore = fetchMock.mock.calls.filter(
      (call) => String(call[0]) === RENDER_URL
    ).length;
    let releasePut: (() => void) | null = null;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === OVERRIDES_URL) {
        return new Promise<Response>((resolve) => {
          releasePut = () =>
            resolve(
              jsonResponse({
                data: { overrides: null, summary: null, needsRender: false },
              })
            );
        });
      }
      if (url === REVIEW_URL) return jsonResponse(payload());
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });

    await act(async () => {
      const saving = result.current.save();
      const blocked = await result.current.render();
      expect(blocked).toBe('Another change is already running');
      releasePut?.();
      await saving;
    });
    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === RENDER_URL)).toHaveLength(
      renderCallsBefore
    );
    // The refusal is said out loud, not only returned: the click had no effect
    // and the pane has to be able to say why.
    expect(result.current.error).toBe('Another change is already running');
    expect(result.current.draft).toEqual(EMPTY_DRAFT);
  });
});
