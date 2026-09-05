import { describe, expect, it } from 'vitest';
import {
  assColor,
  assTime,
  BURN_IN_FONTS,
  buildAssDocument,
  burnInFfmpegArgs,
  escapeFfmpegFilterPath,
  parseBurnInStyle,
  regroupWordsIntoCues,
  scaleCueTimes,
  type BurnInStyle,
} from '@/lib/rough-cut/subtitle-style';

function style(overrides: Record<string, unknown> = {}): BurnInStyle {
  const parsed = parseBurnInStyle(overrides);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const WORDS = [
  { start: 0, end: 0.4, text: 'We' },
  { start: 0.5, end: 0.9, text: 'help' },
  { start: 1, end: 1.6, text: 'founders' },
  { start: 1.7, end: 2.1, text: 'raise' },
  { start: 2.2, end: 2.8, text: 'faster.' },
  { start: 5, end: 5.4, text: 'Thanks.' },
];

describe('parseBurnInStyle', () => {
  it('fills defaults and refuses bad values', () => {
    expect(style()).toMatchObject({
      font: 'dejavu-sans',
      fontSize: 48,
      textColor: '#FFFFFF',
      outlineColor: '#000000',
      outlineWidth: 2,
      backgroundOpacity: 0,
      position: 'bottom',
      marginVertical: 60,
      bold: true,
      uppercase: false,
      maxWordsPerCue: 6,
      maxCueSeconds: 4,
      playbackRate: 1,
    });
    expect(parseBurnInStyle({ fontSize: 8 }).ok).toBe(false);
    expect(parseBurnInStyle({ textColor: 'red' }).ok).toBe(false);
    expect(parseBurnInStyle({ font: 'comic-sans' }).ok).toBe(false);
    expect(parseBurnInStyle({ playbackRate: 3 }).ok).toBe(false);
    expect(parseBurnInStyle({ extra: true }).ok).toBe(false);
    expect(parseBurnInStyle(undefined).ok).toBe(true);
  });
});

describe('regroupWordsIntoCues', () => {
  it('cuts at the word limit, the time limit and a long pause', () => {
    expect(regroupWordsIntoCues(WORDS, style({ maxWordsPerCue: 3, maxCueSeconds: 4 }))).toEqual([
      { start: 0, end: 1.6, text: 'We help founders' },
      { start: 1.7, end: 2.8, text: 'raise faster.' },
      { start: 5, end: 5.6, text: 'Thanks.' },
    ]);

    // The word limit fires before the time limit above, so the time limit needs its own
    // case or removing it would change nothing. With a 1.5 s ceiling and no word limit in
    // the way, "founders" (ending 1.6, 1.6 s after "We" starts) opens a cue, "faster."
    // (ending 2.8, 1.8 s after "founders" starts) opens the next, and "Thanks." the last.
    expect(regroupWordsIntoCues(WORDS, style({ maxWordsPerCue: 14, maxCueSeconds: 1.5 }))).toEqual([
      { start: 0, end: 0.9, text: 'We help' },
      { start: 1, end: 2.1, text: 'founders raise' },
      { start: 2.2, end: 2.8, text: 'faster.' },
      { start: 5, end: 5.6, text: 'Thanks.' },
    ]);
  });

  it('uppercases when asked and keeps a cue from running into the next one', () => {
    const cues = regroupWordsIntoCues(
      [
        { start: 0, end: 0.1, text: 'a' },
        { start: 0.2, end: 0.3, text: 'b' },
        { start: 0.4, end: 0.5, text: 'c' },
      ],
      style({ maxWordsPerCue: 2, maxCueSeconds: 10, uppercase: true })
    );
    expect(cues).toEqual([
      { start: 0, end: 0.4, text: 'A B' },
      { start: 0.4, end: 1, text: 'C' },
    ]);
  });

  it('orders words by time and drops the ones that are only whitespace', () => {
    // Out of order, and with a blank token in the middle. Both are dropped or reordered
    // before grouping, so the two real words make one cue holding to 0.9.
    expect(
      regroupWordsIntoCues(
        [
          { start: 0.5, end: 0.9, text: 'help' },
          { start: 0.3, end: 0.35, text: '   ' },
          { start: 0, end: 0.4, text: 'We' },
        ],
        style({ maxWordsPerCue: 2 })
      )
    ).toEqual([{ start: 0, end: 0.9, text: 'We help' }]);
  });
});

describe('ASS output', () => {
  it('formats colours and times the ASS way', () => {
    expect(assColor('#FFFFFF')).toBe('&H00FFFFFF');
    expect(assColor('#FF8800')).toBe('&H000088FF');
    expect(assColor('#000000', 0.5)).toBe('&H80000000');
    expect(assTime(0)).toBe('0:00:00.00');
    expect(assTime(3725.456)).toBe('1:02:05.46');
    // Centiseconds are rounded as integers, so this never comes out as `0:00:00.100`.
    expect(assTime(0.999)).toBe('0:00:01.00');
  });

  it('writes one style from the options and one dialogue line per cue, scaled to the video height', () => {
    const doc = buildAssDocument(
      [{ start: 1, end: 2.5, text: 'Hello {there}\nfriend' }],
      style({ font: 'roboto', fontSize: 48, position: 'top', backgroundOpacity: 0.6, bold: false }),
      { width: 1280, height: 720 }
    );
    expect(doc).toContain('PlayResX: 1280');
    expect(doc).toContain('PlayResY: 720');
    expect(doc).toContain(
      'Style: Default,Roboto,32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,0,0,0,0,100,100,0,0,3,2,0,8,40,40,40,1'
    );
    expect(doc).toContain(
      'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Hello (there)\\Nfriend'
    );
    expect(BURN_IN_FONTS.find((font) => font.id === 'roboto')?.family).toBe('Roboto');
  });

  it('draws an outline instead of a box when the background is transparent', () => {
    const doc = buildAssDocument([], style({ outlineWidth: 4, position: 'center' }), {
      width: 1920,
      height: 1080,
    });
    // BorderStyle 1 (outline) rather than 3 (box), the operator's outline width of 4,
    // alignment 5 for centre, and at 1080 the size and margin are not scaled at all.
    expect(doc).toContain(
      'Style: Default,DejaVu Sans,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,0,5,40,40,60,1'
    );
    expect(doc).not.toContain('Dialogue:');
  });
});

describe('burnInFfmpegArgs', () => {
  it('uses the ass filter at normal speed and re-times video and audio at another', () => {
    const plain = burnInFfmpegArgs('/tmp/in.mp4', '/tmp/subs:1.ass', '/tmp/out.mp4', style());
    expect(plain).toContain('-vf');
    expect(plain[plain.indexOf('-vf') + 1]).toBe("ass='/tmp/subs\\:1.ass'");
    expect(plain).not.toContain('-filter_complex');
    expect(plain[plain.length - 1]).toBe('/tmp/out.mp4');

    const fast = burnInFfmpegArgs(
      '/tmp/in.mp4',
      '/tmp/subs.ass',
      '/tmp/out.mp4',
      style({ playbackRate: 1.25 })
    );
    expect(fast[fast.indexOf('-filter_complex') + 1]).toBe(
      "[0:v]setpts=PTS/1.25,ass='/tmp/subs.ass'[v];[0:a]atempo=1.25[a]"
    );
    expect(fast).toContain('[v]');
    expect(fast).toContain('[a]');
    expect(escapeFfmpegFilterPath("/a'b,c[d]")).toBe("/a\\'b\\,c\\[d\\]");
    // A backslash is doubled first, so the escapes added after it are not re-escaped.
    expect(escapeFfmpegFilterPath('/a\\b.ass')).toBe('/a\\\\b.ass');
  });

  it('scales cue times by the playback rate', () => {
    expect(scaleCueTimes([{ start: 2, end: 4, text: 'x' }], 2)).toEqual([
      { start: 1, end: 2, text: 'x' },
    ]);
  });
});
