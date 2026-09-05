import { describe, expect, it } from 'vitest';
import {
  assColor,
  assTime,
  BURN_IN_FONTS,
  buildAssDocument,
  burnInFfmpegArgs,
  burnInVersionLabel,
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

  it('refuses a value just outside every bound', () => {
    // Each of these is one step past a limit, so widening or dropping that
    // limit is what makes the case go green — the accepted neighbour below
    // keeps the bound from simply being tightened instead.
    const refused: Array<[string, Record<string, unknown>]> = [
      ['slower than half speed', { playbackRate: 0.25 }],
      ['a font size over the ceiling', { fontSize: 121 }],
      ['a fractional font size', { fontSize: 30.5 }],
      ['an outline thicker than 6', { outlineWidth: 7 }],
      ['an opacity over 1', { backgroundOpacity: 1.1 }],
      ['a margin past the frame', { marginVertical: 401 }],
      ['more than 14 words to a cue', { maxWordsPerCue: 15 }],
      ['a cue shorter than half a second', { maxCueSeconds: 0.4 }],
      ['a colour name instead of a hex triplet', { outlineColor: 'black' }],
    ];
    for (const [why, input] of refused) {
      expect([why, parseBurnInStyle(input).ok]).toEqual([why, false]);
    }
    // The value on the legal side of each of those bounds is accepted.
    expect(
      parseBurnInStyle({
        playbackRate: 0.5,
        fontSize: 120,
        outlineWidth: 6,
        backgroundOpacity: 1,
        marginVertical: 400,
        maxWordsPerCue: 14,
        maxCueSeconds: 0.5,
        outlineColor: '#000000',
      }).ok
    ).toBe(true);
  });
});

describe('BURN_IN_FONTS', () => {
  it('offers the six families the worker image installs', () => {
    // Written out rather than mapped from the constant: the families are what
    // libass looks up by name, and a typo here has to fail rather than agree
    // with itself. Keep in step with the font packages in worker/Dockerfile.
    expect(BURN_IN_FONTS.map((font) => [font.id, font.family, font.label])).toEqual([
      ['dejavu-sans', 'DejaVu Sans', 'DejaVu Sans'],
      ['liberation-sans', 'Liberation Sans', 'Liberation Sans (Arial-like)'],
      ['roboto', 'Roboto', 'Roboto'],
      ['open-sans', 'Open Sans', 'Open Sans'],
      ['liberation-serif', 'Liberation Serif', 'Liberation Serif (Times-like)'],
      ['dejavu-sans-mono', 'DejaVu Sans Mono', 'DejaVu Sans Mono'],
    ]);
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

  it('holds a short cue for the same time on screen at any playback rate', () => {
    const word = [{ start: 0, end: 0.1, text: 'Hi' }];
    // The grouping works in source seconds but the floor is about reading
    // time, so it is stretched by the rate here and divided back out by
    // scaleCueTimes. Enforcing it before the scaling left a 2x render showing
    // its shortest captions for 0.3 s.
    expect(regroupWordsIntoCues(word, style())).toEqual([{ start: 0, end: 0.6, text: 'Hi' }]);
    const fast = regroupWordsIntoCues(word, style({ playbackRate: 2 }));
    expect(fast).toEqual([{ start: 0, end: 1.2, text: 'Hi' }]);
    expect(scaleCueTimes(fast, 2)).toEqual([{ start: 0, end: 0.6, text: 'Hi' }]);
  });

  it('starts a new cue when the speaker changes', () => {
    const turn = [
      { start: 0, end: 0.4, text: 'Yes', speaker: 'A' },
      { start: 0.5, end: 0.9, text: 'exactly', speaker: 'A' },
      { start: 1, end: 1.4, text: 'And', speaker: 'B' },
      { start: 1.5, end: 1.9, text: 'you?', speaker: 'B' },
    ];
    // Four words, six to a cue, no pause over a second and under four seconds
    // end to end: nothing but the turn can split them.
    expect(regroupWordsIntoCues(turn, style())).toEqual([
      { start: 0, end: 0.9, text: 'Yes exactly' },
      { start: 1, end: 1.9, text: 'And you?' },
    ]);
    // The same words with nobody attributed stay in one caption, which is what
    // makes the split above the speaker's doing.
    expect(
      regroupWordsIntoCues(
        turn.map((word) => ({ start: word.start, end: word.end, text: word.text })),
        style()
      )
    ).toEqual([{ start: 0, end: 1.9, text: 'Yes exactly And you?' }]);
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
    // At 720 the scale is two thirds, so the 48 pt size becomes 32, the 60
    // margin becomes 40, the 40 side margins become 27 with it (a 4K line would
    // otherwise keep 40 units of air and run edge to edge) and the 2-unit
    // outline becomes 1.33.
    expect(doc).toContain(
      'Style: Default,Roboto,32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,0,0,0,0,100,100,0,0,3,1.33,0,8,27,27,40,1'
    );
    expect(doc).toContain(
      'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Hello (there)\\Nfriend'
    );
  });

  it('stops a backslash in the text from becoming an ASS control', () => {
    // libass reads \N, \n and \h as controls, so a backslash that arrived in
    // the words has to stop being one before the line break rewrite adds a
    // real \N of its own. Doubling it is not an escape — ASS has none — so the
    // backslash is swapped for U+2216 SET MINUS, and a line that said `\N`
    // must not leave a single `\N` anywhere in the document.
    const literal = buildAssDocument([{ start: 0, end: 1, text: 'a\\Nb' }], style(), {
      width: 1920,
      height: 1080,
    });
    expect(literal).toContain('Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,a∖Nb');
    expect(literal).not.toContain('\\N');

    // A newline the operator actually wrote is still the one thing that turns
    // into the control, and braces still lose their override meaning.
    const doc = buildAssDocument(
      [{ start: 0, end: 1, text: 'back\\slash {and} a\nbreak' }],
      style(),
      { width: 1920, height: 1080 }
    );
    expect(doc).toContain(
      'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,back∖slash (and) a\\Nbreak'
    );
  });

  it('writes the operator\u2019s colours, size and margin into the style line unscaled at 1080', () => {
    const doc = buildAssDocument(
      [],
      style({
        position: 'bottom',
        textColor: '#FFCC00',
        outlineColor: '#101820',
        fontSize: 64,
        marginVertical: 120,
      }),
      { width: 1920, height: 1080 }
    );
    // Fields in order: name, font, size, primary, secondary, outline, back,
    // bold, italic, underline, strikeout, scaleX, scaleY, spacing, angle,
    // border style, outline width, shadow, alignment (2 = bottom centre),
    // marginL, marginR, marginV, encoding. ASS colours are &HAABBGGRR, so
    // #FFCC00 comes out with its bytes reversed.
    expect(doc).toContain(
      'Style: Default,DejaVu Sans,64,&H0000CCFF,&H0000CCFF,&H00201810,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,40,40,120,1'
    );
  });

  it('writes a whole document a libass build can read', () => {
    // Pinned end to end so the section order, both Format lines and the
    // trailing newline cannot drift; libass reads the Format line to know what
    // the Style and Dialogue fields mean.
    expect(
      buildAssDocument([{ start: 0, end: 1.2, text: 'Hello' }], style(), {
        width: 1920,
        height: 1080,
      })
    ).toBe(
      [
        '[Script Info]',
        'ScriptType: v4.00+',
        'PlayResX: 1920',
        'PlayResY: 1080',
        'WrapStyle: 0',
        'ScaledBorderAndShadow: yes',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        'Style: Default,DejaVu Sans,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,40,40,60,1',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:00.00,0:00:01.20,Default,,0,0,0,,Hello',
        '',
      ].join('\n')
    );
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

  it('scales the outline with the font size instead of leaving it thin at 4K', () => {
    // PlayRes is the frame here, so `ScaledBorderAndShadow` has nothing to
    // scale by and the outline has to be scaled explicitly. At 2160 the factor
    // is 2: a 3-unit outline is written as 6, the same proportion of the 96 pt
    // line the operator saw against a 1080 preview. An unscaled 3 would render
    // at half the weight they picked.
    const uhd = buildAssDocument([], style({ outlineWidth: 3, fontSize: 48 }), {
      width: 3840,
      height: 2160,
    });
    expect(uhd).toContain(
      'Style: Default,DejaVu Sans,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,0,2,80,80,120,1'
    );

    // Nothing moves at the reference height, whole or fractional.
    const hd = buildAssDocument([], style({ outlineWidth: 2.5 }), { width: 1920, height: 1080 });
    expect(hd).toContain(',0,0,1,2.5,0,2,40,40,60,1');

    // A vertical phone cut scales by height alone, so 1080x1920 keeps 1.
    const vertical = buildAssDocument([], style({ outlineWidth: 2 }), {
      width: 1080,
      height: 1920,
    });
    expect(vertical).toContain(',0,0,1,3.56,0,2,71,71,107,1');
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
      "[0:v:0]setpts=PTS/1.25,ass='/tmp/subs.ass'[v];[0:a:0]atempo=1.25[a]"
    );
    expect(fast).toContain('[v]');
    expect(fast).toContain('[a]');
    expect(escapeFfmpegFilterPath("/a'b,c[d]")).toBe(String.raw`/a\'\''b\,c\[d\]`);
    // A backslash is doubled first, so the escapes added after it are not re-escaped.
    expect(escapeFfmpegFilterPath('/a\\b.ass')).toBe('/a\\\\b.ass');

    // ffmpeg reads the value twice: the filtergraph tokeniser, where a quoted
    // run is copied out literally and a backslash is NOT an escape, and then
    // the option parser, which does honour both. An apostrophe cannot be
    // written inside the quotes at all — the run ends at the first one — so it
    // leaves and comes back: `\` inside, `'` closes, `\'` outside, `'` reopens.
    expect(escapeFfmpegFilterPath(String.raw`C:\dir\o'brien.ass`)).toBe(
      String.raw`C\:\\dir\\o\'\''brien.ass`
    );
  });

  it('spells out every encoder argument at normal speed and at another', () => {
    // The encode settings are the deliverable, not an implementation detail:
    // a proxy the browser cannot play is what a dropped -pix_fmt or a missing
    // +faststart produces, and neither shows up as a failed job.
    expect(burnInFfmpegArgs('/tmp/in.mp4', '/tmp/subs.ass', '/tmp/out.mp4', style())).toEqual([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      '/tmp/in.mp4',
      '-map',
      '0:v:0',
      // Optional, so a silent source still encodes at normal speed.
      '-map',
      '0:a:0?',
      '-vf',
      "ass='/tmp/subs.ass'",
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      '/tmp/out.mp4',
    ]);

    expect(
      burnInFfmpegArgs(
        '/tmp/in.mp4',
        '/tmp/subs.ass',
        '/tmp/out.mp4',
        style({ playbackRate: 1.25 })
      )
    ).toEqual([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      '/tmp/in.mp4',
      '-filter_complex',
      "[0:v:0]setpts=PTS/1.25,ass='/tmp/subs.ass'[v];[0:a:0]atempo=1.25[a]",
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      '/tmp/out.mp4',
    ]);
  });

  it('names one stream per filtergraph label', () => {
    // `[0:v]` is rejected outright by ffmpeg when the specifier matches more
    // than one stream, and cover art in an MP4 or a second audio language
    // makes that the normal case rather than the exotic one. The rate-1 path
    // has always used indexed maps; the filtergraph has to agree.
    const fast = burnInFfmpegArgs(
      '/tmp/in.mp4',
      '/tmp/subs.ass',
      '/tmp/out.mp4',
      style({ playbackRate: 1.5 })
    );
    const graph = fast[fast.indexOf('-filter_complex') + 1]!;
    expect(graph.startsWith('[0:v:0]')).toBe(true);
    expect(graph).toContain('[0:a:0]atempo=1.5[a]');
    expect(graph).not.toMatch(/\[0:v\]|\[0:a\]/);
  });

  it('leaves the audio stream unnamed when the source is silent', () => {
    // A filtergraph has no optional inputs: `[0:a]` on a source with no audio
    // stream fails the whole render, which is how a silent clip used to come
    // back as a failed job at any speed but 1.
    const silent = burnInFfmpegArgs(
      '/tmp/in.mp4',
      '/tmp/subs.ass',
      '/tmp/out.mp4',
      style({ playbackRate: 2 }),
      false
    );
    expect(silent[silent.indexOf('-filter_complex') + 1]).toBe(
      "[0:v:0]setpts=PTS/2,ass='/tmp/subs.ass'[v]"
    );
    expect(silent.slice(silent.indexOf('-filter_complex'), silent.indexOf('-c:v'))).toEqual([
      '-filter_complex',
      "[0:v:0]setpts=PTS/2,ass='/tmp/subs.ass'[v]",
      '-map',
      '[v]',
    ]);
    expect(silent.join(' ')).not.toContain('atempo');

    // The same call with audio keeps both branches, so `hasAudio` is what
    // decides and not the rate.
    const heard = burnInFfmpegArgs(
      '/tmp/in.mp4',
      '/tmp/subs.ass',
      '/tmp/out.mp4',
      style({ playbackRate: 2 }),
      true
    );
    expect(heard[heard.indexOf('-filter_complex') + 1]).toBe(
      "[0:v:0]setpts=PTS/2,ass='/tmp/subs.ass'[v];[0:a:0]atempo=2[a]"
    );
    expect(heard.slice(heard.indexOf('-map'))).toContain('[a]');
  });

  it('scales cue times by the playback rate', () => {
    expect(scaleCueTimes([{ start: 2, end: 4, text: 'x' }], 2)).toEqual([
      { start: 1, end: 2, text: 'x' },
    ]);
  });
});

describe('burnInVersionLabel', () => {
  it('names the rate whenever the render re-times the picture', () => {
    // The dialog promises this label before the job writes it, so the two read
    // the same rule. A dialog that always said "Subtitled" would send an
    // operator looking for a version that is filed under "Subtitled 1.25x".
    expect(burnInVersionLabel(1)).toBe('Subtitled');
    expect(burnInVersionLabel(1.25)).toBe('Subtitled 1.25x');
    expect(burnInVersionLabel(0.5)).toBe('Subtitled 0.5x');
    expect(burnInVersionLabel(2)).toBe('Subtitled 2x');
  });
});
