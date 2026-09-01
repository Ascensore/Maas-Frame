export type ReviewShortcut =
  | 'mark-in'
  | 'mark-out'
  | 'focus-comment'
  | 'toggle-command-palette'
  | 'open-shortcuts-help'
  | 'clear-range'
  | 'toggle-transcript';

/**
 * Review-page actions that are not playback. `null` means leave the event
 * alone. Modifier chords are only claimed for the command palette so I/O still
 * type in a comment field.
 */
export function resolveReviewShortcut(event: {
  code: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): ReviewShortcut | null {
  const mod = Boolean(event.metaKey || event.ctrlKey);
  if (event.altKey) return null;

  if (mod && event.code === 'KeyK') return 'toggle-command-palette';
  if (mod) return null;

  switch (event.code) {
    case 'KeyI':
      return 'mark-in';
    case 'KeyO':
      return 'mark-out';
    case 'KeyC':
      return 'focus-comment';
    case 'KeyT':
      return 'toggle-transcript';
    case 'Slash':
      return event.shiftKey ? 'open-shortcuts-help' : null;
    case 'Escape':
      return 'clear-range';
    default:
      return null;
  }
}

export type ReviewCommandGroup = 'Comment' | 'Playback' | 'Review';

export interface ReviewCommand {
  id: string;
  label: string;
  keywords: string[];
  shortcut?: string;
  group: ReviewCommandGroup;
}

const SEARCHABLE = (command: ReviewCommand) =>
  `${command.label} ${command.keywords.join(' ')} ${command.id}`.toLowerCase();

export function filterReviewCommands(commands: ReviewCommand[], query: string): ReviewCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;
  return commands.filter((command) => SEARCHABLE(command).includes(needle));
}

export const REVIEW_COMMAND_CATALOG: ReviewCommand[] = [
  {
    id: 'mark-in',
    label: 'Mark In',
    keywords: ['in', 'range', 'start', 'i'],
    shortcut: 'I',
    group: 'Comment',
  },
  {
    id: 'mark-out',
    label: 'Mark Out',
    keywords: ['out', 'range', 'end', 'o'],
    shortcut: 'O',
    group: 'Comment',
  },
  {
    id: 'clear-range',
    label: 'Clear In/Out',
    keywords: ['clear', 'range', 'reset'],
    shortcut: 'Esc',
    group: 'Comment',
  },
  {
    id: 'focus-comment',
    label: 'Write a comment',
    keywords: ['comment', 'note', 'type', 'c'],
    shortcut: 'C',
    group: 'Comment',
  },
  {
    id: 'toggle-play',
    label: 'Play / Pause',
    keywords: ['play', 'pause', 'space'],
    shortcut: 'Space',
    group: 'Playback',
  },
  {
    id: 'toggle-mute',
    label: 'Mute / Unmute',
    keywords: ['mute', 'audio', 'sound'],
    shortcut: 'M',
    group: 'Playback',
  },
  {
    id: 'toggle-fullscreen',
    label: 'Toggle fullscreen',
    keywords: ['fullscreen', 'expand'],
    shortcut: 'F',
    group: 'Playback',
  },
  {
    id: 'record-voice',
    label: 'Record a voice comment',
    keywords: ['voice', 'audio', 'mic', 'record'],
    group: 'Comment',
  },
  {
    id: 'draw-annotation',
    label: 'Draw on the frame',
    keywords: ['annotate', 'draw', 'pencil'],
    group: 'Comment',
  },
  {
    id: 'open-shortcuts-help',
    label: 'Show keyboard shortcuts',
    keywords: ['help', 'hotkeys', 'keys'],
    shortcut: '?',
    group: 'Review',
  },
  {
    id: 'toggle-transcript',
    label: 'Show / hide transcript',
    keywords: ['transcript', 'captions', 'dialogue', 't'],
    shortcut: 'T',
    group: 'Review',
  },
];
