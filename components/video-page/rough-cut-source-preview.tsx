'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import Hls from 'hls.js';
import { Film } from 'lucide-react';
import type { RoughCutReviewSource } from '@/lib/rough-cut/review';
import type { SourcePoint } from '@/components/video-page/hooks/use-rough-cut-review';

/**
 * The uncut footage beside the cut. It plays one clip at a time, can be told to
 * play a single removed range, and can follow the output player so the reviewer
 * sees what the frame they are on looked like before the pass.
 */

interface RoughCutSourcePreviewProps {
  sources: RoughCutReviewSource[];
  /** Where the output's second sits in the footage, or null between programs. */
  sourceTimeAt: (seconds: number) => SourcePoint | null;
  /** The output player's clock, read live rather than through a render. */
  getCurrentTime: () => number;
}

export interface RoughCutSourcePreviewHandle {
  /** Show a removed range: select its clip, seek to its start, stop at its end. */
  playRange: (range: { sourceVersionId: string; inSeconds: number; outSeconds: number }) => void;
}

/** How far the preview may drift from the output before it is worth a seek. */
const FOLLOW_TOLERANCE_SECONDS = 0.5;

/** `HTMLMediaElement.HAVE_METADATA`: below it a seek is dropped and the clip starts at 0. */
const HAVE_METADATA = 1;

export const RoughCutSourcePreview = forwardRef<
  RoughCutSourcePreviewHandle,
  RoughCutSourcePreviewProps
>(function RoughCutSourcePreview({ sources, sourceTimeAt, getCurrentTime }, ref) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const pendingPlayRef = useRef<{
    versionId: string;
    inSeconds: number;
    outSeconds: number;
  } | null>(null);
  /** The one live "stop at the out point" listener, so clicks never stack them. */
  const stopListenerRef = useRef<(() => void) | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [followOutput, setFollowOutput] = useState(false);

  const selected = useMemo(() => {
    const explicit = sources.find((source) => source.versionId === selectedVersionId);
    if (explicit) return explicit;
    return sources.find((source) => !source.missing && source.playbackUrl) ?? sources[0] ?? null;
  }, [selectedVersionId, sources]);

  const selectedVersion = selected?.versionId ?? null;
  const playbackUrl = selected?.playbackUrl ?? null;
  const playbackKind = selected?.playbackKind ?? null;

  const clearStopListener = useCallback(() => {
    const listener = stopListenerRef.current;
    stopListenerRef.current = null;
    if (listener) videoRef.current?.removeEventListener('timeupdate', listener);
  }, []);

  /**
   * Both kinds of source are driven from here rather than from a `src` prop, so
   * there is one place that owns what the element is playing and hls.js is
   * always torn down before the element is pointed at anything else.
   */
  useEffect(() => {
    const destroyHls = () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
    // Torn down first and returned as the cleanup, so an instance is never left
    // attached to a clip we have moved off — including the case where the
    // element itself goes away because the next clip has nothing to play.
    destroyHls();
    const element = videoRef.current;
    if (!element) return destroyHls;
    if (!playbackUrl) {
      element.removeAttribute('src');
      element.load();
      return destroyHls;
    }
    if (
      playbackKind !== 'hls' ||
      element.canPlayType('application/vnd.apple.mpegurl') ||
      !Hls.isSupported()
    ) {
      element.src = playbackUrl;
      element.load();
      return destroyHls;
    }
    const hls = new Hls();
    hlsRef.current = hls;
    hls.attachMedia(element);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(playbackUrl));
    return destroyHls;
  }, [playbackKind, playbackUrl]);

  /**
   * A "play this cut" click waits for its clip to be the loaded one *and* for
   * that clip to have metadata: an HLS source seeked too early ignores the seek
   * and plays from the top, which is the one thing this button must not do.
   */
  const applyPendingPlay = useCallback(() => {
    const pending = pendingPlayRef.current;
    const element = videoRef.current;
    if (!pending || !element) return;
    if (pending.versionId !== selectedVersion) return;
    if (element.readyState < HAVE_METADATA) return;
    pendingPlayRef.current = null;
    clearStopListener();
    element.currentTime = pending.inSeconds;
    const stopAt = pending.outSeconds;
    const stopAtOut = () => {
      if (element.currentTime < stopAt) return;
      element.pause();
      clearStopListener();
    };
    stopListenerRef.current = stopAtOut;
    element.addEventListener('timeupdate', stopAtOut);
    void element.play().catch(() => {});
  }, [clearStopListener, selectedVersion]);

  useEffect(() => {
    applyPendingPlay();
  }, [applyPendingPlay]);

  // Nothing from the previous clip keeps listening to the next one.
  useEffect(() => {
    const element = videoRef.current;
    return () => {
      const listener = stopListenerRef.current;
      stopListenerRef.current = null;
      if (element && listener) element.removeEventListener('timeupdate', listener);
    };
  }, [selectedVersion]);

  useImperativeHandle(
    ref,
    () => ({
      playRange: (range) => {
        setFollowOutput(false);
        pendingPlayRef.current = {
          versionId: range.sourceVersionId,
          inSeconds: range.inSeconds,
          outSeconds: range.outSeconds,
        };
        setSelectedVersionId(range.sourceVersionId);
        applyPendingPlay();
      },
    }),
    [applyPendingPlay]
  );

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

  return (
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
          aria-label="Source clip to preview"
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
          aria-label={`Uncut source: ${selected?.title ?? 'clip'}`}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={applyPendingPlay}
          onSeeked={applyPendingPlay}
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
  );
});
