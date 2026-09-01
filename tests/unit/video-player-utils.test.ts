import { describe, it, expect } from 'vitest';
import {
  clampSeekTime,
  formatPlaybackSpeed,
  getAdjacentPlaybackSpeed,
  getFrameIndexAtTime,
  getFrameStepLabel,
  getFrameStepSeconds,
  getPlayheadPercent,
  getPlaybackSpeedBounds,
  getSpeedOptionsForProvider,
  isTypingTarget,
  normalizeFrameRate,
  NATIVE_SPEED_OPTIONS,
  nudgePlaybackSpeed,
  PLAYBACK_SPEED_MAX,
  PLAYBACK_SPEED_MIN,
  resolvePlayerShortcut,
  resolveSkipAmount,
  SILENT_ABOVE_SPEED,
  timeFromClientX,
  YOUTUBE_SPEED_OPTIONS,
} from '@/components/video-page/hooks/video-player-utils';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

describe('normalizeFrameRate', () => {
  it('snaps a drifting measurement to a broadcast standard', () => {
    expect(normalizeFrameRate(29.94)).toBe(29.97);
    expect(normalizeFrameRate(23.9)).toBe(23.976);
    expect(normalizeFrameRate(59.8)).toBe(59.94);
    expect(normalizeFrameRate(24.9)).toBe(25);
  });

  it('returns an exact standard rate unchanged', () => {
    for (const rate of [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120]) {
      expect(normalizeFrameRate(rate)).toBe(rate);
    }
  });

  // The tolerance is 1.5 percent but the NTSC pairs are only 0.1 percent apart, so taking
  // the first entry within tolerance made 24, 30 and 60 unreachable and reported an
  // exactly 30 fps source as 29.97: the very drift the snapping exists to prevent.
  it('picks the nearest standard rather than the first within tolerance', () => {
    expect(normalizeFrameRate(30.07)).toBe(30);
    expect(normalizeFrameRate(29.99)).toBe(30);
    expect(normalizeFrameRate(29.96)).toBe(29.97);
    expect(normalizeFrameRate(23.99)).toBe(24);
    expect(normalizeFrameRate(59.98)).toBe(60);
    expect(normalizeFrameRate(59.95)).toBe(59.94);
  });

  it('keeps a plausible non-standard rate rather than forcing a snap', () => {
    // 45fps is more than 1.5% away from every standard, so it must survive.
    expect(normalizeFrameRate(45)).toBe(45);
    expect(normalizeFrameRate(12)).toBe(12);
  });

  it('rejects rates outside the 12-120 window', () => {
    expect(normalizeFrameRate(11.9)).toBeNull();
    expect(normalizeFrameRate(120.1)).toBeNull();
    expect(normalizeFrameRate(0)).toBeNull();
    expect(normalizeFrameRate(-30)).toBeNull();
  });

  it('rejects non-finite and missing input', () => {
    expect(normalizeFrameRate(undefined)).toBeNull();
    expect(normalizeFrameRate(Number.NaN)).toBeNull();
    expect(normalizeFrameRate(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('getFrameStepSeconds', () => {
  it('is the reciprocal of a measured frame rate', () => {
    expect(getFrameStepSeconds(25)).toBe(0.04);
    expect(getFrameStepSeconds(50)).toBe(0.02);
  });

  it('falls back to one second when no rate has been measured', () => {
    expect(getFrameStepSeconds(null)).toBe(1);
    expect(getFrameStepSeconds(0)).toBe(1);
    expect(getFrameStepSeconds(-25)).toBe(1);
    expect(getFrameStepSeconds(Number.NaN)).toBe(1);
    expect(getFrameStepSeconds(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('getFrameStepLabel', () => {
  it('reads "1f" only when a usable frame rate is known', () => {
    expect(getFrameStepLabel(29.97)).toBe('1f');
    expect(getFrameStepLabel(null)).toBe('1s');
    expect(getFrameStepLabel(0)).toBe('1s');
    expect(getFrameStepLabel(Number.NaN)).toBe('1s');
  });

  it('agrees with getFrameStepSeconds about which unit is in play', () => {
    for (const rate of [null, 0, Number.NaN, 24, 25, 60]) {
      const usesFrames = getFrameStepLabel(rate) === '1f';
      expect(getFrameStepSeconds(rate) !== 1).toBe(usesFrames);
    }
  });
});

describe('resolveSkipAmount', () => {
  it('passes the requested seconds straight through outside frame mode', () => {
    expect(resolveSkipAmount(-5, { isFrameMode: false, frameStepSeconds: 0.04 })).toBe(-5);
    expect(resolveSkipAmount(5, { isFrameMode: false, frameStepSeconds: 0.04 })).toBe(5);
    expect(resolveSkipAmount(0, { isFrameMode: false, frameStepSeconds: 0.04 })).toBe(0);
  });

  it('collapses any jump to a single frame in frame mode, keeping direction', () => {
    expect(resolveSkipAmount(5, { isFrameMode: true, frameStepSeconds: 0.04 })).toBe(0.04);
    expect(resolveSkipAmount(30, { isFrameMode: true, frameStepSeconds: 0.04 })).toBe(0.04);
    expect(resolveSkipAmount(-5, { isFrameMode: true, frameStepSeconds: 0.04 })).toBe(-0.04);
    expect(resolveSkipAmount(-30, { isFrameMode: true, frameStepSeconds: 0.04 })).toBe(-0.04);
  });

  it('treats a zero-second request as one frame forward', () => {
    expect(resolveSkipAmount(0, { isFrameMode: true, frameStepSeconds: 0.04 })).toBe(0.04);
  });
});

describe('clampSeekTime', () => {
  it('keeps a time inside [0, duration]', () => {
    expect(clampSeekTime(5, 10)).toBe(5);
    expect(clampSeekTime(-3, 10)).toBe(0);
    expect(clampSeekTime(25, 10)).toBe(10);
    expect(clampSeekTime(10, 10)).toBe(10);
  });

  it('pins to zero while the duration is still unknown', () => {
    expect(clampSeekTime(42, 0)).toBe(0);
  });
});

describe('getPlayheadPercent', () => {
  it('maps a time onto a 0-100 timeline position', () => {
    expect(getPlayheadPercent(0, 10)).toBe(0);
    expect(getPlayheadPercent(2.5, 10)).toBe(25);
    expect(getPlayheadPercent(10, 10)).toBe(100);
  });

  it('clamps positions that fall outside the media', () => {
    expect(getPlayheadPercent(-4, 10)).toBe(0);
    expect(getPlayheadPercent(14, 10)).toBe(100);
  });

  it('returns 0 rather than NaN when the duration is unknown', () => {
    expect(getPlayheadPercent(4, 0)).toBe(0);
    expect(getPlayheadPercent(4, -1)).toBe(0);
  });
});

describe('getFrameIndexAtTime', () => {
  it('numbers frames from zero within their half-open interval', () => {
    expect(getFrameIndexAtTime(0, 25, 60)).toBe(0);
    expect(getFrameIndexAtTime(0.039, 25, 60)).toBe(0);
    expect(getFrameIndexAtTime(0.04, 25, 60)).toBe(1);
    expect(getFrameIndexAtTime(1, 25, 60)).toBe(25);
  });

  it('does not slip a frame backwards on an inexact boundary', () => {
    // 1.16 * 25 evaluates to 28.999999999999996 in IEEE-754, so a bare
    // Math.floor would report frame 28 for the exact start of frame 29.
    expect(1.16 * 25).toBeLessThan(29);
    expect(getFrameIndexAtTime(1.16, 25, 60)).toBe(29);
    // Same trap at 4.1s on a 30fps timeline.
    expect(4.1 * 30).toBeLessThan(123);
    expect(getFrameIndexAtTime(4.1, 30, 60)).toBe(123);
  });

  it('never reports a frame past the end of the media', () => {
    // 2s at 25fps holds frames 0..49.
    expect(getFrameIndexAtTime(1.99, 25, 2)).toBe(49);
    expect(getFrameIndexAtTime(2, 25, 2)).toBe(49);
    expect(getFrameIndexAtTime(600, 25, 2)).toBe(49);
  });

  it('reports frame 0 while the duration is unknown', () => {
    expect(getFrameIndexAtTime(12, 25, 0)).toBe(0);
  });
});

describe('timeFromClientX', () => {
  const rect = { left: 100, width: 200 };

  it('maps a pointer position across the timeline onto a time', () => {
    expect(timeFromClientX(100, rect, 60)).toBe(0);
    expect(timeFromClientX(200, rect, 60)).toBe(30);
    expect(timeFromClientX(300, rect, 60)).toBe(60);
  });

  it('clamps a pointer that has been dragged off either end', () => {
    expect(timeFromClientX(-500, rect, 60)).toBe(0);
    expect(timeFromClientX(5000, rect, 60)).toBe(60);
  });

  it('returns 0 when the timeline rect is missing or has no width', () => {
    expect(timeFromClientX(200, null, 60)).toBe(0);
    expect(timeFromClientX(200, { left: 100, width: 0 }, 60)).toBe(0);
  });
});

describe('getAdjacentPlaybackSpeed', () => {
  it('steps up and down the ladder', () => {
    expect(getAdjacentPlaybackSpeed(SPEEDS, 1, 1)).toBe(1.5);
    expect(getAdjacentPlaybackSpeed(SPEEDS, 1, -1)).toBe(0.5);
    expect(getAdjacentPlaybackSpeed(SPEEDS, 0.5, -1)).toBe(0.25);
  });

  it('returns null at either end instead of wrapping around', () => {
    expect(getAdjacentPlaybackSpeed(SPEEDS, 2, 1)).toBeNull();
    expect(getAdjacentPlaybackSpeed(SPEEDS, 0.25, -1)).toBeNull();
  });

  it('recovers from an unknown current speed by starting at the slowest', () => {
    expect(getAdjacentPlaybackSpeed(SPEEDS, 3, 1)).toBe(0.25);
    expect(getAdjacentPlaybackSpeed(SPEEDS, 3, -1)).toBeNull();
  });

  it('returns null for an empty ladder', () => {
    expect(getAdjacentPlaybackSpeed([], 1, 1)).toBeNull();
    expect(getAdjacentPlaybackSpeed([], 1, -1)).toBeNull();
  });
});

describe('nudgePlaybackSpeed', () => {
  const native = { min: PLAYBACK_SPEED_MIN, max: PLAYBACK_SPEED_MAX };
  const youtube = getPlaybackSpeedBounds('youtube');

  it('steps native playback by tenths and half-steps', () => {
    expect(nudgePlaybackSpeed(1, 0.1, native)).toBe(1.1);
    expect(nudgePlaybackSpeed(1, -0.1, native)).toBe(0.9);
    expect(nudgePlaybackSpeed(1, 0.5, native)).toBe(1.5);
    expect(nudgePlaybackSpeed(1, -0.5, native)).toBe(0.5);
  });

  it('reaches the 0.10x and 5x ends of the native range', () => {
    expect(nudgePlaybackSpeed(0.2, -0.1, native)).toBe(0.1);
    expect(nudgePlaybackSpeed(0.1, -0.1, native)).toBe(0.1);
    expect(nudgePlaybackSpeed(4.6, 0.5, native)).toBe(5);
    expect(nudgePlaybackSpeed(5, 0.1, native)).toBe(5);
  });

  it('steps YouTube along the rates its iframe API actually honours', () => {
    expect(nudgePlaybackSpeed(1, 0.1, youtube)).toBe(1.25);
    expect(nudgePlaybackSpeed(1, -0.1, youtube)).toBe(0.75);
    expect(nudgePlaybackSpeed(1, 0.5, youtube)).toBe(1.5);
    expect(nudgePlaybackSpeed(2, 0.1, youtube)).toBe(2);
    expect(nudgePlaybackSpeed(0.25, -0.1, youtube)).toBe(0.25);
  });

  it('formats the control as two decimal places', () => {
    expect(formatPlaybackSpeed(1)).toBe('1.00x');
    expect(formatPlaybackSpeed(0.1)).toBe('0.10x');
    expect(formatPlaybackSpeed(5)).toBe('5.00x');
  });

  it('reports YouTube and native bounds as literals, not as aliases of the same constants', () => {
    expect(getPlaybackSpeedBounds('youtube')).toEqual({
      min: 0.25,
      max: 2,
      snapTo: YOUTUBE_SPEED_OPTIONS,
    });
    expect(getPlaybackSpeedBounds('r2')).toEqual({
      min: 0.1,
      max: 5,
    });
  });
});

describe('getSpeedOptionsForProvider', () => {
  it('caps YouTube at 2x, since its iframe API ignores anything faster', () => {
    expect(getSpeedOptionsForProvider('youtube')).toBe(YOUTUBE_SPEED_OPTIONS);
    expect(Math.max(...YOUTUBE_SPEED_OPTIONS)).toBe(2);
    expect(Math.min(...YOUTUBE_SPEED_OPTIONS)).toBe(0.25);
  });

  it('lets the <video> providers run from 0.10x to 5x', () => {
    for (const provider of ['bunny', 'r2', undefined, null]) {
      expect(getSpeedOptionsForProvider(provider)).toBe(NATIVE_SPEED_OPTIONS);
    }
    expect(NATIVE_SPEED_OPTIONS).toContain(0.1);
    expect(NATIVE_SPEED_OPTIONS).toContain(5);
    expect(Math.max(...NATIVE_SPEED_OPTIONS)).toBe(5);
    expect(Math.min(...NATIVE_SPEED_OPTIONS)).toBe(0.1);
  });

  it('marks the rates the browser plays without audio', () => {
    // The review bar tops out at 5x, below the 8x threshold where audio drops out.
    expect(SILENT_ABOVE_SPEED).toBe(8);
    expect(NATIVE_SPEED_OPTIONS.filter((speed) => speed > SILENT_ABOVE_SPEED)).toEqual([]);
    expect(YOUTUBE_SPEED_OPTIONS.every((speed) => speed <= SILENT_ABOVE_SPEED)).toBe(true);
  });

  it('keeps both ladders ascending so the arrow-key stepping stays monotonic', () => {
    for (const ladder of [YOUTUBE_SPEED_OPTIONS, NATIVE_SPEED_OPTIONS]) {
      expect([...ladder].sort((a, b) => a - b)).toEqual(ladder);
    }
  });
});

describe('resolvePlayerShortcut', () => {
  it('maps the play/pause, seek, mute and fullscreen keys', () => {
    expect(resolvePlayerShortcut({ code: 'Space' })).toBe('toggle-play');
    expect(resolvePlayerShortcut({ code: 'KeyK' })).toBe('toggle-play');
    expect(resolvePlayerShortcut({ code: 'ArrowLeft' })).toBe('skip-back');
    expect(resolvePlayerShortcut({ code: 'ArrowRight' })).toBe('skip-forward');
    expect(resolvePlayerShortcut({ code: 'KeyJ' })).toBe('jump-back');
    expect(resolvePlayerShortcut({ code: 'KeyL' })).toBe('jump-forward');
    expect(resolvePlayerShortcut({ code: 'KeyM' })).toBe('toggle-mute');
    expect(resolvePlayerShortcut({ code: 'KeyF' })).toBe('toggle-fullscreen');
  });

  it('maps the arrow keys to speed changes regardless of shift', () => {
    expect(resolvePlayerShortcut({ code: 'ArrowUp' })).toBe('speed-up');
    expect(resolvePlayerShortcut({ code: 'ArrowDown' })).toBe('speed-down');
    expect(resolvePlayerShortcut({ code: 'ArrowUp', shiftKey: true })).toBe('speed-up');
    expect(resolvePlayerShortcut({ code: 'ArrowDown', shiftKey: true })).toBe('speed-down');
  });

  it('requires shift for the comma and period speed shortcuts', () => {
    expect(resolvePlayerShortcut({ code: 'Comma', shiftKey: true })).toBe('speed-down');
    expect(resolvePlayerShortcut({ code: 'Period', shiftKey: true })).toBe('speed-up');
    // Unshifted, these must stay available for typing.
    expect(resolvePlayerShortcut({ code: 'Comma', shiftKey: false })).toBeNull();
    expect(resolvePlayerShortcut({ code: 'Period' })).toBeNull();
  });

  it('ignores chords so Cmd+K can open the command palette', () => {
    expect(resolvePlayerShortcut({ code: 'KeyK', metaKey: true })).toBeNull();
    expect(resolvePlayerShortcut({ code: 'KeyK', ctrlKey: true })).toBeNull();
    expect(resolvePlayerShortcut({ code: 'Space', altKey: true })).toBeNull();
  });
});

describe('isTypingTarget', () => {
  const asTarget = (target: { tagName?: string; isContentEditable?: boolean }) =>
    isTypingTarget(target as HTMLElement);

  it('recognises the elements a keystroke should be left alone in', () => {
    expect(asTarget({ tagName: 'INPUT' })).toBe(true);
    expect(asTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(asTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('lets the player claim keystrokes anywhere else', () => {
    expect(asTarget({ tagName: 'BODY', isContentEditable: false })).toBe(false);
    expect(asTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(asTarget({ tagName: 'BUTTON' })).toBe(false);
    // Lowercase never happens for HTML elements, but the check is case
    // sensitive and that is worth pinning.
    expect(asTarget({ tagName: 'input' })).toBe(false);
  });
});
