/**
 * Frame-accurate time conversions for review comments and NLE marker sync.
 *
 * Frame rates are stored as a reduced rational (num/den), the form ffprobe
 * returns (`30000/1001`, `25/1`). Never persist a float 29.97 — it drifts.
 */

export type FrameRate = {
  num: number;
  den: number;
  dropFrame: boolean;
};

export type ParsedTimecode = {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  dropFrame: boolean;
};

const DROP_FRAME_RATES: ReadonlyArray<readonly [number, number]> = [
  [30000, 1001],
  [60000, 1001],
];

export function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x === 0 ? 1 : x;
}

export function reduceFrameRate(num: number, den: number): { num: number; den: number } {
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) {
    throw new Error('Frame rate must be a positive integer ratio');
  }
  const divisor = gcd(num, den);
  return { num: num / divisor, den: den / divisor };
}

export function parseFrameRateString(value: string): { num: number; den: number } | null {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim());
  if (!match) return null;
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) return null;
  return reduceFrameRate(num, den);
}

export function isNtscDropFrameRate(num: number, den: number): boolean {
  const reduced = reduceFrameRate(num, den);
  return DROP_FRAME_RATES.some(([n, d]) => n === reduced.num && d === reduced.den);
}

export function nominalFps(rate: FrameRate): number {
  if (rate.num === 30000 && rate.den === 1001) return 30;
  if (rate.num === 60000 && rate.den === 1001) return 60;
  return Math.round(rate.num / rate.den);
}

/**
 * Convert a media time in seconds to a frame index. The epsilon keeps a time
 * that lands exactly on a boundary from floating-point-ing down a frame.
 */
export function secondsToFrames(seconds: number, rate: FrameRate): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.floor((seconds * rate.num) / rate.den + 1e-6);
}

export function framesToSeconds(frames: number, rate: FrameRate): number {
  if (!Number.isFinite(frames) || frames < 0) return 0;
  return (frames * rate.den) / rate.num;
}

export function deriveTimestampFrame(
  seconds: number,
  num: number | null | undefined,
  den: number | null | undefined
): number | null {
  if (typeof num !== 'number' || typeof den !== 'number') return null;
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) return null;
  return secondsToFrames(seconds, { num, den, dropFrame: false });
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Non-drop-frame SMPTE from a frame count. The separator is `:` throughout.
 */
export function framesToTimecodeNdf(frameNumber: number, fps: number): string {
  const fpsInt = Math.max(1, Math.round(fps));
  const clamped = Math.max(0, Math.floor(frameNumber));
  const frames = clamped % fpsInt;
  const totalSeconds = Math.floor(clamped / fpsInt);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${pad2(frames)}`;
}

/**
 * Drop-frame SMPTE. 29.97 drops 2 frames every minute except every 10th;
 * 59.94 drops 4. The separator before frames is `;`.
 */
export function framesToTimecodeDf(frameNumber: number, nominal: 30 | 60): string {
  const dropFrames = nominal === 30 ? 2 : 4;
  const framesPerMinute = nominal * 60;
  const framesPer10Minutes = framesPerMinute * 10 - 9 * dropFrames;
  const clamped = Math.max(0, Math.floor(frameNumber));

  const d = Math.floor(clamped / framesPer10Minutes);
  const m = clamped % framesPer10Minutes;

  let f = clamped + 9 * dropFrames * d;
  if (m > dropFrames) {
    f += dropFrames * Math.floor((m - dropFrames) / (framesPerMinute - dropFrames));
  }

  const frames = f % nominal;
  const totalSeconds = Math.floor(f / nominal);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)};${pad2(frames)}`;
}

export function framesToTimecode(frameNumber: number, rate: FrameRate): string {
  if (rate.dropFrame && isNtscDropFrameRate(rate.num, rate.den)) {
    const nominal = rate.num === 60000 ? 60 : 30;
    return framesToTimecodeDf(frameNumber, nominal);
  }
  return framesToTimecodeNdf(frameNumber, nominalFps(rate));
}

export function parseTimecode(value: string): ParsedTimecode | null {
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)([:;])(\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  return {
    hours: Number(match[1]),
    minutes: Number(match[2]),
    seconds: Number(match[3]),
    frames: Number(match[5]),
    dropFrame: match[4] === ';',
  };
}

export function timecodeToFrames(value: string, rate: FrameRate): number | null {
  const parsed = parseTimecode(value);
  if (!parsed) return null;

  const fps = parsed.dropFrame ? (rate.num === 60000 ? 60 : 30) : nominalFps(rate);

  if (parsed.frames >= fps) return null;

  if (parsed.dropFrame) {
    const dropFrames = fps === 60 ? 4 : 2;
    const totalMinutes = parsed.hours * 60 + parsed.minutes;
    const dropped = dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
    return (
      (parsed.hours * 3600 + parsed.minutes * 60 + parsed.seconds) * fps + parsed.frames - dropped
    );
  }

  return (parsed.hours * 3600 + parsed.minutes * 60 + parsed.seconds) * fps + parsed.frames;
}

export function secondsToTimecode(seconds: number, rate: FrameRate): string {
  return framesToTimecode(secondsToFrames(seconds, rate), rate);
}

export type SequenceOffset = {
  startTimecode: string;
  rate: FrameRate;
};

/**
 * Convert a comment time (seconds from the start of the review file, which is
 * 00:00:00:00) into a sequence frame index by adding the sequence start.
 */
export function commentSecondsToSequenceFrames(
  seconds: number,
  offset: SequenceOffset
): number | null {
  const startFrames = timecodeToFrames(offset.startTimecode, offset.rate);
  if (startFrames === null) return null;
  return startFrames + secondsToFrames(seconds, offset.rate);
}
