'use client';

import { Check, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

const SUCCESS_DURATION_MS = 4000;

export type DownloadToastState = {
  title: string;
  description?: string;
  /** 0-100 when the total size is known, null while it is unknown. */
  percent?: number | null;
  status?: 'loading' | 'success';
};

export type DownloadProgressToastHandle = {
  update: (next: Partial<DownloadToastState>) => void;
  success: (title: string, description?: string) => void;
  dismiss: () => void;
};

// Minimizing is a "get out of my way" choice, so it sticks for the rest of the
// session instead of every new download popping the panel open again.
let sessionMinimized = false;

function minimizedLabel(state: DownloadToastState): string {
  if (state.status === 'success') return 'Done';
  return typeof state.percent === 'number' ? `${Math.round(state.percent)}%` : 'Downloading';
}

function DownloadProgressToast({
  state,
  minimized,
  onToggleMinimized,
}: {
  state: DownloadToastState;
  minimized: boolean;
  onToggleMinimized: () => void;
}) {
  const isSuccess = state.status === 'success';
  const StatusIcon = isSuccess ? Check : Loader2;

  return (
    // The wrapper spans the toast column but stays click-through, so the
    // controls underneath (comment composer, voice recording) keep working
    // wherever the panel itself isn't.
    <div className="pointer-events-none flex w-[var(--width)] max-w-[calc(100vw-2rem)] justify-end">
      {minimized ? (
        <button
          type="button"
          onClick={onToggleMinimized}
          aria-label="Expand download progress"
          className="pointer-events-auto flex items-center gap-1.5 rounded-full border bg-background/95 px-2.5 py-1 text-xs shadow-lg backdrop-blur transition-colors hover:bg-muted"
        >
          <StatusIcon
            className={cn('h-3.5 w-3.5 shrink-0', !isSuccess && 'animate-spin')}
            aria-hidden="true"
          />
          <span className="tabular-nums">{minimizedLabel(state)}</span>
          <ChevronUp className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      ) : (
        <div className="pointer-events-auto w-full rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur">
          <div className="flex items-start gap-2">
            <StatusIcon
              className={cn('mt-0.5 h-4 w-4 shrink-0', !isSuccess && 'animate-spin')}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{state.title}</p>
              {state.description && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">
                  {state.description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onToggleMinimized}
              aria-label="Minimize download progress"
              className="-mt-1 -mr-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {!isSuccess && typeof state.percent === 'number' && (
            <Progress value={state.percent} className="mt-2 h-1" />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Long downloads are streamed through the browser with no native progress UI,
 * so we show our own — but it sits in the bottom-right corner, on top of the
 * comment composer. This wraps the progress toast in a panel the user can
 * collapse to a small pill (and expand again) while the download continues.
 */
export function createDownloadProgressToast(
  id: string,
  initial: DownloadToastState
): DownloadProgressToastHandle {
  let state: DownloadToastState = { status: 'loading', percent: null, ...initial };
  let minimized = sessionMinimized;
  let duration: number = Number.POSITIVE_INFINITY;

  const render = () => {
    toast.custom(
      () => (
        <DownloadProgressToast
          state={state}
          minimized={minimized}
          onToggleMinimized={() => {
            minimized = !minimized;
            sessionMinimized = minimized;
            render();
          }}
        />
      ),
      // The <li> sonner wraps this in is as wide as the toast column even when
      // only the pill is showing, so clicks pass through it too.
      { id, duration, className: 'pointer-events-none' }
    );
  };

  render();

  return {
    update(next) {
      state = { ...state, ...next };
      render();
    },
    success(title, description) {
      state = { ...state, title, description, percent: 100, status: 'success' };
      duration = SUCCESS_DURATION_MS;
      render();
    },
    dismiss() {
      toast.dismiss(id);
    },
  };
}
