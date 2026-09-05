import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ShortFormPanel,
  SHORT_FORM_POLL_MS,
  shortPreviewObjectPosition,
  type Candidate,
} from '@/components/video-page/short-form-panel';

const STYLE = {
  font: 'dejavu-sans',
  fontSize: 64,
  textColor: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 2,
  backgroundOpacity: 0,
  position: 'bottom',
  marginVertical: 280,
  bold: true,
  uppercase: false,
  maxWordsPerCue: 4,
  maxCueSeconds: 2.5,
  playbackRate: 1,
};

function response(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ data }),
  } as Response;
}

function batch(status = 'READY') {
  return {
    id: 'batch-1',
    status,
    warnings: ['AI reranking failed; deterministic ranking was kept.'],
    error: null,
    candidates:
      status === 'READY'
        ? [
            {
              id: 'short-1',
              rank: 1,
              sourceStartSec: 5,
              sourceEndSec: 25,
              title: 'A useful hook',
              socialCaption: 'A complete idea',
              hashtags: ['#editing'],
              cropMode: 'AUTO',
              cropTrack: [
                { time: 0, x: 0.2, y: 0.3, confidence: 0.9 },
                { time: 20, x: 0.8, y: 0.7, confidence: 0.8 },
              ],
              focusX: null,
              focusY: null,
              captionStyle: STYLE,
              status: 'PROPOSED',
              error: null,
            },
            {
              id: 'short-2',
              rank: 2,
              sourceStartSec: 30,
              sourceEndSec: 50,
              title: 'Second idea',
              socialCaption: 'Another complete idea',
              hashtags: [],
              cropMode: 'PADDED',
              cropTrack: null,
              focusX: null,
              focusY: null,
              captionStyle: STYLE,
              status: 'FAILED',
              error: 'Encoder lost the audio stream',
            },
          ]
        : [],
  };
}

describe('ShortFormPanel', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('polls an active batch at the declared cadence and surfaces AI fallback', async () => {
    let detailCalls = 0;
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    const interval = vi
      .spyOn(window, 'setInterval')
      .mockImplementation(
        (handler, timeout) =>
          (timeout === SHORT_FORM_POLL_MS ? 17 : nativeSetInterval(handler, timeout)) as never
      );
    const clearInterval = vi.spyOn(window, 'clearInterval').mockImplementation((timer) => {
      if (timer !== 17) nativeClearInterval(timer);
    });
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/rough-cuts/')) {
        return response({ batches: [batch('ANALYZING')], canEdit: true });
      }
      detailCalls += 1;
      const next = detailCalls === 1 ? batch('ANALYZING') : batch('READY');
      return response({
        batch: next,
        canEdit: true,
        sourceUrl: '/source.mp4',
        sentenceBoundaries: [],
      });
    });

    render(<ShortFormPanel roughCutId="rough-1" />);

    expect(await screen.findByText('Analyzing transcript, scenes, and faces…')).toBeVisible();
    expect(screen.getByText('AI reranking failed; deterministic ranking was kept.')).toBeVisible();
    await waitFor(() =>
      expect(interval).toHaveBeenCalledWith(expect.any(Function), SHORT_FORM_POLL_MS)
    );
    const poll = interval.mock.calls.find((call) => call[1] === SHORT_FORM_POLL_MS)?.[0];
    expect(poll).toEqual(expect.any(Function));
    act(() => {
      if (typeof poll === 'function') poll();
    });
    await waitFor(() => expect(detailCalls).toBe(2));
    expect(await screen.findByDisplayValue('A useful hook')).toBeVisible();
    await waitFor(() => expect(clearInterval).toHaveBeenCalledWith(17));
  });

  it('previews 9:16, saves edits, selects renders, and shows a sibling render failure', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({
        url,
        method,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      if (url.includes('/rough-cuts/')) return response({ batches: [batch()], canEdit: true });
      if (url.endsWith('/render')) return response({ jobs: [{ id: 'job-1' }] }, 202);
      if (url.includes('/shorts/')) return response({ candidate: batch().candidates[0] });
      return response({
        batch: batch(),
        canEdit: true,
        sourceUrl: '/source.mp4',
        sentenceBoundaries: [0, 5, 25, 30, 50, 55],
      });
    });
    const user = userEvent.setup();
    const { container } = render(<ShortFormPanel roughCutId="rough-1" />);

    const title = await screen.findByDisplayValue('A useful hook');
    expect(container.querySelector('.aspect-\\[9\\/16\\]')).not.toBeNull();
    expect(screen.getAllByLabelText('Platform overlay safe area')).toHaveLength(2);
    expect(screen.getByText('Encoder lost the audio stream')).toBeVisible();
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/source.mp4#t=5,25');
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 15 });
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(video.style.objectPosition).toBe('50% 50%'));

    await user.clear(title);
    await user.type(title, 'Sharper opening');
    fireEvent.blur(title);
    await waitFor(() =>
      expect(requests).toContainEqual({
        url: '/api/shorts/short-1',
        method: 'PATCH',
        body: { title: 'Sharper opening' },
      })
    );

    await user.click(screen.getAllByRole('checkbox', { name: 'Render' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Render 1 selected' }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        url: '/api/short-form-batches/batch-1/render',
        method: 'POST',
        body: { candidateIds: ['short-1'] },
      })
    );
  });

  it('interpolates automatic crop focus and honors a fixed manual focus', () => {
    const automatic = batch().candidates[0]! as Candidate;
    expect(shortPreviewObjectPosition(automatic, 15)).toBe('50% 50%');
    expect(
      shortPreviewObjectPosition(
        { ...automatic, cropMode: 'MANUAL', focusX: 0.7, focusY: 0.25 },
        15
      )
    ).toBe('70% 25%');
  });
});
