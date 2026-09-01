import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useReviewHotkeys } from '@/components/video-page/hooks/use-review-hotkeys';

function pressKey(
  code: string,
  options: {
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    target?: EventTarget;
  } = {}
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    code,
    bubbles: true,
    cancelable: true,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    shiftKey: options.shiftKey ?? false,
  });
  act(() => {
    (options.target ?? window).dispatchEvent(event);
  });
  return event;
}

describe('useReviewHotkeys', () => {
  const handlers = {
    onTogglePalette: vi.fn(),
    onMarkIn: vi.fn(),
    onMarkOut: vi.fn(),
    onClearRange: vi.fn(),
    onFocusComment: vi.fn(),
    onOpenShortcutsHelp: vi.fn(),
    onToggleTranscript: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  function renderHotkeys(overrides: Partial<Parameters<typeof useReviewHotkeys>[0]> = {}) {
    return renderHook(() =>
      useReviewHotkeys({
        enabled: true,
        paletteOpen: false,
        ...handlers,
        ...overrides,
      })
    );
  }

  it('marks In and Out when the player is focused', () => {
    renderHotkeys();

    pressKey('KeyI');
    pressKey('KeyO');

    expect(handlers.onMarkIn).toHaveBeenCalledTimes(1);
    expect(handlers.onMarkOut).toHaveBeenCalledTimes(1);
  });

  it('lets I and O type in a comment field', () => {
    renderHotkeys();
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);

    const typed = pressKey('KeyI', { target: textarea });
    pressKey('KeyO', { target: textarea });

    expect(handlers.onMarkIn).not.toHaveBeenCalled();
    expect(handlers.onMarkOut).not.toHaveBeenCalled();
    expect(typed.defaultPrevented).toBe(false);
  });

  it('still opens the palette with Cmd+K while typing', () => {
    renderHotkeys();
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);

    const event = pressKey('KeyK', { metaKey: true, target: textarea });

    expect(handlers.onTogglePalette).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('still toggles the palette when it is already open, without marking In', () => {
    renderHotkeys({ paletteOpen: true });

    pressKey('KeyK', { metaKey: true });
    pressKey('KeyI');

    expect(handlers.onTogglePalette).toHaveBeenCalledTimes(1);
    expect(handlers.onMarkIn).not.toHaveBeenCalled();
  });

  it('does not steal I while another dialog is open, but Cmd+K still toggles', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('data-slot', 'dialog-content');
    document.body.appendChild(dialog);
    renderHotkeys();

    pressKey('KeyI');
    pressKey('KeyK', { metaKey: true });

    expect(handlers.onMarkIn).not.toHaveBeenCalled();
    expect(handlers.onTogglePalette).toHaveBeenCalledTimes(1);
  });

  it('toggles the transcript sidebar on T', () => {
    renderHotkeys();

    pressKey('KeyT');

    expect(handlers.onToggleTranscript).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled', () => {
    renderHotkeys({ enabled: false });

    pressKey('KeyI');
    pressKey('KeyK', { metaKey: true });

    expect(handlers.onMarkIn).not.toHaveBeenCalled();
    expect(handlers.onTogglePalette).not.toHaveBeenCalled();
  });
});
