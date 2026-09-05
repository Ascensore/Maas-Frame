import { describe, expect, it } from 'vitest';
import { serializeWebVtt, toVttTime } from '@/lib/rough-cut/vtt';

describe('vtt', () => {
  it('formats times and cues the way the player expects', () => {
    expect(toVttTime(0)).toBe('00:00:00.000');
    expect(toVttTime(3725.5)).toBe('01:02:05.500');
    expect(toVttTime(-1)).toBe('00:00:00.000');
    expect(serializeWebVtt([{ start: 1, end: 2.25, text: 'Hello' }])).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.250\nHello\n'
    );
  });

  it('separates cues with a blank line and keeps an empty track valid', () => {
    expect(
      serializeWebVtt([
        { start: 0, end: 1, text: 'first' },
        { start: 1, end: 2, text: 'second' },
      ])
    ).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfirst\n\n00:00:01.000 --> 00:00:02.000\nsecond\n'
    );
    expect(serializeWebVtt([])).toBe('WEBVTT\n\n\n');
  });
});
