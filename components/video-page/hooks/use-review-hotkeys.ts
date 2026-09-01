'use client';

import { useEffect } from 'react';
import { isTypingTarget } from '@/components/video-page/hooks/video-player-utils';
import { resolveReviewShortcut } from '@/lib/review-commands';

interface UseReviewHotkeysParams {
  enabled: boolean;
  paletteOpen: boolean;
  onTogglePalette: () => void;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onClearRange: () => void;
  onFocusComment: () => void;
  onOpenShortcutsHelp: () => void;
  onToggleTranscript: () => void;
}

export function useReviewHotkeys({
  enabled,
  paletteOpen,
  onTogglePalette,
  onMarkIn,
  onMarkOut,
  onClearRange,
  onFocusComment,
  onOpenShortcutsHelp,
  onToggleTranscript,
}: UseReviewHotkeysParams) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const shortcut = resolveReviewShortcut(event);
      if (shortcut === null) return;

      if (shortcut === 'toggle-command-palette') {
        event.preventDefault();
        onTogglePalette();
        return;
      }

      if (paletteOpen) return;
      if (document.querySelector('[data-slot="dialog-content"]')) return;

      const typing = isTypingTarget(event.target as HTMLElement);
      if (typing) return;

      event.preventDefault();
      switch (shortcut) {
        case 'mark-in':
          onMarkIn();
          break;
        case 'mark-out':
          onMarkOut();
          break;
        case 'clear-range':
          onClearRange();
          break;
        case 'focus-comment':
          onFocusComment();
          break;
        case 'open-shortcuts-help':
          onOpenShortcutsHelp();
          break;
        case 'toggle-transcript':
          onToggleTranscript();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    enabled,
    onClearRange,
    onFocusComment,
    onMarkIn,
    onMarkOut,
    onOpenShortcutsHelp,
    onTogglePalette,
    paletteOpen,
    onToggleTranscript,
  ]);
}
