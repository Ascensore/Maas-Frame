import { startTimecodeToSeconds, type FrameRate } from '../timecode';

export function computeTimecodeOffsets(
  clips: Array<{ versionId: string; startTimecode: string | null }>,
  rate: FrameRate
): { ok: true; offsets: Map<string, number> } | { ok: false; reason: string } {
  const seconds: Array<{ versionId: string; seconds: number }> = [];
  for (const clip of clips) {
    if (!clip.startTimecode) return { ok: false, reason: 'missing-timecode' };
    const value = startTimecodeToSeconds(clip.startTimecode, rate);
    if (value === null) return { ok: false, reason: 'invalid-timecode' };
    seconds.push({ versionId: clip.versionId, seconds: value });
  }
  if (seconds.length === 0) return { ok: false, reason: 'empty' };
  const origin = Math.min(...seconds.map((entry) => entry.seconds));
  const offsets = new Map<string, number>();
  for (const entry of seconds) {
    offsets.set(entry.versionId, entry.seconds - origin);
  }
  return { ok: true, offsets };
}
