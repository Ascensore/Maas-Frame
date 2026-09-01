'use client';

import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { Captions, Loader2, Search, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { applyTranscriptHighlight } from '@/lib/transcript-active';
import { commentRangeFromSpans, isPointClick, type TimedSpan } from '@/lib/transcript-selection';
import { cn } from '@/lib/utils';

export type TranscriptWord = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptSegment = {
  id: string;
  startSec: number;
  endSec: number;
  speaker: string | null;
  text: string;
  words: TranscriptWord[] | unknown;
  position: number;
};

export type TranscriptPayload = {
  id: string;
  versionId: string;
  language: string;
  provider: string;
  status: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';
  segments: TranscriptSegment[];
} | null;

function asWords(value: unknown): TranscriptWord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (word): word is TranscriptWord =>
      typeof word === 'object' &&
      word !== null &&
      typeof (word as TranscriptWord).text === 'string' &&
      typeof (word as TranscriptWord).start === 'number' &&
      typeof (word as TranscriptWord).end === 'number'
  );
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function toVttTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

interface TranscriptPaneProps {
  versionId: string | null;
  getCurrentTime: () => number;
  canManage: boolean;
  onSeek: (
    seconds: number,
    options?: { pauseAfterSeek?: boolean; timestampEnd?: number | null }
  ) => void;
  onCommentRange: (start: number, end: number, quote: string) => void;
}

type IndexedSpan = TimedSpan & { key: string };

function spansForSegment(segment: TranscriptSegment): IndexedSpan[] {
  const words = asWords(segment.words);
  if (words.length > 0) {
    return words.map((word, wordIndex) => ({
      key: `${segment.id}-${wordIndex}`,
      start: word.start,
      end: word.end,
      text: word.text,
    }));
  }
  return [
    {
      key: segment.id,
      start: segment.startSec,
      end: segment.endSec,
      text: segment.text,
    },
  ];
}

export const TranscriptPane = memo(function TranscriptPane({
  versionId,
  getCurrentTime,
  canManage,
  onSeek,
  onCommentRange,
}: TranscriptPaneProps) {
  const [transcript, setTranscript] = useState<TranscriptPayload>(null);
  const [loading, setLoading] = useState(false);
  const [enqueueing, setEnqueueing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragFromIndex = useRef<number | null>(null);

  const fetchTranscript = useCallback(async () => {
    if (!versionId) {
      setTranscript(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/versions/${versionId}/transcript`);
      if (!response.ok) {
        throw new Error('Failed to load transcript');
      }
      const body = (await response.json()) as { data?: { transcript: TranscriptPayload } };
      setTranscript(body.data?.transcript ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load transcript');
    } finally {
      setLoading(false);
    }
  }, [versionId]);

  useEffect(() => {
    void fetchTranscript();
  }, [fetchTranscript]);

  useEffect(() => {
    if (!versionId) return;
    if (transcript?.status !== 'PENDING' && transcript?.status !== 'RUNNING') return;
    const timer = window.setInterval(() => {
      void fetchTranscript();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [versionId, transcript?.status, fetchTranscript]);

  const filtered = useMemo(() => {
    const segments = transcript?.segments ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return segments;
    return segments.filter((segment) => segment.text.toLowerCase().includes(needle));
  }, [transcript, query]);

  const flatSpans = useMemo(() => filtered.flatMap(spansForSegment), [filtered]);
  const spanIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    flatSpans.forEach((span, index) => map.set(span.key, index));
    return map;
  }, [flatSpans]);
  const showList = transcript?.status === 'READY' && filtered.length > 0;
  const onSeekRef = useRef(onSeek);
  const onCommentRangeRef = useRef(onCommentRange);
  const flatSpansRef = useRef(flatSpans);

  useEffect(() => {
    onSeekRef.current = onSeek;
    onCommentRangeRef.current = onCommentRange;
    flatSpansRef.current = flatSpans;
  }, [flatSpans, onCommentRange, onSeek]);

  useEffect(() => {
    if (!showList) return;
    const root = listRef.current;
    if (!root) return;
    let raf = 0;
    const tick = () => {
      applyTranscriptHighlight(
        root.querySelectorAll<HTMLElement>('[data-transcript-range]'),
        getCurrentTime()
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [showList, getCurrentTime, filtered]);

  const handleDownloadVtt = () => {
    if (!transcript || transcript.segments.length === 0) return;
    const body = transcript.segments
      .map((segment) => {
        const start = toVttTime(segment.startSec);
        const end = toVttTime(segment.endSec);
        return `${start} --> ${end}\n${segment.text}`;
      })
      .join('\n\n');
    const blob = new Blob([`WEBVTT\n\n${body}\n`], { type: 'text/vtt' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'transcript.vtt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleEnqueue = async () => {
    if (!versionId) return;
    setEnqueueing(true);
    setError(null);
    try {
      const response = await fetch(`/api/versions/${versionId}/transcript`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: 'en' }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          typeof body?.error === 'string' ? body.error : 'Failed to start transcription'
        );
      }
      await fetchTranscript();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start transcription');
    } finally {
      setEnqueueing(false);
    }
  };

  const handleUpload = async (file: File) => {
    if (!versionId) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('language', 'en');
      const response = await fetch(`/api/versions/${versionId}/transcript`, {
        method: 'PUT',
        body: form,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          typeof body?.error === 'string' ? body.error : 'Failed to upload transcript'
        );
      }
      await fetchTranscript();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload transcript');
    } finally {
      setUploading(false);
    }
  };

  const commitPointer = useCallback((toIndex: number) => {
    const fromIndex = dragFromIndex.current;
    dragFromIndex.current = null;
    if (fromIndex === null) return;
    const range = commentRangeFromSpans(flatSpansRef.current, fromIndex, toIndex);
    if (!range) return;
    if (fromIndex === toIndex || isPointClick(range)) {
      onSeekRef.current(range.start, { pauseAfterSeek: false });
      return;
    }
    onCommentRangeRef.current(range.start, range.end, range.quote);
  }, []);

  useEffect(() => {
    const onUp = (event: PointerEvent) => {
      if (dragFromIndex.current === null) return;
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const target = el?.closest('[data-span-index]');
      const toIndex = target
        ? Number((target as HTMLElement).dataset.spanIndex)
        : dragFromIndex.current;
      if (Number.isNaN(toIndex)) {
        dragFromIndex.current = null;
        return;
      }
      commitPointer(toIndex);
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [commitPointer]);

  if (!versionId) {
    return <p className="text-sm text-muted-foreground">Select a version to see its transcript.</p>;
  }

  const manageBusy = enqueueing || uploading;

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search transcript"
            className="pl-8 h-8"
          />
        </div>
        {transcript?.status === 'READY' && transcript.segments.length > 0 && (
          <Button size="sm" variant="outline" className="h-8" onClick={handleDownloadVtt}>
            VTT
          </Button>
        )}
      </div>

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="h-8"
            onClick={() => void handleEnqueue()}
            disabled={manageBusy}
          >
            {enqueueing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Captions className="h-4 w-4" />
            )}
            <span className="ml-1">
              {transcript ? 'Re-run speech-to-text' : 'Generate transcript'}
            </span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => fileInputRef.current?.click()}
            disabled={manageBusy}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            <span className="ml-1">Upload SRT / VTT</span>
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".srt,.vtt,text/vtt,application/x-subrip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void handleUpload(file);
            }}
          />
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading && !transcript ? (
        <p className="text-sm text-muted-foreground">Loading transcript…</p>
      ) : transcript?.status === 'PENDING' || transcript?.status === 'RUNNING' ? (
        <p className="text-sm text-muted-foreground">Transcription in progress…</p>
      ) : transcript?.status === 'FAILED' ? (
        <p className="text-sm text-destructive">
          Transcription failed. Try again or upload a file.
        </p>
      ) : !showList ? (
        <div className="text-sm text-muted-foreground space-y-1">
          <p>
            {query
              ? 'No matching lines.'
              : canManage
                ? 'No transcript yet. Generate one from the audio, or upload a timed SRT / VTT.'
                : 'No transcript yet.'}
          </p>
        </div>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">
            Click a word to jump. Drag across words to mark In and Out.
          </p>
          <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto pr-1 select-text">
            {filtered.map((segment) => {
              const spans = spansForSegment(segment);
              return (
                <div key={segment.id} className="rounded-md px-2 py-1.5 text-sm hover:bg-accent/50">
                  <div className="text-xs text-muted-foreground tabular-nums mb-0.5">
                    {formatClock(segment.startSec)}
                    {segment.speaker ? ` · ${segment.speaker}` : ''}
                  </div>
                  <p className="leading-relaxed">
                    {spans.map((span) => {
                      const index = spanIndexByKey.get(span.key) ?? 0;
                      return (
                        <span
                          key={span.key}
                          data-transcript-range=""
                          data-start={String(span.start)}
                          data-end={String(span.end)}
                          data-active="false"
                          data-span-index={String(index)}
                          className={cn(
                            'mr-1 rounded-sm px-0.5 cursor-pointer hover:bg-accent',
                            'data-[active=true]:bg-primary data-[active=true]:text-primary-foreground'
                          )}
                          onPointerDown={(event) => {
                            if (event.button !== 0) return;
                            dragFromIndex.current = index;
                          }}
                        >
                          {span.text}
                        </span>
                      );
                    })}
                  </p>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
});
