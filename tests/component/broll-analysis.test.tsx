import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommentEditControls } from '@/components/video-page/comment-edit-controls';
import type { EditLibraryView } from '@/lib/comment-edit/types';

afterEach(() => vi.unstubAllGlobals());

const asset = { versionId: 'source-a', title: 'Office tour', duration: 10 };
function controls(assets: EditLibraryView['assets']) {
  return (
    <CommentEditControls
      busy={false}
      eligible
      resolved={false}
      agentsEnabled
      onAction={vi.fn()}
      library={{ presets: [], assets }}
    />
  );
}
function selectAsset(id = 'source-a') {
  fireEvent.change(screen.getByLabelText('B-roll source'), { target: { value: id } });
}

describe('B-roll analysis in comment controls', () => {
  it('replaces the queued message when the library reports completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: { job: { id: 'analysis-a', status: 'PENDING' } },
            }),
            { status: 202 }
          )
      )
    );
    const view = render(controls([asset]));
    selectAsset();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze selected B-roll' }));
    await screen.findByText(/Frame analysis queued/);
    view.rerender(
      controls([
        {
          ...asset,
          analysisJobId: 'analysis-a',
          analysisStatus: 'SUCCEEDED',
          visualEvidence: { frames: [{ seconds: 1 }, { seconds: 5 }, { seconds: 9 }] },
        },
      ])
    );
    await waitFor(() =>
      expect(screen.queryByText(/Frame analysis queued/)).not.toBeInTheDocument()
    );
    expect(screen.getByText(/Visual samples ready/)).toBeInTheDocument();
  });

  it('shows worker failures and offers a retry', () => {
    render(
      controls([{ ...asset, analysisStatus: 'FAILED', analysisError: 'Could not decode footage' }])
    );
    selectAsset();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not decode footage');
    expect(screen.getByRole('button', { name: 'Retry B-roll analysis' })).toBeEnabled();
  });

  it('shows sampled images at their source times and a fallback when an image fails', () => {
    render(
      controls([
        {
          ...asset,
          visualEvidence: {
            frames: [
              {
                seconds: 1,
                previewUrl: '/api/versions/source-a/broll-evidence?frame=0&generation=sample',
              },
              {
                seconds: 5,
                previewUrl: '/api/versions/source-a/broll-evidence?frame=1&generation=sample',
              },
              {
                seconds: 9,
                previewUrl: '/api/versions/source-a/broll-evidence?frame=2&generation=sample',
              },
            ],
          },
        },
      ])
    );
    selectAsset();
    expect(screen.getAllByRole('img')).toHaveLength(3);
    expect(screen.getByRole('img', { name: 'Office tour at 5.0 seconds' })).toHaveAttribute(
      'src',
      '/api/versions/source-a/broll-evidence?frame=1&generation=sample'
    );
    for (const timestamp of ['1.0s', '5.0s', '9.0s'])
      expect(screen.getByText(timestamp)).toBeInTheDocument();
    fireEvent.error(screen.getByRole('img', { name: 'Office tour at 5.0 seconds' }));
    expect(screen.getByText(/Preview unavailable/)).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(2);
  });

  it('keeps a reanalysis queued across stale refreshes, then shows the new job failure with previous samples', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { job: { id: 'new-job', status: 'PENDING' } } }), {
          status: 202,
        })
    );
    vi.stubGlobal('fetch', fetch);
    const previous = {
      ...asset,
      analysisJobId: 'old-job',
      analysisStatus: 'SUCCEEDED',
      visualEvidence: { frames: [{ seconds: 1, previewUrl: '/sample.jpg' }] },
    };
    const view = render(controls([previous]));
    selectAsset();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze B-roll again' }));
    await screen.findByText(/Frame analysis queued/);
    view.rerender(controls([{ ...previous }]));
    expect(screen.getByRole('button', { name: 'Analyzing B-roll…' })).toBeDisabled();
    expect(screen.getByText(/Previous samples are shown/)).toBeInTheDocument();
    view.rerender(controls([{ ...previous, analysisJobId: 'new-job', analysisStatus: 'RUNNING' }]));
    expect(screen.getByText(/Sampling B-roll frames/)).toBeInTheDocument();
    view.rerender(
      controls([
        {
          ...previous,
          analysisJobId: 'new-job',
          analysisStatus: 'FAILED',
          analysisError: 'Decode failed',
        },
      ])
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Decode failed');
    expect(screen.queryByText(/Frame analysis queued/)).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', '/sample.jpg');
    expect(screen.getByRole('button', { name: 'Retry B-roll analysis' })).toBeEnabled();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/versions/source-a/broll-evidence', {
      method: 'POST',
    });
  });

  it('ignores a late response after switching source and permits analysis of the new source', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { job: { id: 'b-job', status: 'PENDING' } } }), {
          status: 202,
        })
      );
    vi.stubGlobal('fetch', fetch);
    render(controls([asset, { ...asset, versionId: 'source-b', title: 'Workshop' }]));
    selectAsset();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze selected B-roll' }));
    selectAsset('source-b');
    await act(async () => {
      finish(new Response(JSON.stringify({ error: 'Source A failed' }), { status: 500 }));
    });
    expect(screen.queryByText('Source A failed')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze selected B-roll' }));
    await screen.findByText(/Frame analysis queued/);
    expect(fetch).toHaveBeenLastCalledWith('/api/versions/source-b/broll-evidence', {
      method: 'POST',
    });
  });

  it('reports request failure and retries without duplicating a pending request', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Worker unavailable' }), { status: 503 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { job: { id: 'job', status: 'QUEUED' } } }), {
          status: 202,
        })
      );
    vi.stubGlobal('fetch', fetch);
    render(controls([asset]));
    selectAsset();
    const button = screen.getByRole('button', { name: 'Analyze selected B-roll' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Worker unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze selected B-roll' }));
    await screen.findByText(/Frame analysis queued/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
