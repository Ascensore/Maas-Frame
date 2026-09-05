'use client';

import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Scissors,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { overrideSummary } from '@/lib/rough-cut/overrides';
import type { CutIsland } from '@/lib/rough-cut/types';
import { cn } from '@/lib/utils';
import type { useRoughCutReview } from '@/components/video-page/hooks/use-rough-cut-review';
import {
  RoughCutSourcePreview,
  type RoughCutSourcePreviewHandle,
} from '@/components/video-page/rough-cut-source-preview';

/**
 * What the assembler removed from the delivered cut, why, and what the reviewer
 * wants back. Everything here works on the output video the page is already
 * playing: the source preview follows it, ranges are drawn on it, and a
 * re-render puts a new version of it on the same page.
 *
 * Only editors reach this: the API withholds the review from everyone else, so
 * the pane is never mounted without the permission to act on what it shows.
 */

interface RoughCutReviewPaneProps {
  review: ReturnType<typeof useRoughCutReview>;
  getCurrentTime: () => number;
  onSeekOutput: (seconds: number) => void;
}

const REASON_LABELS: Record<string, string> = {
  DEAD_AIR: 'Dead air',
  FALSE_START: 'False start',
  REJECTED_TAKE: 'Rejected take',
  REVIEWER: 'Reviewer cut',
};

const MAX_VISIBLE_WARNINGS = 5;

const NOTE_MAX_LENGTH = 300;

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0.0s';
  return `${seconds.toFixed(1)}s`;
}

function parseSeconds(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function RoughCutReviewPane({
  review,
  getCurrentTime,
  onSeekOutput,
}: RoughCutReviewPaneProps) {
  const {
    review: payload,
    roughCut,
    draft,
    sources,
    loading,
    saving,
    rendering,
    error,
    isDirty,
    needsRender,
    renderStatus,
  } = review;

  const previewRef = useRef<RoughCutSourcePreviewHandle>(null);
  const [showAllWarnings, setShowAllWarnings] = useState(false);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [note, setNote] = useState('');

  /**
   * The one pass over the program per change: the counts, the lengths and the
   * stale keys all come from here rather than from three separate applications
   * of the same overrides.
   */
  const summary = useMemo(
    () => (payload ? overrideSummary(payload.decisions, draft) : null),
    [draft, payload]
  );

  const clipOffsets = useMemo(() => {
    const offsets = new Map<string, number>();
    for (const clip of payload?.decisions.clips ?? [])
      offsets.set(clip.versionId, clip.offsetSeconds);
    return offsets;
  }, [payload]);

  const islands = useMemo(() => {
    const list: CutIsland[] = [...(payload?.decisions.cuts ?? [])];
    const axis = (island: CutIsland) =>
      (clipOffsets.get(island.sourceVersionId) ?? 0) + island.inSeconds;
    return list.sort((a, b) => axis(a) - axis(b));
  }, [clipOffsets, payload]);

  const reasonCounts = useMemo(() => {
    const counts = { DEAD_AIR: 0, FALSE_START: 0, REJECTED_TAKE: 0 };
    for (const island of islands) {
      if (island.reason.code in counts) {
        counts[island.reason.code as keyof typeof counts] += 1;
      }
    }
    return counts;
  }, [islands]);

  const warnings = Array.isArray(roughCut?.warnings) ? roughCut.warnings : [];
  const visibleWarnings = showAllWarnings ? warnings : warnings.slice(0, MAX_VISIBLE_WARNINGS);
  // The draft's own stale keys, so the list and the count above it can never
  // disagree about what the reviewer is still holding a decision on.
  const staleKeys = summary?.staleKeys ?? [];

  const start = parseSeconds(rangeStart);
  const end = parseSeconds(rangeEnd);
  const canAddRange = start !== null && end !== null && end > start;
  const busy = saving || rendering;

  if (loading && !payload) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading the cut review…
      </p>
    );
  }

  if (!payload) {
    return (
      <p className="text-muted-foreground text-sm">This video was not cut from a rough cut.</p>
    );
  }

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <p className="text-sm font-medium">
          {islands.length} {islands.length === 1 ? 'cut' : 'cuts'} · dead air{' '}
          {reasonCounts.DEAD_AIR} · false starts {reasonCounts.FALSE_START} · rejected takes{' '}
          {reasonCounts.REJECTED_TAKE}
        </p>
        {summary && (
          <p className="text-muted-foreground text-xs">
            Program {formatClock(summary.originalSeconds)} → {formatClock(summary.programSeconds)}
            {staleKeys.length > 0 && (
              <span className="ml-1">
                · {staleKeys.length} decision{staleKeys.length === 1 ? '' : 's'} no longer in this
                cut
              </span>
            )}
          </p>
        )}
        {visibleWarnings.length > 0 && (
          <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
            {visibleWarnings.map((warning) => (
              <p
                key={`${warning.code}-${warning.message}`}
                className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
              >
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{warning.message}</span>
              </p>
            ))}
            {warnings.length > MAX_VISIBLE_WARNINGS && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setShowAllWarnings((current) => !current)}
              >
                {showAllWarnings
                  ? 'Show fewer'
                  : `Show ${warnings.length - MAX_VISIBLE_WARNINGS} more`}
              </Button>
            )}
          </div>
        )}
      </section>

      <RoughCutSourcePreview
        ref={previewRef}
        sources={sources}
        sourceTimeAt={review.sourceTimeAt}
        getCurrentTime={getCurrentTime}
      />

      <section className="space-y-2">
        <p className="text-xs font-semibold tracking-wide uppercase">Cut a range from the output</p>
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-muted-foreground block text-xs" htmlFor="rough-cut-range-start">
              Start (seconds)
            </label>
            <Input
              id="rough-cut-range-start"
              type="number"
              min={0}
              step={0.1}
              value={rangeStart}
              onChange={(event) => setRangeStart(event.target.value)}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRangeStart(getCurrentTime().toFixed(2))}
          >
            Use current time
          </Button>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-muted-foreground block text-xs" htmlFor="rough-cut-range-end">
              End (seconds)
            </label>
            <Input
              id="rough-cut-range-end"
              type="number"
              min={0}
              step={0.1}
              value={rangeEnd}
              onChange={(event) => setRangeEnd(event.target.value)}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRangeEnd(getCurrentTime().toFixed(2))}
          >
            Use current time
          </Button>
        </div>
        <Input
          aria-label="Why this range is coming out"
          value={note}
          maxLength={NOTE_MAX_LENGTH}
          placeholder="Why is this coming out?"
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          size="sm"
          disabled={!canAddRange}
          onClick={() => {
            if (start === null || end === null) return;
            review.addExtraCutFromTimeline(start, end, note);
            setNote('');
          }}
        >
          <Scissors className="h-3.5 w-3.5" />
          Add cut
        </Button>
        {draft.extraCuts.length > 0 && (
          <ul className="space-y-1">
            {draft.extraCuts.map((cut) => (
              <li
                key={cut.key}
                className="border-border flex items-start justify-between gap-2 rounded-lg border p-2"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium">
                    {formatClock(cut.inSeconds)}–{formatClock(cut.outSeconds)} ·{' '}
                    {formatDuration(cut.outSeconds - cut.inSeconds)} of{' '}
                    {sources.find((source) => source.versionId === cut.sourceVersionId)?.title ??
                      cut.sourceVersionId}
                  </p>
                  {cut.note && <p className="text-muted-foreground text-xs">{cut.note}</p>}
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Remove this cut"
                  onClick={() => review.removeExtraCut(cut.key)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <p className="text-xs font-semibold tracking-wide uppercase">What was cut</p>
        {islands.length === 0 && (
          <p className="text-muted-foreground text-xs">Nothing was cut from this program.</p>
        )}
        <ul className="space-y-2">
          {islands.map((island) => {
            const action = draft.cuts[island.key] ?? null;
            const outputSeconds = review.timelineTimeForSource(
              island.sourceVersionId,
              island.inSeconds
            );
            return (
              <li key={island.key} className="border-border space-y-1.5 rounded-lg border p-2">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="secondary">
                    {REASON_LABELS[island.reason.code] ?? island.reason.code}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {formatClock(island.inSeconds)}–{formatClock(island.outSeconds)} ·{' '}
                    {formatDuration(island.outSeconds - island.inSeconds)}
                  </span>
                </div>
                {island.transcriptText && (
                  <p className="text-muted-foreground line-clamp-2 text-xs">
                    {island.transcriptText}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => previewRef.current?.playRange(island)}
                  >
                    <Play className="h-3 w-3" />
                    Play source
                  </Button>
                  {outputSeconds !== null && (
                    <Button variant="outline" size="xs" onClick={() => onSeekOutput(outputSeconds)}>
                      Output
                    </Button>
                  )}
                  <Button
                    variant={action === 'restore' ? 'default' : 'outline'}
                    size="xs"
                    aria-pressed={action === 'restore'}
                    onClick={() =>
                      review.setCutAction(island.key, action === 'restore' ? null : 'restore')
                    }
                  >
                    <RotateCcw className="h-3 w-3" />
                    Restore
                  </Button>
                  <Button
                    variant={action === 'keep' ? 'default' : 'outline'}
                    size="xs"
                    aria-pressed={action === 'keep'}
                    onClick={() =>
                      review.setCutAction(island.key, action === 'keep' ? null : 'keep')
                    }
                  >
                    <Check className="h-3 w-3" />
                    Keep
                  </Button>
                </div>
              </li>
            );
          })}
          {staleKeys.map((key) => (
            <li
              key={key}
              className="border-border text-muted-foreground space-y-1 rounded-lg border border-dashed p-2 text-xs"
            >
              <p className="truncate font-mono">{key}</p>
              <p>Decided on before, no longer in this cut.</p>
              <Button variant="ghost" size="xs" onClick={() => review.setCutAction(key, null)}>
                Forget it
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!isDirty || busy} onClick={() => void review.save()}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save changes
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={
              !needsRender ||
              isDirty ||
              busy ||
              (renderStatus !== 'idle' && renderStatus !== 'failed')
            }
            onClick={() => void review.render()}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', rendering && 'animate-spin')} />
            Re-render
          </Button>
        </div>
        {(renderStatus === 'queued' || renderStatus === 'running') && (
          <p className="text-muted-foreground text-xs">
            Rendering… a new version appears here when it is done
          </p>
        )}
        {renderStatus === 'failed' && payload.render.error && (
          <p className="text-destructive text-xs">{payload.render.error}</p>
        )}
        {needsRender && renderStatus !== 'queued' && renderStatus !== 'running' && (
          <p className="text-muted-foreground text-xs">Changes saved but not rendered yet</p>
        )}
      </section>

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
