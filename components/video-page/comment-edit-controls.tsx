'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { CommentEditAction, CommentEditView } from '@/lib/comment-edit/types';

const labels: Record<CommentEditView['status'], string> = {
  HUMAN: 'For human editor',
  QUEUED: 'Queued for AI',
  PLANNING: 'AI is planning the cut…',
  RENDERING: 'Rendering AI draft…',
  READY: 'AI draft ready for review',
  ACCEPTED: 'AI draft accepted',
  FAILED: 'AI edit needs attention',
};

export function CommentEditControls({
  task,
  busy,
  eligible,
  resolved,
  agentsEnabled,
  onAction,
}: {
  task?: CommentEditView;
  busy: boolean;
  eligible: boolean;
  resolved: boolean;
  agentsEnabled: boolean;
  onAction: (action: CommentEditAction) => void;
}) {
  const [preview, setPreview] = useState(false);
  const status = task?.status ?? 'HUMAN';
  const running = status === 'PLANNING' || status === 'RENDERING';
  return (
    <div
      className="my-2 space-y-2 rounded-lg border bg-muted/30 p-2.5"
      onClick={(event) => event.stopPropagation()}
    >
      <p className="text-xs font-medium" role="status">
        {labels[status]}
      </p>
      {task?.error && (
        <p className="text-xs text-destructive" role="alert">
          {task.error}
        </p>
      )}
      {task?.instruction && status !== 'HUMAN' && (
        <p className="text-xs text-muted-foreground">Requested: {task.instruction}</p>
      )}
      {task?.removedSeconds != null && ['READY', 'ACCEPTED'].includes(status) && (
        <p className="text-xs text-muted-foreground">
          Removed {task.removedSeconds.toFixed(2)}s. Your original video is preserved.
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {!running && !['READY', 'ACCEPTED'].includes(status) && !resolved && agentsEnabled && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || (!eligible && status !== 'QUEUED')}
              onClick={() => onAction('run')}
            >
              Run with AI
            </Button>
            {status !== 'QUEUED' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !eligible}
                onClick={() => onAction('queue')}
              >
                Queue for AI
              </Button>
            )}
          </>
        )}
        {task?.previewUrl && (
          <Button size="sm" variant="outline" onClick={() => setPreview(!preview)}>
            {preview ? 'Hide preview' : 'Preview draft'}
          </Button>
        )}
        {status === 'READY' && (
          <Button size="sm" disabled={busy} onClick={() => onAction('accept')}>
            Accept & resolve
          </Button>
        )}
        {status !== 'HUMAN' && !running && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('human')}>
            Hand to editor
          </Button>
        )}
        {task?.outputHref && (
          <Button size="sm" variant="ghost" asChild>
            <Link href={task.outputHref}>Open draft</Link>
          </Button>
        )}
      </div>
      {!eligible && !task && !resolved && agentsEnabled && (
        <p className="text-xs text-muted-foreground">
          AI cuts need text feedback and a marked In/Out range.
        </p>
      )}
      {preview && task?.previewUrl && (
        <video
          className="w-full rounded"
          controls
          preload="metadata"
          src={task.previewUrl}
          aria-label="AI edited draft"
        />
      )}
    </div>
  );
}
