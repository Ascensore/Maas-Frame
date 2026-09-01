/**
 * Pure helpers extracted from `use-video-player.ts`.
 *
 * The hook itself is ~1400 lines of hls.js wiring, iframe messaging and
 * requestAnimationFrame loops that jsdom cannot run. The arithmetic below is the
 * part that is actually worth pinning down with tests, so it lives here where it
 * can be called directly with fixed inputs. Nothing in this module touches
 * React, the DOM or any player SDK.
 */

// A frame number is only meaningful against a stable rate: a raw measurement
// drifts (29.94, 30.07, ...) and would slide the count by whole frames late in a
// long video. Snap to the nearest broadcast standard when we are close enough.
const STANDARD_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

export function normalizeFrameRate(rate: number | undefined): number | null {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 12 || rate > 120) return null;

  // Nearest, not first-within-tolerance. The NTSC pairs (23.976/24, 29.97/30, 59.94/60)
  // are 0.1 percent apart and the tolerance is 1.5 percent, so taking the first match made
  // an exactly 30 fps source snap to 29.97 and left 24, 30 and 60 unreachable entirely.
  // That produced the very drift the snapping exists to prevent, roughly 18 frames after
  // ten minutes.
  let nearest: number | null = null;
  let nearestDistance = Infinity;
  for (const value of STANDARD_FRAME_RATES) {
    const distance = Math.abs(rate - value);
    if (distance / value < 0.015 && distance < nearestDistance) {
      nearest = value;
      nearestDistance = distance;
    }
  }

  return nearest ?? rate;
}

/**
 * How far a single frame-mode step moves the playhead. Falls back to one second
 * when no frame rate has been measured yet, which is also what the label says.
 */
export function getFrameStepSeconds(estimatedFrameRate: number | null): number {
  if (estimatedFrameRate && Number.isFinite(estimatedFrameRate) && estimatedFrameRate > 0) {
    return 1 / estimatedFrameRate;
  }
  return 1;
}

export function getFrameStepLabel(estimatedFrameRate: number | null): string {
  if (estimatedFrameRate && Number.isFinite(estimatedFrameRate) && estimatedFrameRate > 0) {
    return '1f';
  }
  return '1s';
}

/**
 * In frame mode every skip collapses to exactly one frame, keeping only the
 * direction of the requested jump. A zero-second request counts as forward.
 */
export function resolveSkipAmount(
  seconds: number,
  options: { isFrameMode: boolean; frameStepSeconds: number }
): number {
  if (!options.isFrameMode) return seconds;
  const direction = seconds === 0 ? 1 : Math.sign(seconds);
  return options.frameStepSeconds * direction;
}

export function clampSeekTime(time: number, duration: number): number {
  return Math.max(0, Math.min(duration, time));
}

/** Timeline fill / playhead offset, as a percentage clamped to [0, 100]. */
export function getPlayheadPercent(time: number, duration: number): number {
  return duration > 0 ? Math.max(0, Math.min(100, (time / duration) * 100)) : 0;
}

/**
 * Frame N covers [N/rate, (N+1)/rate); the epsilon keeps a time that lands
 * exactly on a boundary from floating-point-ing down to N-1. The result never
 * exceeds the last frame the duration can hold.
 */
export function getFrameIndexAtTime(time: number, frameRate: number, duration: number): number {
  const lastFrame = duration > 0 ? Math.max(0, Math.ceil(duration * frameRate) - 1) : 0;
  return Math.min(Math.floor(time * frameRate + 1e-6), lastFrame);
}

/** Convert a pointer x-coordinate into a time, using a captured timeline rect. */
export function timeFromClientX(
  clientX: number,
  rect: { left: number; width: number } | null,
  duration: number
): number {
  if (!rect || rect.width === 0) return 0;
  const percentage = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return percentage * duration;
}

// Speed range. YouTube is played through its iframe API, which silently ignores
// any rate outside the list `getAvailablePlaybackRates()` returns, so 0.25–2x
// is the reachable range there. Bunny and R2 are plain <video> elements; the
// review bar offers 0.10x–5x, which every current browser will actually play.
export const PLAYBACK_SPEED_MIN = 0.1;
export const PLAYBACK_SPEED_MAX = 5;
export const YOUTUBE_PLAYBACK_SPEED_MIN = 0.25;
export const YOUTUBE_PLAYBACK_SPEED_MAX = 2;
export const YOUTUBE_SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
export const NATIVE_SPEED_OPTIONS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

// The browsers keep the audio track well past the point where they stop
// pitch-correcting: playback is still audible at 8x. Nothing on the current
// native range is silent; the marker stays so a future ceiling past 8x can
// still label those rates rather than letting a mute 16x read as a broken file.
export const SILENT_ABOVE_SPEED = 8;

export function getSpeedOptionsForProvider(providerId: string | null | undefined): number[] {
  return providerId === 'youtube' ? YOUTUBE_SPEED_OPTIONS : NATIVE_SPEED_OPTIONS;
}

export function getPlaybackSpeedBounds(providerId: string | null | undefined): {
  min: number;
  max: number;
  snapTo?: number[];
} {
  if (providerId === 'youtube') {
    return {
      min: YOUTUBE_PLAYBACK_SPEED_MIN,
      max: YOUTUBE_PLAYBACK_SPEED_MAX,
      snapTo: YOUTUBE_SPEED_OPTIONS,
    };
  }
  return { min: PLAYBACK_SPEED_MIN, max: PLAYBACK_SPEED_MAX };
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Shift the current rate by `delta` (typically ±0.1 or ±0.5) and clamp to the
 * provider's range. YouTube only honours its discrete ladder, so a 0.1 nudge
 * there steps to the next listed rate rather than inventing 1.1x.
 */
export function nudgePlaybackSpeed(
  currentSpeed: number,
  delta: number,
  bounds: { min: number; max: number; snapTo?: number[] }
): number {
  const { min, max, snapTo } = bounds;
  if (snapTo && snapTo.length > 0) {
    const isCoarse = Math.abs(Math.abs(delta) - 0.5) < 1e-9;
    if (isCoarse) {
      const target = Math.min(max, Math.max(min, roundToTenth(currentSpeed + delta)));
      let nearest = snapTo[0];
      let nearestDistance = Math.abs(snapTo[0] - target);
      for (const rate of snapTo) {
        const distance = Math.abs(rate - target);
        if (distance < nearestDistance) {
          nearest = rate;
          nearestDistance = distance;
        }
      }
      return nearest;
    }
    const direction: 1 | -1 = delta >= 0 ? 1 : -1;
    return getAdjacentPlaybackSpeed(snapTo, currentSpeed, direction) ?? currentSpeed;
  }

  return Math.min(max, Math.max(min, roundToTenth(currentSpeed + delta)));
}

export function formatPlaybackSpeed(speed: number): string {
  return `${speed.toFixed(2)}x`;
}

/**
 * Next or previous entry in the speed ladder, or `null` at either end. An
 * unknown current speed behaves like index -1, so stepping up lands on the
 * slowest option and stepping down does nothing.
 */
export function getAdjacentPlaybackSpeed(
  speedOptions: number[],
  currentSpeed: number,
  direction: 1 | -1
): number | null {
  const currentIndex = speedOptions.indexOf(currentSpeed);
  if (direction === 1) {
    if (currentIndex >= speedOptions.length - 1) return null;
    return speedOptions[currentIndex + 1];
  }
  if (currentIndex <= 0) return null;
  return speedOptions[currentIndex - 1];
}

export type PlayerShortcut =
  | 'toggle-play'
  | 'skip-back'
  | 'skip-forward'
  | 'speed-up'
  | 'speed-down'
  | 'toggle-mute'
  | 'jump-back'
  | 'jump-forward'
  | 'toggle-fullscreen';

/**
 * Map a physical key to a player action. `null` means "not a player shortcut",
 * and the caller must then leave the event alone (no `preventDefault`), so that
 * an unshifted comma still types a comma.
 */
export function resolvePlayerShortcut(event: {
  code: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): PlayerShortcut | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;

  switch (event.code) {
    case 'Space':
    case 'KeyK':
      return 'toggle-play';
    case 'ArrowLeft':
      return 'skip-back';
    case 'ArrowRight':
      return 'skip-forward';
    case 'ArrowUp':
      return 'speed-up';
    case 'ArrowDown':
      return 'speed-down';
    case 'Comma':
      return event.shiftKey ? 'speed-down' : null;
    case 'Period':
      return event.shiftKey ? 'speed-up' : null;
    case 'KeyM':
      return 'toggle-mute';
    case 'KeyJ':
      return 'jump-back';
    case 'KeyL':
      return 'jump-forward';
    case 'KeyF':
      return 'toggle-fullscreen';
    default:
      return null;
  }
}

/** True when the keystroke belongs to a text field and must not be hijacked. */
export function isTypingTarget(target: HTMLElement): boolean {
  return (
    target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true
  );
}
