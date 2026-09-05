/**
 * WebVTT serialization, shared by the transcribe job and by the derived
 * transcript materialization writes. Pure, and copied into the worker image
 * with the rest of lib/rough-cut.
 */

export type VttCue = { start: number; end: number; text: string };

export function toVttTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function serializeWebVtt(cues: VttCue[]): string {
  const body = cues
    .map((cue) => `${toVttTime(cue.start)} --> ${toVttTime(cue.end)}\n${cue.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}
