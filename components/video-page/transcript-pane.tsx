'use client';

import { useCallback, useEffect, useMemo, useRef, useState, memo, type MouseEvent } from 'react';
import { Captions, Languages, Loader2, Pencil, Search, Upload } from 'lucide-react';
import { List, type RowComponentProps } from 'react-window';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  resolveEditableSegment,
  useTranscriptSegmentEdit,
} from '@/components/video-page/hooks/use-transcript-segment-edit';
import type { TranscriptSegment, TranscriptWord } from '@/components/video-page/types';
import {
  commentRangeFromHighlight,
  commentsAnchoredToSegment,
  spanOverlapsComment,
} from '@/lib/transcript-comment';
import { MAX_SEGMENT_TEXT, MAX_SPEAKER_LABEL } from '@/lib/transcript-edit';
import { isTranscriptSegmentTimed } from '@/lib/transcript-import';
import { serializeWebVtt } from '@/lib/subtitle-validation';
import { applyTranscriptHighlight } from '@/lib/transcript-active';
import {
  canShowTranscriptTranslation,
  overlayTranslatedSegmentTexts,
  type TranscriptTranslationPayload,
} from '@/lib/transcript-translation';
import { cn } from '@/lib/utils';

export type TranscriptPayload = {
  id: string;
  versionId: string;
  language: string;
  provider: string;
  status: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';
  error?: string | null;
  translation?: TranscriptTranslationPayload | null;
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
  canTranscribe: boolean;
  comments: TranscriptCommentMarker[];
  onSeek: (
    seconds: number,
    options?: { pauseAfterSeek?: boolean; timestampEnd?: number | null }
  ) => void;
  onCommentRange: (start: number, end: number, quote: string) => void;
  onOpenThread: (commentId: string) => void;
  /** Fired when an edit rebuilt the caption track, so the player can reload it. */
  onCaptionsChanged?: () => void;
  draftRange: { start: number; end: number } | null;
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
  onEditSegment: ((segment: TranscriptSegment) => void) | null;
  /** Non-null while editing is unavailable; the text is shown as the tooltip. */
  editDisabledReason: string | null;
  draftRange: { start: number; end: number } | null;
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
  onEditSegment,
  editDisabledReason,
  draftRange,
}: RowComponentProps<TranscriptRowProps>) {
  const segment = segments[index];
  const words = asWords(segment.words);
  const timed = isTranscriptSegmentTimed(segment);
  const markers = commentsAnchoredToSegment(comments, segments, index);
  const highlightComments = draftRange
    ? [...comments, { timestamp: draftRange.start, timestampEnd: draftRange.end }]
    : comments;

  const handleMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    const list = event.currentTarget.closest('[data-transcript-list]');
    const spans = list
      ? Array.from(
          list.querySelectorAll<HTMLElement>('button[data-transcript-range][data-start][data-end]')
        )
          .map((node) => ({
            start: Number(node.getAttribute('data-start')),
            end: Number(node.getAttribute('data-end')),
            text: node.textContent ?? '',
          }))
          .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end))
      : [];
    const highlight = commentRangeFromHighlight({
      quote: selection?.toString() ?? '',
      first: rangeNodeFromDom(selection?.anchorNode ?? null),
      last: rangeNodeFromDom(selection?.focusNode ?? null),
      spans,
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
          <div className="flex items-center gap-1">
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
            {onEditSegment && (
              <button
                type="button"
                aria-label="Edit line"
                title={editDisabledReason ?? undefined}
                disabled={editDisabledReason !== null}
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                onClick={() => onEditSegment(segment)}
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
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
        <p
          className={cn(
            'leading-relaxed line-clamp-2',
            timed &&
              words.length === 0 &&
              highlightComments.some((comment) =>
                spanOverlapsComment({ start: segment.startSec, end: segment.endSec }, comment)
              ) &&
              'bg-primary/25 rounded-sm'
          )}
        >
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
                    'data-[active=true]:bg-primary data-[active=true]:text-primary-foreground',
                    highlightComments.some((comment) => spanOverlapsComment(word, comment)) &&
                      'bg-primary/25'
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
  canTranscribe,
  comments,
  onSeek,
  onCommentRange,
  onOpenThread,
  onCaptionsChanged,
  draftRange,
}: TranscriptPaneProps) {
  const [transcript, setTranscript] = useState<TranscriptPayload>(null);
  const [loading, setLoading] = useState(false);
  const [enqueueing, setEnqueueing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [showTranslated, setShowTranslated] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [openCommentId, setOpenCommentId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TranscriptSegment | null>(null);
  const [editText, setEditText] = useState('');
  const [editSpeaker, setEditSpeaker] = useState('');
  const [captionNote, setCaptionNote] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    save: saveSegment,
    saving: savingSegment,
    error: editError,
    clearError: clearEditError,
  } = useTranscriptSegmentEdit(versionId);

  const openEditor = useCallback(
    (segment: TranscriptSegment) => {
      const source = resolveEditableSegment(segment, transcript?.segments);
      clearEditError();
      setCaptionNote(null);
      setEditing(source);
      setEditText(source.text);
      setEditSpeaker(source.speaker ?? '');
    },
    [clearEditError, transcript]
  );

  const fetchTranscript = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!versionId) {
        setTranscript(null);
        return;
      }
      if (!options?.silent) {
        setLoading(true);
        setError(null);
      }
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
        if (!options?.silent) setLoading(false);
      }
    },
    [versionId]
  );

  useEffect(() => {
    setShowTranslated(false);
    // The note is about the line that was just saved on the version being left,
    // so it has to go with it: left standing it reads as a claim about the
    // version now on screen, whose captions nobody has touched.
    setCaptionNote(null);
    void fetchTranscript();
  }, [fetchTranscript]);

  useEffect(() => {
    if (!versionId) return;
    const status = transcript?.status;
    const translationStatus = transcript?.translation?.status;
    const shouldPoll =
      status === 'PENDING' ||
      status === 'RUNNING' ||
      translationStatus === 'PENDING' ||
      translationStatus === 'RUNNING';
    if (!shouldPoll) return;
    const timer = window.setInterval(() => {
      void fetchTranscript({ silent: true });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [versionId, transcript?.status, transcript?.translation?.status, fetchTranscript]);

  const visibleSegments = useMemo(() => {
    const segments = transcript?.segments ?? [];
    if (!showTranslated) return segments;
    return overlayTranslatedSegmentTexts(segments, transcript?.translation?.texts);
  }, [transcript, showTranslated]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return visibleSegments;
    return visibleSegments.filter((segment) => segment.text.toLowerCase().includes(needle));
  }, [visibleSegments, query]);

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
      onEditSegment: canManage ? openEditor : null,
      editDisabledReason: showTranslated ? 'Switch to the original to edit' : null,
      draftRange,
    }),
    [
      filtered,
      comments,
      openCommentId,
      getCurrentTime,
      onSeek,
      onCommentRange,
      onOpenThread,
      canManage,
      openEditor,
      showTranslated,
      draftRange,
    ]
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
    const segments = visibleSegments;
    if (!transcript || segments.length === 0) return;
    // The same serializer the upload pipeline and the worker use, so a
    // downloaded track is byte-for-byte what a re-upload would store.
    const vtt = serializeWebVtt(
      segments.map((segment) => ({
        start: segment.startSec,
        end: segment.endSec,
        text: segment.text,
      }))
    );
    const blob = new Blob([vtt], { type: 'text/vtt' });
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
        body: JSON.stringify({}),
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

  const handleTranslate = async () => {
    if (!versionId) return;
    setTranslating(true);
    setError(null);
    try {
      const response = await fetch(`/api/versions/${versionId}/transcript/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: 'en' }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          typeof body?.error === 'string' ? body.error : 'Failed to translate transcript'
        );
      }
      setShowTranslated(true);
      await fetchTranscript({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to translate transcript');
    } finally {
      setTranslating(false);
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

  const canSaveSegment = !savingSegment && editText.trim().length > 0;

  const handleSaveSegment = async () => {
    if (!editing) return;
    const result = await saveSegment(editing.id, {
      text: editText,
      speaker: editSpeaker.trim() || null,
    });
    if (!result) return;
    setTranscript((current) =>
      current
        ? {
            ...current,
            segments: current.segments.map((segment) =>
              segment.id === result.segment.id ? result.segment : segment
            ),
          }
        : current
    );
    setEditing(null);
    if (result.captions === 'updated') {
      setCaptionNote(null);
      onCaptionsChanged?.();
    } else if (result.captions === 'empty') {
      // Nothing went wrong here at all: a pasted or imported transcript has no
      // timings, and cues cannot be made out of text that is not timed. Saying
      // "could not be rebuilt" would read as a failure to look into.
      setCaptionNote('Line saved. There is no caption track to build: this transcript is untimed.');
    } else if (result.captions === 'skipped') {
      setCaptionNote(
        'Line saved. The caption track was left alone: this version already has as many subtitle tracks as it can hold.'
      );
    } else {
      // Not an error the operator caused: the correction is stored. The
      // subtitles are the part that is behind, and saying so beats leaving the
      // operator to discover it.
      setCaptionNote('Line saved, but the caption track could not be rebuilt.');
    }
  };

  if (!versionId) {
    return <p className="text-sm text-muted-foreground">Select a version to see its transcript.</p>;
  }

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <div className="flex flex-wrap items-center gap-2">
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
              <span className="ml-1">Upload file</span>
            </Button>
          </>
        )}
        {canTranscribe && (
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
        {transcript?.status === 'READY' &&
          transcript.segments.length > 0 &&
          (transcript.translation?.status === 'READY' ? (
            <Button
              size="sm"
              variant={showTranslated ? 'default' : 'outline'}
              className="h-8"
              onClick={() => setShowTranslated((current) => !current)}
            >
              <Languages className="h-4 w-4" />
              <span className="ml-1">{showTranslated ? 'Original' : 'English'}</span>
            </Button>
          ) : canTranscribe && canShowTranscriptTranslation(transcript.language) ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => void handleTranslate()}
              disabled={translating || transcript.translation?.status === 'RUNNING'}
            >
              {translating || transcript.translation?.status === 'RUNNING' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Languages className="h-4 w-4" />
              )}
              <span className="ml-1">
                {transcript.translation?.status === 'RUNNING' ? 'Translating' : 'Translate'}
              </span>
            </Button>
          ) : null)}
        {transcript?.status === 'READY' && transcript.segments.length > 0 && (
          <Button size="sm" variant="outline" className="h-8" onClick={handleDownloadVtt}>
            VTT
          </Button>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {captionNote && (
        <p className="text-sm text-amber-600 dark:text-amber-500" role="status">
          {captionNote}
        </p>
      )}

      {loading && !transcript ? (
        <p className="text-sm text-muted-foreground">Loading transcript…</p>
      ) : transcript?.status === 'PENDING' || transcript?.status === 'RUNNING' ? (
        <p className="text-sm text-muted-foreground">Transcription in progress…</p>
      ) : transcript?.status === 'FAILED' ? (
        <p className="text-sm text-destructive">
          {transcript.error?.trim() || 'Transcription failed. Try again.'}
        </p>
      ) : !showList ? (
        <p className="text-sm text-muted-foreground">
          {query
            ? 'No matching lines.'
            : 'No transcript yet. Listen to this version and transcribe it, or upload a .srt, .vtt, .txt, or .docx file.'}
        </p>
      ) : (
        <div ref={listRef} data-transcript-list="" className="flex-1 min-h-0">
          <List
            rowComponent={TranscriptRow}
            rowCount={filtered.length}
            rowHeight={72}
            rowProps={rowProps}
            style={{ height: '100%' }}
          />
        </div>
      )}

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !savingSegment) setEditing(null);
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          // Cmd/Ctrl+Enter saves from anywhere in the dialog. A bare Enter has
          // to stay a newline in the textarea, which is why it is not bound here.
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (canSaveSegment) void handleSaveSegment();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit transcript line</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="transcript-line-text">Text</Label>
              <Textarea
                id="transcript-line-text"
                value={editText}
                onChange={(event) => setEditText(event.target.value)}
                maxLength={MAX_SEGMENT_TEXT}
                rows={4}
              />
              {editError && <p className="text-sm text-destructive">{editError}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="transcript-line-speaker">Speaker</Label>
              <Input
                id="transcript-line-speaker"
                value={editSpeaker}
                onChange={(event) => setEditSpeaker(event.target.value)}
                maxLength={MAX_SPEAKER_LABEL}
                placeholder="Optional"
                // A one-line field: Enter means "done", as it would in a form.
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
                    event.preventDefault();
                    if (canSaveSegment) void handleSaveSegment();
                  }
                }}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={savingSegment}>
              Cancel
            </Button>
            <Button onClick={() => void handleSaveSegment()} disabled={!canSaveSegment}>
              {savingSegment && <Loader2 className="h-4 w-4 animate-spin" />}
              <span className={savingSegment ? 'ml-1' : ''}>Save</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});
