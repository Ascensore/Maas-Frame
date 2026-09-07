'use client';

import { EditPresetLibrary } from '@/components/video-page/edit-preset-library';
import { BrollAnalysis } from '@/components/video-page/broll-analysis';
import { CommentDraftReview } from '@/components/video-page/comment-draft-review';
import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { CommentEditAction, CommentEditView, EditLibraryView } from '@/lib/comment-edit/types';
import type { EditOptions } from '@/lib/comment-edit/plan';

const labels: Record<CommentEditView['status'], string> = {
  HUMAN: 'For human editor',
  QUEUED: 'Queued for AI',
  PLANNING: 'AI is planning the edit…',
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
  library,
}: {
  task?: CommentEditView;
  busy: boolean;
  eligible: boolean;
  resolved: boolean;
  agentsEnabled: boolean;
  onAction: (action: CommentEditAction, options?: EditOptions) => void;
  library?: EditLibraryView;
}) {
  const [preview, setPreview] = useState(false);
  const [assetVersionId, setAssetVersionId] = useState('');
  const [accent, setAccent] = useState<string | undefined>();
  const selectedAsset = library?.assets.find((asset) => asset.versionId === assetVersionId);
  const [presetId, setPresetId] = useState('');
  const options = {
    ...(assetVersionId ? { assetVersionId } : {}),
    ...(presetId ? { presetId } : {}),
    ...(accent ? { accent } : {}),
  };
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
      {task && (
        <CommentDraftReview
          key={task.runId ?? task.commentId}
          task={task}
          busy={busy}
          agentsEnabled={agentsEnabled}
          onAction={onAction}
        />
      )}
      {task?.batchSize && task.batchSize > 1 && (
        <p className="text-xs text-muted-foreground">
          Shared draft for {task.batchSize} comments. Accepting or handing off applies to the whole
          batch.
        </p>
      )}
      {library &&
        !running &&
        !resolved &&
        !['QUEUED', 'READY', 'ACCEPTED'].includes(status) &&
        agentsEnabled && (
          <details className="text-xs">
            <summary className="cursor-pointer">Graphics & B-roll presets</summary>
            <div className="mt-2 space-y-2">
              <p>Describe the graphic in your feedback, including the exact title and subtitle.</p>
              <EditPresetLibrary
                library={library}
                selected={presetId}
                onSelect={(p) => {
                  setPresetId(p?.id ?? '');
                  setAccent(p?.accent);
                }}
              />
              <label className="flex items-center gap-2">
                Accent color{' '}
                <input
                  type="color"
                  aria-label="Graphic accent color"
                  value={accent ?? '#D7FF3F'}
                  onChange={(e) => setAccent(e.target.value)}
                />
              </label>
              <label className="block">
                B-roll source
                <select
                  className="mt-1 w-full rounded border bg-background p-1"
                  value={assetVersionId}
                  onChange={(e) => setAssetVersionId(e.target.value)}
                >
                  <option value="">AI selects from videos marked as B-roll</option>
                  {library.assets.map((asset) => (
                    <option key={asset.versionId} value={asset.versionId}>
                      {asset.title} ({asset.duration.toFixed(1)}s)
                      {asset.visualEvidence ? ' · visual samples ready' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {selectedAsset && (
                <BrollAnalysis key={selectedAsset.versionId} asset={selectedAsset} />
              )}
              <p className="text-muted-foreground">
                Analyzed assets supply three sampled frames to the AI. For automatic selection, add
                metadata “usage” = “broll” to uploaded videos and give them descriptive titles.
                B-roll covers the picture and keeps speech audio.
              </p>
            </div>
          </details>
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
              onClick={() => onAction('run', status === 'QUEUED' ? undefined : options)}
            >
              Run with AI
            </Button>
            {status !== 'QUEUED' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !eligible}
                onClick={() => onAction('queue', options)}
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
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              onAction('accept', task?.runId ? { expectedRunId: task.runId } : undefined)
            }
          >
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
          AI edits need text feedback and a marked In/Out range.
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
      {task?.previewUrl && (
        <details className="text-xs">
          <summary className="cursor-pointer">Continue in Premiere or Resolve</summary>
          <p className="mt-2">
            In the OpenFrame editor panel, paste this comment ID and choose Import AI draft:
          </p>
          <input
            className="my-1 w-full rounded border bg-background p-1"
            aria-label="Comment ID for native editor"
            readOnly
            value={task.commentId}
            onFocus={(e) => e.target.select()}
          />
          <p className="text-muted-foreground">
            Creates a new timeline with editable cuts and B-roll. Graphics use rendered overlay
            sections.
          </p>
        </details>
      )}
    </div>
  );
}
