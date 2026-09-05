import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSubtitles } from '@/components/video-page/hooks/use-subtitles';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('useSubtitles', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderSubtitles(supportsSubtitles = true) {
    return renderHook(() =>
      useSubtitles({
        videoId: 'video-1',
        versionId: 'version-1',
        videoRef: { current: null },
        supportsSubtitles,
      })
    );
  }

  it('still loads canManageSubtitles when the player cannot attach a track', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          subtitles: [
            {
              id: 'sub-1',
              versionId: 'version-1',
              language: 'en',
              label: 'English',
              url: '/api/upload/subtitle/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.vtt',
              sizeBytes: 12,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              uploadedByUser: null,
              canDelete: false,
            },
          ],
          canManageSubtitles: false,
        },
      })
    );

    const { result } = renderSubtitles(false);

    await waitFor(() => {
      expect(result.current.subtitles).toHaveLength(1);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/videos/video-1/subtitles?versionId=version-1',
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(result.current.canManageSubtitles).toBe(false);
  });

  it('sends a text file to the transcript upload route', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript/upload') {
        return jsonResponse({ data: { transcript: { status: 'READY' } } }, 201);
      }
      return jsonResponse({ data: { subtitles: [], canManageSubtitles: true } });
    });

    const { result } = renderSubtitles();
    await waitFor(() => {
      expect(result.current.canManageSubtitles).toBe(true);
    });

    let error: string | null = 'unset';
    await act(async () => {
      error = await result.current.uploadSubtitle(
        new File(['INT. KITCHEN'], 'script.txt', { type: 'text/plain' }),
        'en',
        'English'
      );
    });

    expect(error).toBeNull();
    const uploadCall = fetchMock.mock.calls.find(
      (call) => String(call[0]) === '/api/versions/version-1/transcript/upload'
    );
    expect(uploadCall?.[1]?.method).toBe('POST');
    const body = uploadCall?.[1]?.body as FormData;
    expect(body.get('language')).toBe('en');
    const file = body.get('transcript');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('script.txt');
    const subtitlePost = fetchMock.mock.calls.find(
      (call) => String(call[0]).includes('/subtitles') && call[1]?.method === 'POST'
    );
    expect(subtitlePost).toBeUndefined();
  });

  it('sends an srt file to the video subtitles route', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/subtitles') && init?.method === 'POST') {
        return jsonResponse({ data: { id: 'sub-1' } }, 201);
      }
      return jsonResponse({ data: { subtitles: [], canManageSubtitles: true } });
    });

    const { result } = renderSubtitles();
    await waitFor(() => {
      expect(result.current.canManageSubtitles).toBe(true);
    });

    let error: string | null = 'unset';
    await act(async () => {
      error = await result.current.uploadSubtitle(
        new File(['WEBVTT\n\n'], 'cut.srt', { type: 'application/x-subrip' }),
        'tr',
        'Türkçe'
      );
    });

    expect(error).toBeNull();
    const subtitlePost = fetchMock.mock.calls.find(
      (call) => String(call[0]) === '/api/videos/video-1/subtitles' && call[1]?.method === 'POST'
    );
    expect(subtitlePost).toBeTruthy();
    const body = subtitlePost?.[1]?.body as FormData;
    expect(body.get('versionId')).toBe('version-1');
    expect(body.get('language')).toBe('tr');
    expect(body.get('label')).toBe('Türkçe');
    expect((body.get('subtitle') as File).name).toBe('cut.srt');
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/transcript/upload'))
    ).toBe(false);
  });

  it('builds captions from a READY transcript instead of starting a transcription', async () => {
    let captionReady = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript/captions') {
        captionReady = true;
        return jsonResponse(
          {
            data: {
              subtitle: {
                id: 'sub-from-transcript',
                language: 'en',
                label: 'Transcript (en)',
                url: '/api/upload/subtitle/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.vtt',
              },
            },
          },
          201
        );
      }
      if (url === '/api/versions/version-1/transcript' && init?.method !== 'POST') {
        return jsonResponse({
          data: {
            transcript: {
              id: 'transcript-1',
              status: 'READY',
              language: 'en',
              segments: [{ id: 'segment-1', startSec: 1, endSec: 3, text: 'we help founders' }],
            },
          },
        });
      }
      return jsonResponse({
        data: {
          subtitles: captionReady
            ? [
                {
                  id: 'sub-from-transcript',
                  versionId: 'version-1',
                  language: 'en',
                  label: 'Transcript (en)',
                  url: '/api/upload/subtitle/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.vtt',
                  sizeBytes: 48,
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                  uploadedByUser: null,
                  canDelete: true,
                },
              ]
            : [],
          canManageSubtitles: true,
        },
      });
    });

    const { result } = renderSubtitles();
    await waitFor(() => {
      expect(result.current.canManageSubtitles).toBe(true);
    });

    let error: string | null = 'unset';
    await act(async () => {
      error = await result.current.generateSubtitles('en');
    });

    expect(error).toBeNull();
    // No transcription job: the words and the timings are already on the row.
    expect(
      fetchMock.mock.calls.some(
        (call) =>
          String(call[0]) === '/api/versions/version-1/transcript' && call[1]?.method === 'POST'
      )
    ).toBe(false);
    const captionsCall = fetchMock.mock.calls.find(
      (call) => String(call[0]) === '/api/versions/version-1/transcript/captions'
    );
    expect(captionsCall?.[1]?.method).toBe('POST');
    expect(captionsCall?.[1]?.body).toBe(JSON.stringify({ language: 'en' }));
    expect(result.current.isGeneratingSubtitles).toBe(false);
    expect(result.current.activeSubtitleLanguage).toBe('en');
  });

  it('transcribes when the chosen language is not the transcript language', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript' && init?.method === 'POST') {
        return jsonResponse({ data: { transcript: { status: 'PENDING' } } }, 202);
      }
      if (url === '/api/versions/version-1/transcript') {
        return jsonResponse({
          data: {
            transcript: {
              id: 'transcript-1',
              status: 'READY',
              language: 'tr',
              segments: [{ id: 'segment-1', startSec: 1, endSec: 3, text: 'kurucularla' }],
            },
          },
        });
      }
      return jsonResponse({ data: { subtitles: [], canManageSubtitles: true } });
    });

    const { result } = renderSubtitles();
    await waitFor(() => {
      expect(result.current.canManageSubtitles).toBe(true);
    });

    let error: string | null = 'unset';
    await act(async () => {
      error = await result.current.generateSubtitles('en');
    });

    // A Turkish transcript is no basis for the English track that was asked for,
    // so this goes to AI. (The status poll sees the mocked READY transcript and
    // finishes immediately, so the AI POST is what proves the path taken.)
    expect(error).toBeNull();
    const transcribeCall = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]) === '/api/versions/version-1/transcript' && call[1]?.method === 'POST'
    );
    expect(transcribeCall?.[1]?.body).toBe(JSON.stringify({ language: 'en' }));
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/transcript/captions'))
    ).toBe(false);
  });

  it('builds captions when the chosen language differs only by region', async () => {
    let captionReady = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript/captions') {
        captionReady = true;
        return jsonResponse({ data: { subtitle: { id: 's', language: 'en-us', url: '/u' } } }, 201);
      }
      if (url === '/api/versions/version-1/transcript' && init?.method !== 'POST') {
        return jsonResponse({
          data: {
            transcript: {
              id: 'transcript-1',
              status: 'READY',
              language: 'en-US',
              segments: [{ id: 'segment-1', startSec: 1, endSec: 3, text: 'we help founders' }],
            },
          },
        });
      }
      return jsonResponse({
        data: {
          subtitles: captionReady
            ? [
                {
                  id: 's',
                  versionId: 'version-1',
                  language: 'en-us',
                  label: 'Transcript (en-US)',
                  url: '/u',
                  sizeBytes: 48,
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                  uploadedByUser: null,
                  canDelete: true,
                },
              ]
            : [],
          canManageSubtitles: true,
        },
      });
    });

    const { result } = renderSubtitles();
    await waitFor(() => {
      expect(result.current.canManageSubtitles).toBe(true);
    });

    let error: string | null = 'unset';
    await act(async () => {
      error = await result.current.generateSubtitles('en');
    });

    expect(error).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        (call) =>
          String(call[0]) === '/api/versions/version-1/transcript' && call[1]?.method === 'POST'
      )
    ).toBe(false);
    expect(result.current.activeSubtitleLanguage).toBe('en-us');
  });

  it('transcribes when the transcript has no timed line', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript' && init?.method === 'POST') {
        return jsonResponse({ data: { transcript: { status: 'PENDING' } } }, 202);
      }
      if (url === '/api/versions/version-1/transcript') {
        return jsonResponse({
          data: {
            transcript: {
              id: 'transcript-1',
              status: 'READY',
              language: 'en',
              // An uploaded .txt script: words, no timings, nothing to caption.
              segments: [{ id: 'segment-1', startSec: 0, endSec: 0, text: 'INT. KITCHEN' }],
            },
          },
        });
      }
      return jsonResponse({ data: { subtitles: [], canManageSubtitles: true } });
    });

    const { result } = renderSubtitles();
    await waitFor(() => {
      expect(result.current.canManageSubtitles).toBe(true);
    });

    let error: string | null = 'unset';
    await act(async () => {
      error = await result.current.generateSubtitles('en');
    });

    expect(error).toBeNull();
    const transcribeCall = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]) === '/api/versions/version-1/transcript' && call[1]?.method === 'POST'
    );
    expect(transcribeCall?.[1]?.body).toBe(JSON.stringify({ language: 'en' }));
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/transcript/captions'))
    ).toBe(false);
  });

  it('reports a failed probe instead of silently transcribing', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript' && init?.method !== 'POST') {
        return jsonResponse({ error: 'boom' }, 500);
      }
      if (url === '/api/versions/version-1/transcript') {
        return jsonResponse({ data: { transcript: { status: 'PENDING' } } }, 202);
      }
      return jsonResponse({ data: { subtitles: [], canManageSubtitles: true } });
    });

    const { result } = renderSubtitles();
    await waitFor(() => {
      expect(result.current.canManageSubtitles).toBe(true);
    });

    let error: string | null = null;
    await act(async () => {
      error = await result.current.generateSubtitles('en');
    });

    // A probe that never answered is not proof there is no transcript, and
    // spending an AI transcription on that assumption is the bug.
    expect(error).toBe('Could not check this version for an existing transcript');
    expect(result.current.isGeneratingSubtitles).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        (call) =>
          String(call[0]) === '/api/versions/version-1/transcript' && call[1]?.method === 'POST'
      )
    ).toBe(false);

    // And the failure must not wedge the button: a retry is allowed.
    let retry: string | null = null;
    await act(async () => {
      retry = await result.current.generateSubtitles('en');
    });
    expect(retry).toBe('Could not check this version for an existing transcript');
  });

  it('starts a transcription when there is no transcript', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript' && init?.method === 'POST') {
        return jsonResponse({ data: { transcript: { status: 'PENDING' } } }, 202);
      }
      if (url === '/api/versions/version-1/transcript') {
        return jsonResponse({ data: { transcript: null } });
      }
      return jsonResponse({ data: { subtitles: [], canManageSubtitles: true } });
    });

    const { result } = renderSubtitles();
    await waitFor(() => {
      expect(result.current.canManageSubtitles).toBe(true);
    });

    let error: string | null = 'unset';
    await act(async () => {
      error = await result.current.generateSubtitles('en');
    });

    expect(error).toBeNull();
    expect(result.current.isGeneratingSubtitles).toBe(true);
    const transcribeCall = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]) === '/api/versions/version-1/transcript' && call[1]?.method === 'POST'
    );
    expect(transcribeCall?.[1]?.body).toBe(JSON.stringify({ language: 'en' }));
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/transcript/captions'))
    ).toBe(false);
  });

  it('POSTs the version transcript route when generating AI subtitles', async () => {
    vi.useFakeTimers();
    let transcriptStatus = 'PENDING';
    let captionReady = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript' && init?.method === 'POST') {
        return jsonResponse({ data: { transcript: { status: 'PENDING' } } }, 202);
      }
      if (url === '/api/versions/version-1/transcript') {
        return jsonResponse({ data: { transcript: { status: transcriptStatus } } });
      }
      return jsonResponse({
        data: {
          subtitles: captionReady
            ? [
                {
                  id: 'sub-ai',
                  versionId: 'version-1',
                  language: 'en',
                  label: 'English',
                  url: '/api/upload/subtitle/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.vtt',
                  sizeBytes: 24,
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                  uploadedByUser: null,
                  canDelete: true,
                },
              ]
            : [],
          canManageSubtitles: true,
        },
      });
    });

    const { result } = renderSubtitles();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.canManageSubtitles).toBe(true);

    let error: string | null = 'unset';
    await act(async () => {
      error = await result.current.generateSubtitles('en');
    });

    expect(error).toBeNull();
    expect(result.current.isGeneratingSubtitles).toBe(true);
    const generateCall = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]) === '/api/versions/version-1/transcript' && call[1]?.method === 'POST'
    );
    expect(generateCall?.[1]?.body).toBe(JSON.stringify({ language: 'en' }));

    let concurrent: string | null = 'unset';
    await act(async () => {
      concurrent = await result.current.generateSubtitles('en');
    });
    expect(concurrent).toBe('Subtitle generation is already running');

    transcriptStatus = 'READY';
    captionReady = true;
    await act(async () => {
      vi.advanceTimersByTime(4000);
      await Promise.resolve();
    });

    expect(result.current.isGeneratingSubtitles).toBe(false);
    expect(result.current.activeSubtitleLanguage).toBe('en');
  });
});
