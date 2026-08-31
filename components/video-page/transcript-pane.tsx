'use client';

import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { Captions, Loader2, Search, Upload } from 'lucide-react';
import { List, type RowComponentProps } from 'react-window';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { commentRangeFromHighlight, commentsForSegment } from '@/lib/transcript-comment';
import { isTranscriptSegmentTimed } from '@/lib/transcript-import';
import { applyTranscriptHighlight } from '@/lib/transcript-active';
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

export type TranscriptCommentMarker = {
  id: string;
  timestamp: number;
  timestampEnd: number | null;
  content: string | null;
  authorName: string;
  authorImage: string | null;
  color: string | null;
};

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

function rangeNodeFromDom(node: Node | null): { start: number; end: number } | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const rangeEl = element?.closest('[data-transcript-range][data-start][data-end]');
  if (!rangeEl) return null;
  const start = Number(rangeEl.getAttribute('data-start'));
  const end = Number(rangeEl.getAttribute('data-end'));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

interface TranscriptPaneProps {
  versionId: string | null;
  getCurrentTime: () => number;
  canManage: boolean;
  comments: TranscriptCommentMarker[];
  onSeek: (
    seconds: number,
    options?: { pauseAfterSeek?: boolean; timestampEnd?: number | null }
  ) => void;
  onCommentRange: (start: number, end: number, quote: string) => void;
  onOpenThread: (commentId: string) => void;
}

type TranscriptRowProps = {
  segments: TranscriptSegment[];
  comments: TranscriptCommentMarker[];
  openCommentId: string | null;
  setOpenCommentId: (id: string | null) => void;
  getCurrentTime: () => number;
  onSeek: TranscriptPaneProps['onSeek'];
  onCommentRange: TranscriptPaneProps['onCommentRange'];
  onOpenThread: TranscriptPaneProps['onOpenThread'];
};

function TranscriptRow({
  index,
  style,
  segments,
  comments,
  openCommentId,
  setOpenCommentId,
  getCurrentTime,
  onSeek,
  onCommentRange,
  onOpenThread,
}: RowComponentProps<TranscriptRowProps>) {
  const segment = segments[index];
  const words = asWords(segment.words);
  const timed = isTranscriptSegmentTimed(segment);
  const markers = commentsForSegment(comments, segment);

  const handleMouseUp = () => {
    const selection = window.getSelection();
    const highlight = commentRangeFromHighlight({
      quote: selection?.toString() ?? '',
      first: rangeNodeFromDom(selection?.anchorNode ?? null),
      last: rangeNodeFromDom(selection?.focusNode ?? null),
    });
    if (!highlight) return;
    if (highlight.end > highlight.start) {
      onCommentRange(highlight.start, highlight.end, highlight.quote);
    } else {
      const now = getCurrentTime();
      onCommentRange(now, now, highlight.quote);
    }
    selection?.removeAllRanges();
  };

  return (
    <div style={style} className="px-1 overflow-visible">
      <div
        data-transcript-range=""
        data-start={String(segment.startSec)}
        data-end={String(segment.endSec)}
        data-active="false"
        className="rounded-md px-2 py-1.5 text-sm h-full hover:bg-accent/50 data-[active=true]:bg-primary/10"
        onMouseUp={handleMouseUp}
      >
        <div className="flex items-center justify-between gap-2 mb-0.5">
          {timed ? (
            <button
              type="button"
              className="text-xs text-muted-foreground tabular-nums hover:text-foreground"
              onClick={() => onSeek(segment.startSec, { pauseAfterSeek: false })}
            >
              {formatClock(segment.startSec)}
              {segment.speaker ? ` · ${segment.speaker}` : ''}
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">Script</span>
          )}
          {markers.length > 0 && (
            <div className="relative flex items-center gap-1">
              {markers.map((marker) => (
                <button
                  key={marker.id}
                  type="button"
                  title={marker.authorName}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium text-primary-foreground"
                  style={{ backgroundColor: marker.color || 'var(--primary)' }}
                  onClick={() => {
                    onSeek(marker.timestamp, {
                      pauseAfterSeek: true,
                      timestampEnd: marker.timestampEnd,
                    });
                    setOpenCommentId(openCommentId === marker.id ? null : marker.id);
                  }}
                >
                  {marker.authorName.charAt(0).toUpperCase() || '?'}
                </button>
              ))}
              {markers
                .filter((marker) => marker.id === openCommentId)
                .map((marker) => (
                  <div
                    key={`${marker.id}-popover`}
                    className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
                  >
                    <p className="text-xs font-medium">{marker.authorName}</p>
                    <p className="mt-1 text-xs text-muted-foreground line-clamp-4">
                      {marker.content || 'Voice or attachment comment'}
                    </p>
                    <button
                      type="button"
                      className="mt-2 text-xs text-primary hover:underline"
                      onClick={() => onOpenThread(marker.id)}
                    >
                      Open thread
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
        <p className="leading-relaxed line-clamp-2">
          {timed && words.length > 0 ? (
            words.map((word, wordIndex) => {
              return (
                <button
                  key={`${segment.id}-${wordIndex}`}
                  type="button"
                  data-transcript-range=""
                  data-start={String(word.start)}
                  data-end={String(word.end)}
                  data-active="false"
                  className={cn(
                    'mr-1 rounded-sm px-0.5 hover:bg-accent',
                    'data-[active=true]:bg-primary data-[active=true]:text-primary-foreground'
                  )}
                  onClick={() => onSeek(word.start, { pauseAfterSeek: false })}
                >
                  {word.text}
                </button>
              );
            })
          ) : timed ? (
            <button
              type="button"
              className="text-left"
              onClick={() => onSeek(segment.startSec, { pauseAfterSeek: false })}
            >
              {segment.text}
            </button>
          ) : (
            <span>{segment.text}</span>
          )}
        </p>
      </div>
    </div>
  );
}

export const TranscriptPane = memo(function TranscriptPane({
  versionId,
  getCurrentTime,
  canManage,
  comments,
  onSeek,
  onCommentRange,
  onOpenThread,
}: TranscriptPaneProps) {
  const [transcript, setTranscript] = useState<TranscriptPayload>(null);
  const [loading, setLoading] = useState(false);
  const [enqueueing, setEnqueueing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [openCommentId, setOpenCommentId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const showList = transcript?.status === 'READY' && filtered.length > 0;
  const rowProps = useMemo(
    () => ({
      segments: filtered,
      comments,
      openCommentId,
      setOpenCommentId,
      getCurrentTime,
      onSeek,
      onCommentRange,
      onOpenThread,
    }),
    [filtered, comments, openCommentId, getCurrentTime, onSeek, onCommentRange, onOpenThread]
  );

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
    if (
      transcript?.status === 'READY' &&
      !window.confirm('Replace the current transcript with a new transcription?')
    ) {
      return;
    }
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

  const handleUploadFile = async (file: File) => {
    if (!versionId) return;
    if (transcript?.status === 'READY' && !window.confirm('Replace the current transcript?')) {
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('transcript', file);
      form.append('language', 'en');
      const response = await fetch(`/api/versions/${versionId}/transcript/upload`, {
        method: 'POST',
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

  if (!versionId) {
    return <p className="text-sm text-muted-foreground">Select a version to see its transcript.</p>;
  }

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
        {canManage && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.vtt,.txt,.docx"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void handleUploadFile(file);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              <span className="ml-1">Upload</span>
            </Button>
            <Button
              size="sm"
              className="h-8"
              onClick={() => void handleEnqueue()}
              disabled={enqueueing}
            >
              {enqueueing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Captions className="h-4 w-4" />
              )}
              <span className="ml-1">{transcript ? 'Re-run' : 'Transcribe'}</span>
            </Button>
          </>
        )}
        {transcript?.status === 'READY' && transcript.segments.length > 0 && (
          <Button size="sm" variant="outline" className="h-8" onClick={handleDownloadVtt}>
            VTT
          </Button>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading && !transcript ? (
        <p className="text-sm text-muted-foreground">Loading transcript…</p>
      ) : transcript?.status === 'PENDING' || transcript?.status === 'RUNNING' ? (
        <p className="text-sm text-muted-foreground">Transcription in progress…</p>
      ) : transcript?.status === 'FAILED' ? (
        <p className="text-sm text-destructive">Transcription failed. Try again.</p>
      ) : !showList ? (
        <p className="text-sm text-muted-foreground">
          {query
            ? 'No matching lines.'
            : 'No transcript yet. Listen to this version and transcribe it, or upload a .srt, .vtt, .txt, or .docx file.'}
        </p>
      ) : (
        <div ref={listRef} className="flex-1 min-h-0">
          <List
            rowComponent={TranscriptRow}
            rowCount={filtered.length}
            rowHeight={72}
            rowProps={rowProps}
            style={{ height: '100%' }}
          />
        </div>
      )}
    </div>
  );
});
