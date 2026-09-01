'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface ShortcutItem {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutItem[];
}

const reviewShortcutGroups: ShortcutGroup[] = [
  {
    title: 'Comments',
    shortcuts: [
      { keys: ['I'], description: 'Mark In at the playhead' },
      { keys: ['O'], description: 'Mark Out at the playhead' },
      { keys: ['⇧', 'Drag'], description: 'Mark a range on the timeline' },
      { keys: ['C'], description: 'Focus the comment box' },
      { keys: ['Esc'], description: 'Clear In / Out' },
    ],
  },
  {
    title: 'Actions',
    shortcuts: [
      { keys: ['⌘', 'K'], description: 'Open the command palette' },
      { keys: ['T'], description: 'Show / hide transcript' },
      { keys: ['?'], description: 'This list' },
    ],
  },
];

const shortcutGroups: ShortcutGroup[] = [
  {
    title: 'Navigation',
    shortcuts: [{ keys: ['Ctrl', 'K'], description: 'Open search' }],
  },
  {
    title: 'Playback',
    shortcuts: [
      { keys: ['Space', 'K'], description: 'Play / Pause' },
      { keys: ['M'], description: 'Mute / Unmute' },
    ],
  },
  {
    title: 'Seeking',
    shortcuts: [
      { keys: ['←'], description: 'Seek back 5s' },
      { keys: ['→'], description: 'Seek forward 5s' },
      { keys: ['J'], description: 'Seek back 10s' },
      { keys: ['L'], description: 'Seek forward 10s' },
    ],
  },
  {
    title: 'Speed',
    shortcuts: [
      { keys: ['↑'], description: 'Increase speed' },
      { keys: ['↓'], description: 'Decrease speed' },
      { keys: ['⇧', '>'], description: 'Increase speed' },
      { keys: ['⇧', '<'], description: 'Decrease speed' },
    ],
  },
];

interface KeyboardShortcutsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: 'app' | 'review';
}

export function KeyboardShortcutsModal({
  open,
  onOpenChange,
  variant = 'app',
}: KeyboardShortcutsModalProps) {
  const groups =
    variant === 'review'
      ? [...reviewShortcutGroups, ...shortcutGroups.filter((group) => group.title !== 'Navigation')]
      : shortcutGroups;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 mt-1">
          {groups.map((group) => (
            <div key={group.title}>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2.5">
                {group.title}
              </h4>
              <div className="space-y-1.5">
                {group.shortcuts.map((shortcut, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-muted/50 transition-colors"
                  >
                    <span className="text-sm">{shortcut.description}</span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, j) => (
                        <kbd
                          key={j}
                          className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs text-muted-foreground"
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
