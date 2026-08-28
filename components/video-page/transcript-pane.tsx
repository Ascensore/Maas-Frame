'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Captions, Loader2, Search } from 'lucide-react';
import { List, type RowComponentProps } from 'react-window';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  currentTime: number;
  canManage: boolean;
  onSeek: (
    seconds: number,
    options?: { pauseAfterSeek?: boolean; timestampEnd?: number | null }
  ) => void;
  onCommentRange: (start: number, end: number, quote: string) => void;
}

type TranscriptRowProps = {
  segments: TranscriptSegment[];
  currentTime: number;
  onSeek: TranscriptPaneProps['onSeek'];
  onCommentRange: TranscriptPaneProps['onCommentRange'];
};

function TranscriptRow({
  index,
  style,
  segments,
  currentTime,
  onSeek,
  onCommentRange,
}: RowComponentProps<TranscriptRowProps>) {
  const segment = segments[index];
  const words = asWords(segment.words);
  const isActive = currentTime >= segment.startSec && currentTime < segment.endSec;

  const handleMouseUp = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const quote = selection.toString().trim();
    if (!quote) return;
    const matched = words.filter((word) => quote.toLowerCase().includes(word.text.toLowerCase()));
    const start = matched[0]?.start ?? segment.startSec;
    const end = matched[matched.length - 1]?.end ?? segment.endSec;
    onCommentRange(start, end, quote);
    selection.removeAllRanges();
  };

  return (
    <div style={style} className="px-1">
      <div
        className={cn(
          'rounded-md px-2 py-1.5 text-sm h-full',
          isActive ? 'bg-primary/10' : 'hover:bg-accent/50'
        )}
        onMouseUp={handleMouseUp}
      >
        <button
          type="button"
          className="text-xs text-muted-foreground tabular-nums mb-0.5 hover:text-foreground"
          onClick={() => onSeek(segment.startSec, { pauseAfterSeek: false })}
        >
          {formatClock(segment.startSec)}
          {segment.speaker ? ` · ${segment.speaker}` : ''}
        </button>
        <p className="leading-relaxed line-clamp-2">
          {words.length > 0 ? (
            words.map((word, wordIndex) => {
              const wordActive = currentTime >= word.start && currentTime < word.end;
              return (
                <button
                  key={`${segment.id}-${wordIndex}`}
                  type="button"
                  className={cn(
                    'mr-1 rounded-sm px-0.5',
                    wordActive ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
                  )}
                  onClick={() => onSeek(word.start, { pauseAfterSeek: false })}
                >
                  {word.text}
                </button>
              );
            })
          ) : (
            <button
              type="button"
              className="text-left"
              onClick={() => onSeek(segment.startSec, { pauseAfterSeek: false })}
            >
              {segment.text}
            </button>
          )}
        </p>
      </div>
    </div>
  );
}

export function TranscriptPane({
  versionId,
  currentTime,
  canManage,
  onSeek,
  onCommentRange,
}: TranscriptPaneProps) {
  const [transcript, setTranscript] = useState<TranscriptPayload>(null);
  const [loading, setLoading] = useState(false);
  const [enqueueing, setEnqueueing] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  if (!versionId) {
    return <p className="text-sm text-muted-foreground">Select a version to see its transcript.</p>;
  }

  const showList = transcript?.status === 'READY' && filtered.length > 0;

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
            : 'No transcript yet. Generate one to click through the dialogue.'}
        </p>
      ) : (
        <div ref={listRef} className="flex-1 min-h-0">
          <List
            rowComponent={TranscriptRow}
            rowCount={filtered.length}
            rowHeight={72}
            rowProps={{
              segments: filtered,
              currentTime,
              onSeek,
              onCommentRange,
            }}
            style={{ height: '100%' }}
          />
        </div>
      )}
    </div>
  );
}
