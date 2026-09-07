'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { CommentEditAction, CommentEditView } from '@/lib/comment-edit/types';
import type { EditOptions } from '@/lib/comment-edit/plan';

export function CommentDraftReview({
  task,
  busy,
  agentsEnabled,
  onAction,
}: {
  task: CommentEditView;
  busy: boolean;
  agentsEnabled: boolean;
  onAction: (action: CommentEditAction, options?: EditOptions) => void;
}) {
  const [adjustment, setAdjustment] = useState('');
  const ready = task.status === 'READY' || task.status === 'ACCEPTED';
  return (
    <div className="space-y-2 text-xs">
      {task.adjustment && <p>Latest adjustment: {task.adjustment}</p>}
      {!!task.changes?.length && (
        <details>
          <summary className="cursor-pointer">What changed</summary>
          <p className="mt-2 text-muted-foreground">Times refer to the original reviewed video.</p>
          <ul className="mt-1 space-y-1">
            {task.changes.map((change, index) => (
              <li key={index}>
                {change.start.toFixed(2)}–{change.end.toFixed(2)}s: {change.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
      {ready && agentsEnabled && task.runId && (
        <details>
          <summary className="cursor-pointer">Adjust draft</summary>
          <div className="mt-2 space-y-2">
            <label className="block">
              Describe the adjustment
              <textarea
                className="mt-1 w-full rounded border bg-background p-2"
                rows={3}
                maxLength={2000}
                value={adjustment}
                onChange={(event) => setAdjustment(event.target.value)}
                disabled={busy}
                placeholder="Keep the pause, but shorten the title to two seconds."
              />
            </label>
            <p className="text-muted-foreground">
              Creates a new draft from the original reviewed footage. Earlier drafts stay available
              below.{' '}
              {task.batchSize && task.batchSize > 1
                ? 'This rebuilds the shared draft, preserves the other comments’ edits, and reopens the whole batch.'
                : 'The comment reopens for review.'}
            </p>
            <Button
              type="button"
              size="sm"
              disabled={busy || !adjustment.trim()}
              onClick={() =>
                onAction('revise', { adjustment: adjustment.trim(), expectedRunId: task.runId! })
              }
            >
              Generate adjusted draft
            </Button>
          </div>
        </details>
      )}
      {task.status === 'ACCEPTED' && task.runId && (
        <div className="space-y-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onAction('undo', { expectedRunId: task.runId! })}
          >
            Undo acceptance
          </Button>
          <p className="text-muted-foreground">
            Reopens{' '}
            {task.batchSize && task.batchSize > 1 ? 'all comments in this batch' : 'this comment'}{' '}
            and keeps the draft available for review.
          </p>
        </div>
      )}
      {!!task.revisions?.length && (
        <details>
          <summary className="cursor-pointer">Earlier drafts ({task.revisions.length})</summary>
          <div className="mt-2 space-y-2">
            {task.revisions.map((revision) => (
              <details key={revision.id} className="rounded border p-2">
                <summary className="cursor-pointer">
                  {new Date(revision.createdAt).toLocaleString()} ·{' '}
                  {revision.status === 'FAILED'
                    ? 'Failed attempt'
                    : revision.status === 'ACCEPTED'
                      ? 'Previously accepted'
                      : 'Draft'}
                </summary>
                {revision.adjustment && <p className="mt-2">Adjustment: {revision.adjustment}</p>}
                {revision.error && <p className="text-destructive">{revision.error}</p>}
                {revision.previewUrl ? (
                  <video
                    className="mt-2 w-full rounded"
                    controls
                    preload="none"
                    src={revision.previewUrl}
                    aria-label={`Earlier AI draft ${revision.id}`}
                  />
                ) : (
                  <p className="mt-2 text-muted-foreground">
                    No preview is available for this attempt.
                  </p>
                )}
                {revision.outputHref && (
                  <Link className="mt-1 inline-block underline" href={revision.outputHref}>
                    Open earlier draft
                  </Link>
                )}
              </details>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
