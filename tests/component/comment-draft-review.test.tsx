import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommentEditControls } from '@/components/video-page/comment-edit-controls';
import { useCommentEdits } from '@/components/video-page/hooks/use-comment-edits';
import type { CommentEditView } from '@/lib/comment-edit/types';

afterEach(() => vi.unstubAllGlobals());
const ready: CommentEditView = {
  commentId: 'comment',
  runId: 'run-1',
  status: 'READY',
  instruction: 'Remove pause',
  error: null,
  removedSeconds: 1,
  previewUrl: '/draft-1.mp4',
  outputHref: '/projects/p/videos/draft-1',
  changes: [{ start: 2, end: 3, detail: 'Remove footage' }],
  revisions: [
    {
      id: 'previous',
      status: 'READY',
      createdAt: '2026-09-01T12:00:00Z',
      adjustment: 'Use a closer shot',
      error: null,
      previewUrl: '/previous.mp4',
      outputHref: '/projects/p/videos/previous',
    },
  ],
};

describe('draft revision controls', () => {
  it('shows changes and pinned earlier previews and submits an adjustment with the reviewed run ID', () => {
    const onAction = vi.fn();
    const props = { busy: false, eligible: true, resolved: false, agentsEnabled: true, onAction };
    const view = render(<CommentEditControls {...props} task={ready} />);
    expect(screen.getByText('2.00–3.00s: Remove footage')).toBeInTheDocument();
    expect(screen.getByLabelText('Earlier AI draft previous')).toHaveAttribute(
      'src',
      '/previous.mp4'
    );
    expect(screen.getByRole('link', { name: 'Open earlier draft' })).toHaveAttribute(
      'href',
      '/projects/p/videos/previous'
    );
    expect(screen.getByRole('button', { name: 'Generate adjusted draft' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Describe the adjustment'), {
      target: { value: ' Keep a little more ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate adjusted draft' }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith('revise', {
      adjustment: 'Keep a little more',
      expectedRunId: 'run-1',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Accept & resolve' }));
    expect(onAction).toHaveBeenLastCalledWith('accept', { expectedRunId: 'run-1' });
    view.rerender(<CommentEditControls {...props} task={{ ...ready, runId: 'run-2' }} />);
    expect(screen.getByLabelText('Describe the adjustment')).toHaveValue('');
    view.rerender(<CommentEditControls {...props} task={{ ...ready, status: 'PLANNING' }} />);
    expect(screen.queryByText('Adjust draft')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Earlier AI draft previous')).toHaveAttribute(
      'src',
      '/previous.mp4'
    );
  });
  it('undoes acceptance through the API and refreshes comments while AI execution is disabled', async () => {
    const onResolved = vi.fn(async () => {});
    const fetch = vi.fn(
      async (_url, init) =>
        new Response(
          JSON.stringify({
            data:
              init?.method === 'POST'
                ? { task: ready }
                : { tasks: [{ ...ready, status: 'ACCEPTED', batchSize: 2 }] },
          })
        )
    );
    vi.stubGlobal('fetch', fetch);
    function Harness() {
      const edits = useCommentEdits('version', true, onResolved);
      return (
        <CommentEditControls
          task={edits.tasks[0]}
          busy={edits.busyIds.length > 0}
          eligible
          resolved
          agentsEnabled={false}
          onAction={(action, options) => {
            void edits.act('comment', action, options);
          }}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo acceptance' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledExactlyOnceWith('version'));
    expect(fetch).toHaveBeenCalledWith(
      '/api/comments/comment/edit-task',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'undo', options: { expectedRunId: 'run-1' } }),
      })
    );
    expect(screen.getByRole('status')).toHaveTextContent('AI draft ready for review');
    expect(screen.queryByText('Adjust draft')).not.toBeInTheDocument();
  });
  it('keeps failed adjustment text available and blocks repeat submissions while busy', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn((_url, init) =>
      init?.method === 'POST'
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(new Response(JSON.stringify({ data: { tasks: [ready] } })))
    );
    vi.stubGlobal('fetch', fetch);
    function Harness() {
      const edits = useCommentEdits(
        'version',
        true,
        vi.fn(async () => {})
      );
      return (
        <CommentEditControls
          task={edits.tasks[0]}
          busy={edits.busyIds.length > 0}
          eligible
          resolved={false}
          agentsEnabled
          onAction={(action, options) => {
            void edits.act('comment', action, options);
          }}
        />
      );
    }
    render(<Harness />);
    fireEvent.change(await screen.findByLabelText('Describe the adjustment'), {
      target: { value: 'Keep the title' },
    });
    const button = screen.getByRole('button', { name: 'Generate adjusted draft' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    finish(new Response(JSON.stringify({ error: 'Draft changed' }), { status: 409 }));
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByLabelText('Describe the adjustment')).toHaveValue('Keep the title');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
});
