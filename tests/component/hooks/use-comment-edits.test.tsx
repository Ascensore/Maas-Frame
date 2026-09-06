import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useCommentEdits } from '@/components/video-page/hooks/use-comment-edits';
import { CommentEditControls } from '@/components/video-page/comment-edit-controls';
import type { CommentEditView } from '@/lib/comment-edit/types';

const fetchMock = vi.fn();
const resolved = vi.fn(async () => {});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const task = (status: CommentEditView['status']): CommentEditView => ({
  commentId: 'comment-1',
  status,
  error: null,
  instruction: 'Remove the pause',
  removedSeconds: null,
  previewUrl: null,
  outputHref: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  fetchMock.mockReset();
  resolved.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('comment editing controls', () => {
  it('runs the selected comment, displays the returned status, and blocks duplicate clicks', async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((_url, init) =>
      init?.method === 'POST' ? pending.promise : Promise.resolve(json({ data: { tasks: [] } }))
    );
    function Harness() {
      const edits = useCommentEdits('version-1', true, resolved);
      return (
        <CommentEditControls
          eligible
          resolved={false}
          agentsEnabled
          busy={edits.busyIds.includes('comment-1')}
          task={edits.tasks[0]}
          onAction={(action) => {
            void edits.act('comment-1', action);
          }}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Run with AI' }));
    expect(screen.getByRole('button', { name: 'Run with AI' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Run with AI' }));
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toEqual([
      [
        '/api/comments/comment-1/edit-task',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'run' }) }),
      ],
    ]);
    await act(async () => {
      pending.resolve(json({ data: { task: task('PLANNING') } }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('AI is planning the cut');
    expect(screen.queryByRole('button', { name: 'Run with AI' })).not.toBeInTheDocument();
  });
  it('previews the exact draft and accepts through the task route before refreshing comments', async () => {
    const ready = {
      ...task('READY'),
      removedSeconds: 1,
      previewUrl: '/api/upload/video/draft.mp4',
    };
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(
        json({ data: init?.method === 'POST' ? { task: task('ACCEPTED') } : { tasks: [ready] } })
      )
    );
    function Harness() {
      const edits = useCommentEdits('version-1', true, resolved);
      return (
        <CommentEditControls
          eligible
          resolved={false}
          agentsEnabled
          busy={false}
          task={edits.tasks[0]}
          onAction={(action) => {
            void edits.act('comment-1', action);
          }}
        />
      );
    }
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Preview draft' })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview draft' }));
    expect(screen.getByLabelText('AI edited draft')).toHaveAttribute(
      'src',
      '/api/upload/video/draft.mp4'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Accept & resolve' }));
    await waitFor(() => expect(resolved).toHaveBeenCalledWith('version-1'));
    expect(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1].body).toBe(
      JSON.stringify({ action: 'accept' })
    );
    expect(screen.getByRole('status')).toHaveTextContent('AI draft accepted');
  });
  it('does not expose execution for a point comment', () => {
    render(
      <CommentEditControls
        eligible={false}
        resolved={false}
        agentsEnabled
        busy={false}
        onAction={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Run with AI' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Queue for AI' })).toBeDisabled();
    expect(screen.getByText(/AI cuts need text feedback/)).toBeInTheDocument();
  });
});

describe('useCommentEdits', () => {
  it('does not fetch or mutate when editing access is absent', async () => {
    const { result } = renderHook(() => useCommentEdits('v1', false, resolved));
    await act(async () => {
      expect(await result.current.act('c1', 'run')).toBe(false);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('discards a late list response from a previously selected version', async () => {
    const old = deferred<Response>();
    fetchMock.mockImplementation((url) =>
      url.includes('/v1/')
        ? old.promise
        : Promise.resolve(json({ data: { tasks: [task('HUMAN')] } }))
    );
    const { result, rerender } = renderHook(
      ({ version }) => useCommentEdits(version, true, resolved),
      { initialProps: { version: 'v1' } }
    );
    rerender({ version: 'v2' });
    await waitFor(() => expect(result.current.tasks[0]?.status).toBe('HUMAN'));
    await act(async () => {
      old.resolve(json({ data: { tasks: [task('READY')] } }));
    });
    expect(result.current.tasks[0].status).toBe('HUMAN');
  });
  it('does not let an older poll overwrite a completed mutation', async () => {
    const old = deferred<Response>();
    fetchMock.mockImplementation((_url, init) =>
      init?.method === 'POST'
        ? Promise.resolve(json({ data: { task: task('QUEUED') } }))
        : old.promise
    );
    const { result } = renderHook(() => useCommentEdits('v1', true, resolved));
    await act(async () => {
      await result.current.act('comment-1', 'queue');
    });
    await act(async () => {
      old.resolve(json({ data: { tasks: [task('HUMAN')] } }));
    });
    expect(result.current.tasks[0].status).toBe('QUEUED');
  });
  it('preserves the existing task when a mutation is refused', async () => {
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? json({ error: 'Editing permission is required' }, 403)
          : json({ data: { tasks: [task('QUEUED')] } })
      )
    );
    const { result } = renderHook(() => useCommentEdits('v1', true, resolved));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    await act(async () => {
      expect(await result.current.act('comment-1', 'run')).toBe(false);
    });
    expect(result.current.tasks[0].status).toBe('QUEUED');
    expect(result.current.busyIds).toEqual([]);
    expect(resolved).not.toHaveBeenCalled();
  });
});
