'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  AlertTriangle,
  Check,
  Film,
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

/**
 * What the assembler removed from the delivered cut, why, and what the reviewer
 * wants back. Everything here works on the output video the page is already
 * playing: the source preview follows it, ranges are drawn on it, and a
 * re-render puts a new version of it on the same page.
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

/** How far the preview may drift from the output before it is worth a seek. */
const FOLLOW_TOLERANCE_SECONDS = 0.5;

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
    canEdit,
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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingPlayRef = useRef<{
    versionId: string;
    inSeconds: number;
    outSeconds: number;
  } | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [followOutput, setFollowOutput] = useState(false);
  const [showAllWarnings, setShowAllWarnings] = useState(false);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [note, setNote] = useState('');

  const selected = useMemo(() => {
    const explicit = sources.find((source) => source.versionId === selectedVersionId);
    if (explicit) return explicit;
    return sources.find((source) => !source.missing && source.playbackUrl) ?? sources[0] ?? null;
  }, [selectedVersionId, sources]);

  const selectedVersion = selected?.versionId ?? null;
  const playbackUrl = selected?.playbackUrl ?? null;
  const playbackKind = selected?.playbackKind ?? null;

  // hls.js only when the browser cannot play the playlist itself, the way the
  // main player attaches it.
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !playbackUrl || playbackKind !== 'hls') return;
    if (element.canPlayType('application/vnd.apple.mpegurl') || !Hls.isSupported()) {
      element.src = playbackUrl;
      element.load();
      return;
    }
    const hls = new Hls();
    hls.attachMedia(element);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(playbackUrl));
    return () => hls.destroy();
  }, [playbackKind, playbackUrl]);

  /** A "play this cut" click waits for its clip to be the one loaded. */
  const applyPendingPlay = useCallback(() => {
    const pending = pendingPlayRef.current;
    const element = videoRef.current;
    if (!pending || !element || pending.versionId !== selectedVersion) return;
    pendingPlayRef.current = null;
    element.currentTime = pending.inSeconds;
    const stopAt = pending.outSeconds;
    const stopAtOut = () => {
      if (element.currentTime < stopAt) return;
      element.pause();
      element.removeEventListener('timeupdate', stopAtOut);
    };
    element.addEventListener('timeupdate', stopAtOut);
    void element.play().catch(() => {});
  }, [selectedVersion]);

  useEffect(() => {
    applyPendingPlay();
  }, [applyPendingPlay]);

  const { sourceTimeAt } = review;
  useEffect(() => {
    if (!followOutput) return;
    let raf = 0;
    const tick = () => {
      const point = sourceTimeAt(getCurrentTime());
      if (point) {
        if (point.sourceVersionId !== selectedVersion) {
          setSelectedVersionId(point.sourceVersionId);
        } else {
          const element = videoRef.current;
          if (
            element &&
            element.paused &&
            Math.abs(element.currentTime - point.seconds) > FOLLOW_TOLERANCE_SECONDS
          ) {
            element.currentTime = point.seconds;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [followOutput, getCurrentTime, selectedVersion, sourceTimeAt]);

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
  const staleKeys = payload?.applied?.staleCutKeys ?? [];

  const playIsland = (island: CutIsland) => {
    setFollowOutput(false);
    pendingPlayRef.current = {
      versionId: island.sourceVersionId,
      inSeconds: island.inSeconds,
      outSeconds: island.outSeconds,
    };
    setSelectedVersionId(island.sourceVersionId);
    applyPendingPlay();
  };

  const start = parseSeconds(rangeStart);
  const end = parseSeconds(rangeEnd);
  const canAddRange = start !== null && end !== null && end > start;

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
            {summary.staleKeys.length > 0 && (
              <span className="ml-1">
                · {summary.staleKeys.length} decision
                {summary.staleKeys.length === 1 ? '' : 's'} no longer in this cut
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

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold tracking-wide uppercase">Source</p>
          <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              className="accent-primary"
              checked={followOutput}
              onChange={(event) => setFollowOutput(event.target.checked)}
            />
            Follow output
          </label>
        </div>
        {sources.length > 1 && (
          <select
            className="border-input bg-card h-9 w-full rounded-xl border px-3 text-sm"
            value={selectedVersion ?? ''}
            onChange={(event) => setSelectedVersionId(event.target.value)}
          >
            {sources.map((source) => (
              <option
                key={source.versionId}
                value={source.versionId}
                disabled={source.missing || !source.playbackUrl}
              >
                {source.title} · {source.role}
                {source.missing ? ' (missing)' : ''}
              </option>
            ))}
          </select>
        )}
        {playbackUrl ? (
          <video
            ref={videoRef}
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={applyPendingPlay}
            src={playbackKind === 'file' ? playbackUrl : undefined}
            className="w-full rounded-lg bg-black"
          />
        ) : (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Film className="h-3.5 w-3.5" />
            {selected?.missing
              ? 'The clip this was cut from has been deleted.'
              : 'This clip cannot be played here.'}
          </p>
        )}
      </section>

      {canEdit && (
        <section className="space-y-2">
          <p className="text-xs font-semibold tracking-wide uppercase">
            Cut a range from the output
          </p>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <label className="text-muted-foreground text-xs" htmlFor="rough-cut-range-start">
                Start
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
              <label className="text-muted-foreground text-xs" htmlFor="rough-cut-range-end">
                End
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
                      {formatClock(cut.inSeconds)}–{formatClock(cut.outSeconds)} of{' '}
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
      )}

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
                  <Button variant="outline" size="xs" onClick={() => playIsland(island)}>
                    <Play className="h-3 w-3" />
                    Play source
                  </Button>
                  {outputSeconds !== null && (
                    <Button variant="outline" size="xs" onClick={() => onSeekOutput(outputSeconds)}>
                      Output
                    </Button>
                  )}
                  {canEdit && (
                    <>
                      <Button
                        variant={action === 'restore' ? 'default' : 'outline'}
                        size="xs"
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
                        onClick={() =>
                          review.setCutAction(island.key, action === 'keep' ? null : 'keep')
                        }
                      >
                        <Check className="h-3 w-3" />
                        Keep
                      </Button>
                    </>
                  )}
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
              {canEdit && (
                <Button variant="ghost" size="xs" onClick={() => review.setCutAction(key, null)}>
                  Forget it
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {canEdit && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!isDirty || saving} onClick={() => void review.save()}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save changes
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={
                !needsRender ||
                isDirty ||
                rendering ||
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
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
