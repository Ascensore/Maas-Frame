'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { EditLibraryView } from '@/lib/comment-edit/types';

type Asset = EditLibraryView['assets'][number];
const activeStatuses = ['PENDING', 'QUEUED', 'RUNNING'];

function SampleFrame({
  frame,
  title,
}: {
  frame: NonNullable<Asset['visualEvidence']>['frames'][number];
  title: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <figure className="min-w-0 space-y-1">
      {frame.previewUrl && !failed ? (
        // Authenticated same-origin samples should bypass the public image optimizer.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={frame.previewUrl}
          alt={`${title} at ${frame.seconds.toFixed(1)} seconds`}
          className="aspect-video w-full rounded bg-muted object-contain"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <p className="flex aspect-video items-center justify-center rounded bg-muted p-2 text-muted-foreground">
          Preview unavailable. Analyze again to refresh samples.
        </p>
      )}
      <figcaption className="text-muted-foreground">{frame.seconds.toFixed(1)}s</figcaption>
    </figure>
  );
}

// The parent keys this component by source version so an old request cannot update a new source.
export function BrollAnalysis({ asset }: { asset: Asset }) {
  const pending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState<{
    id: string;
    status: string;
    previousJobId: Asset['analysisJobId'];
  } | null>(null);
  const awaitingRefresh =
    submitted &&
    asset.analysisJobId !== submitted.id &&
    asset.analysisJobId === submitted.previousJobId;
  const status = awaitingRefresh ? submitted.status : asset.analysisStatus;
  const active = activeStatuses.includes(status ?? '');
  const failed = status === 'FAILED' || status === 'CANCELED';
  const frames = asset.visualEvidence?.frames;

  async function analyze() {
    if (pending.current || active) return;
    pending.current = true;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch(
        `/api/versions/${encodeURIComponent(asset.versionId)}/broll-evidence`,
        {
          method: 'POST',
        }
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not analyze asset');
      if (!payload.data?.job?.id || !activeStatuses.includes(payload.data.job.status))
        throw new Error('Could not confirm analysis. Refresh and try again.');
      setSubmitted({ ...payload.data.job, previousJobId: asset.analysisJobId });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not analyze asset');
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={submitting || active}
        onClick={analyze}
      >
        {submitting
          ? 'Queueing analysis…'
          : active
            ? 'Analyzing B-roll…'
            : failed
              ? 'Retry B-roll analysis'
              : frames?.length
                ? 'Analyze B-roll again'
                : 'Analyze selected B-roll'}
      </Button>
      {active ? (
        <p role="status">
          {status === 'RUNNING'
            ? 'Sampling B-roll frames…'
            : 'Frame analysis queued. Waiting for the media worker…'}{' '}
          Wait for completion before queueing feedback to use the new samples.
        </p>
      ) : frames?.length ? (
        <p role="status">Visual samples ready. New feedback can use these frames.</p>
      ) : null}
      {(error || failed) && (
        <p role="alert" className="text-destructive">
          {error || asset.analysisError || 'Frame analysis failed. Try again.'}
        </p>
      )}
      {!!frames?.length && (
        <>
          {(active || failed) && (
            <p className="text-muted-foreground">
              Previous samples are shown until a new analysis succeeds.
            </p>
          )}
          <div className="grid grid-cols-3 gap-2" aria-label="B-roll visual samples">
            {frames.map((frame, index) => (
              <SampleFrame key={frame.previewUrl ?? index} frame={frame} title={asset.title} />
            ))}
          </div>
          <p className="text-muted-foreground">
            Samples show individual moments, not the entire clip. Already queued feedback keeps its
            original samples.
          </p>
        </>
      )}
    </div>
  );
}
