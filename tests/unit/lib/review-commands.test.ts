import { describe, expect, it } from 'vitest';
import {
  filterReviewCommands,
  resolveReviewShortcut,
  type ReviewCommand,
} from '@/lib/review-commands';

describe('resolveReviewShortcut', () => {
  it('maps I and O to In/Out marks without modifiers', () => {
    expect(resolveReviewShortcut({ code: 'KeyI' })).toBe('mark-in');
    expect(resolveReviewShortcut({ code: 'KeyO' })).toBe('mark-out');
  });

  it('maps C to focus the composer', () => {
    expect(resolveReviewShortcut({ code: 'KeyC' })).toBe('focus-comment');
  });

  it('maps T to the transcript sidebar', () => {
    expect(resolveReviewShortcut({ code: 'KeyT' })).toBe('toggle-transcript');
  });

  it('opens the command palette on Cmd/Ctrl+K', () => {
    expect(resolveReviewShortcut({ code: 'KeyK', metaKey: true })).toBe('toggle-command-palette');
    expect(resolveReviewShortcut({ code: 'KeyK', ctrlKey: true })).toBe('toggle-command-palette');
  });

  it('leaves bare K for playback', () => {
    expect(resolveReviewShortcut({ code: 'KeyK' })).toBeNull();
  });

  it('does not steal Cmd+I or other modified letters', () => {
    expect(resolveReviewShortcut({ code: 'KeyI', metaKey: true })).toBeNull();
    expect(resolveReviewShortcut({ code: 'KeyO', ctrlKey: true })).toBeNull();
    expect(resolveReviewShortcut({ code: 'KeyC', altKey: true })).toBeNull();
  });

  it('opens shortcuts help on Shift+/', () => {
    expect(resolveReviewShortcut({ code: 'Slash', shiftKey: true })).toBe('open-shortcuts-help');
    expect(resolveReviewShortcut({ code: 'Slash' })).toBeNull();
  });

  it('maps Escape to clear the range', () => {
    expect(resolveReviewShortcut({ code: 'Escape' })).toBe('clear-range');
  });
});

describe('filterReviewCommands', () => {
  const commands: ReviewCommand[] = [
    {
      id: 'mark-in',
      label: 'Mark In',
      keywords: ['in', 'range'],
      group: 'Comment',
    },
    {
      id: 'toggle-play',
      label: 'Play / Pause',
      keywords: ['playback'],
      group: 'Playback',
    },
    {
      id: 'draw-annotation',
      label: 'Draw on the frame',
      keywords: ['annotate'],
      group: 'Comment',
    },
    {
      id: 'clear-range',
      label: 'Clear In/Out',
      keywords: ['range', 'reset'],
      group: 'Comment',
    },
  ];

  it('returns the full list when the query is blank', () => {
    expect(filterReviewCommands(commands, '  ').map((command) => command.id)).toEqual([
      'mark-in',
      'toggle-play',
      'draw-annotation',
      'clear-range',
    ]);
  });

  it('matches a label fragment', () => {
    expect(filterReviewCommands(commands, 'mark').map((command) => command.id)).toEqual([
      'mark-in',
    ]);
  });

  it('matches a keyword', () => {
    expect(filterReviewCommands(commands, 'annotate').map((command) => command.id)).toEqual([
      'draw-annotation',
    ]);
  });

  it('is case-insensitive', () => {
    expect(filterReviewCommands(commands, 'PLAY').map((command) => command.id)).toEqual([
      'toggle-play',
    ]);
  });

  it('returns every match in catalog order', () => {
    expect(filterReviewCommands(commands, 'range').map((command) => command.id)).toEqual([
      'mark-in',
      'clear-range',
    ]);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterReviewCommands(commands, 'xyzzy')).toEqual([]);
  });
});
