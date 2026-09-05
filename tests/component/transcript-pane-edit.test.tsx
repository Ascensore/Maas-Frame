import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TranscriptPane } from '@/components/video-page/transcript-pane';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** What the PATCH route answers with: the new text and its retimed words. */
const SAVED_WORDS = [
  { start: 1, end: 2, text: 'kuruculari' },
  { start: 2, end: 3, text: 'bulduk' },
];

const SOURCE_SEGMENT = {
  id: 'segment-1',
  startSec: 1,
  endSec: 3,
  speaker: 'Tom',
  text: 'kurucularla bulustuk',
  words: [
    { start: 1, end: 2, text: 'kurucularla' },
    { start: 2, end: 3, text: 'bulustuk' },
  ],
  position: 0,
};

/** A Turkish transcript carrying a finished English translation. */
function transcriptPayload() {
  return {
    data: {
      transcript: {
        id: 'transcript-1',
        versionId: 'version-1',
        language: 'tr',
        provider: 'mock',
        status: 'READY',
        error: null,
        translation: {
          language: 'en',
          status: 'READY',
          error: null,
          texts: ['we met founders'],
        },
        segments: [SOURCE_SEGMENT],
      },
    },
  };
}

describe('TranscriptPane line editing', () => {
  const fetchMock = vi.fn();
  const onCaptionsChanged = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    onCaptionsChanged.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pane(versionId: string, canManage: boolean) {
    return (
      <TranscriptPane
        versionId={versionId}
        getCurrentTime={() => 0}
        canManage={canManage}
        canTranscribe={false}
        comments={[]}
        onSeek={() => {}}
        onCommentRange={() => {}}
        onOpenThread={() => {}}
        onCaptionsChanged={onCaptionsChanged}
        draftRange={null}
      />
    );
  }

  function renderPane(canManage = true) {
    return render(
      <TranscriptPane
        versionId="version-1"
        getCurrentTime={() => 0}
        canManage={canManage}
        canTranscribe={false}
        comments={[]}
        onSeek={() => {}}
        onCommentRange={() => {}}
        onOpenThread={() => {}}
        onCaptionsChanged={onCaptionsChanged}
        draftRange={null}
      />
    );
  }

  async function renderReadyPane(canManage = true) {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript' && !init?.method) {
        return jsonResponse(transcriptPayload());
      }
      return jsonResponse({ data: {} });
    });
    const view = renderPane(canManage);
    await waitFor(() => {
      expect(screen.getByText('kurucularla')).toBeInTheDocument();
    });
    return view;
  }

  it('fills the editor from the stored line, not the English overlay', async () => {
    const user = userEvent.setup();
    await renderReadyPane();

    // Turn the English overlay on: the rows now read the translation.
    await user.click(screen.getByRole('button', { name: 'English' }));
    await waitFor(() => {
      expect(screen.getByText('we met founders')).toBeInTheDocument();
    });

    // Editing a translated line would save the translation over the Turkish
    // original, so the pencil is refused while the overlay is on.
    const pencil = screen.getByRole('button', { name: 'Edit line' });
    expect(pencil).toBeDisabled();
    expect(pencil).toHaveAttribute('title', 'Switch to the original to edit');
    await user.click(pencil);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Back on the original, the dialog opens on the stored Turkish text.
    await user.click(screen.getByRole('button', { name: 'Original' }));
    await user.click(screen.getByRole('button', { name: 'Edit line' }));

    expect(screen.getByRole('heading', { name: 'Edit transcript line' })).toBeVisible();
    expect(screen.getByLabelText('Text')).toHaveValue('kurucularla bulustuk');
    expect(screen.getByLabelText('Speaker')).toHaveValue('Tom');
  });

  it('saves the edit, swaps the line in and asks the player to reload its tracks', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript/segments/segment-1') {
        return jsonResponse({
          data: {
            segment: {
              ...SOURCE_SEGMENT,
              text: 'kuruculari bulduk',
              speaker: 'Ada',
              words: SAVED_WORDS,
            },
            captions: 'updated',
            subtitle: { id: 'sub-1', language: 'tr', url: '/api/upload/subtitle/x.vtt' },
          },
        });
      }
      if (url === '/api/versions/version-1/transcript' && !init?.method) {
        return jsonResponse(transcriptPayload());
      }
      return jsonResponse({ data: {} });
    });
    renderPane();
    await waitFor(() => {
      expect(screen.getByText('kurucularla')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Edit line' }));
    const textarea = screen.getByLabelText('Text');
    await user.clear(textarea);
    await user.type(textarea, 'kuruculari bulduk');
    await user.clear(screen.getByLabelText('Speaker'));
    await user.type(screen.getByLabelText('Speaker'), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const patchCall = fetchMock.mock.calls.find(
      (call) => String(call[0]) === '/api/versions/version-1/transcript/segments/segment-1'
    );
    expect(patchCall?.[1]?.method).toBe('PATCH');
    expect(patchCall?.[1]?.body).toBe(
      JSON.stringify({ text: 'kuruculari bulduk', speaker: 'Ada' })
    );

    // The row shows the saved words without a refetch...
    expect(screen.getByText('kuruculari')).toBeInTheDocument();
    // ...and the player is told its caption track was rewritten.
    expect(onCaptionsChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Reopening reads the line that is stored now, not the one first rendered.
    await user.click(screen.getByRole('button', { name: 'Edit line' }));
    expect(screen.getByLabelText('Text')).toHaveValue('kuruculari bulduk');
  });

  it('warns without blocking when the caption track could not be rebuilt', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript/segments/segment-1') {
        return jsonResponse({
          data: {
            segment: { ...SOURCE_SEGMENT, text: 'kuruculari bulduk', words: SAVED_WORDS },
            captions: 'failed',
            subtitle: null,
          },
        });
      }
      if (url === '/api/versions/version-1/transcript' && !init?.method) {
        return jsonResponse(transcriptPayload());
      }
      return jsonResponse({ data: {} });
    });
    renderPane();
    await waitFor(() => {
      expect(screen.getByText('kurucularla')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Edit line' }));
    const textarea = screen.getByLabelText('Text');
    await user.clear(textarea);
    await user.type(textarea, 'kuruculari bulduk');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // The edit stuck; only the subtitles are behind, and the pane says so.
    expect(screen.getByText('kuruculari')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Line saved, but the caption track could not be rebuilt.'
    );
    expect(onCaptionsChanged).not.toHaveBeenCalled();
  });

  it('says an untimed transcript has no captions to build, and drops the note with the version', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript/segments/segment-1') {
        return jsonResponse({
          data: {
            segment: { ...SOURCE_SEGMENT, text: 'kuruculari bulduk', words: SAVED_WORDS },
            captions: 'empty',
            subtitle: null,
          },
        });
      }
      if (url === '/api/versions/version-1/transcript' && !init?.method) {
        return jsonResponse(transcriptPayload());
      }
      if (url === '/api/versions/version-2/transcript' && !init?.method) {
        return jsonResponse({ data: { transcript: null } });
      }
      return jsonResponse({ data: {} });
    });
    const view = render(pane('version-1', true));
    await waitFor(() => {
      expect(screen.getByText('kurucularla')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Edit line' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // 'empty' is not a failure: there was nothing timed to cut cues out of, and
    // the note has to say that rather than point at a rebuild that broke.
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent(
      'Line saved. There is no caption track to build: this transcript is untimed.'
    );
    expect(note).not.toHaveTextContent('could not be rebuilt');
    expect(onCaptionsChanged).not.toHaveBeenCalled();

    // The note belongs to the version it was saved on. Left standing on the
    // next one it claims something about a transcript nobody has edited.
    view.rerender(pane('version-2', true));
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('shows the API error and keeps the dialog open', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript/segments/segment-1') {
        return jsonResponse({ error: 'text: Too big' }, 400);
      }
      if (url === '/api/versions/version-1/transcript' && !init?.method) {
        return jsonResponse(transcriptPayload());
      }
      return jsonResponse({ data: {} });
    });
    renderPane();
    await waitFor(() => {
      expect(screen.getByText('kurucularla')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Edit line' }));
    await user.type(screen.getByLabelText('Text'), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('text: Too big')).toBeVisible();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onCaptionsChanged).not.toHaveBeenCalled();
  });

  it('submits on Cmd+Enter from the textarea', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/versions/version-1/transcript/segments/segment-1') {
        return jsonResponse({
          data: { segment: SOURCE_SEGMENT, captions: 'updated', subtitle: null },
        });
      }
      if (url === '/api/versions/version-1/transcript' && !init?.method) {
        return jsonResponse(transcriptPayload());
      }
      return jsonResponse({ data: {} });
    });
    renderPane();
    await waitFor(() => {
      expect(screen.getByText('kurucularla')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Edit line' }));
    await user.click(screen.getByLabelText('Text'));
    await user.keyboard('{Meta>}{Enter}{/Meta}');

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          (call) => String(call[0]) === '/api/versions/version-1/transcript/segments/segment-1'
        )
      ).toBe(true);
    });
  });

  it('offers no pencil to a viewer who cannot manage the transcript', async () => {
    await renderReadyPane(false);
    expect(screen.queryByRole('button', { name: 'Edit line' })).not.toBeInTheDocument();
  });
});
