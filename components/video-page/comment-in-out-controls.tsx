'use client';

import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CommentInOutControlsProps {
  inTime: number | null;
  outTime: number | null;
  formatTime: (value: number) => string;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onSeekIn?: () => void;
  onSeekOut?: () => void;
  onClear: () => void;
  compact?: boolean;
}

function RangeChip({
  label,
  shortcut,
  time,
  formatTime,
  onMark,
  onSeek,
  compact,
}: {
  label: string;
  shortcut: string;
  time: number | null;
  formatTime: (value: number) => string;
  onMark: () => void;
  onSeek?: () => void;
  compact?: boolean;
}) {
  const marked = time !== null;
  return (
    <div
      className={cn(
        'inline-flex items-stretch overflow-hidden rounded-md border',
        marked ? 'border-primary/40 bg-primary/10' : 'border-border'
      )}
    >
      <button
        type="button"
        onClick={onMark}
        title={`${label} at playhead (${shortcut})`}
        className={cn(
          'px-2 font-semibold tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground',
          compact ? 'h-7 text-[10px]' : 'h-8 text-[11px]'
        )}
      >
        {label}
        <span className="ml-1 font-mono font-normal text-muted-foreground/80">{shortcut}</span>
      </button>
      <button
        type="button"
        onClick={marked && onSeek ? onSeek : onMark}
        title={marked ? `Jump to ${label}` : `${label} at playhead (${shortcut})`}
        className={cn(
          'border-l px-2 font-mono tabular-nums',
          compact ? 'h-7 min-w-[3.25rem] text-[11px]' : 'h-8 min-w-[3.75rem] text-xs',
          marked ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {marked ? formatTime(time) : '––:––'}
      </button>
    </div>
  );
}

export function CommentInOutControls({
  inTime,
  outTime,
  formatTime,
  onMarkIn,
  onMarkOut,
  onSeekIn,
  onSeekOut,
  onClear,
  compact = false,
}: CommentInOutControlsProps) {
  const hasRange = inTime !== null || outTime !== null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <RangeChip
        label="IN"
        shortcut="I"
        time={inTime}
        formatTime={formatTime}
        onMark={onMarkIn}
        onSeek={onSeekIn}
        compact={compact}
      />
      <RangeChip
        label="OUT"
        shortcut="O"
        time={outTime}
        formatTime={formatTime}
        onMark={onMarkOut}
        onSeek={onSeekOut}
        compact={compact}
      />
      {hasRange && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn('px-2 text-xs', compact ? 'h-7' : 'h-8')}
          onClick={onClear}
          title="Clear In/Out (Esc)"
        >
          <X className="h-3 w-3" />
          <span className="sr-only">Clear In/Out</span>
        </Button>
      )}
    </div>
  );
}
