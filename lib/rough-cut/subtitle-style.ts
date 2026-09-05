import { z } from 'zod';
import type { SubtitleCue } from '../subtitle-validation';
import type { TimedWord } from './text';

/**
 * Burned-in subtitles: the style the operator picked, the ASS document
 * libass renders from it, and the ffmpeg arguments. Pure; the job supplies
 * words and video dimensions.
 */

export const BURN_IN_FONTS = [
  { id: 'dejavu-sans', family: 'DejaVu Sans', label: 'DejaVu Sans' },
  { id: 'liberation-sans', family: 'Liberation Sans', label: 'Liberation Sans (Arial-like)' },
  { id: 'roboto', family: 'Roboto', label: 'Roboto' },
  { id: 'open-sans', family: 'Open Sans', label: 'Open Sans' },
  { id: 'liberation-serif', family: 'Liberation Serif', label: 'Liberation Serif (Times-like)' },
  { id: 'dejavu-sans-mono', family: 'DejaVu Sans Mono', label: 'DejaVu Sans Mono' },
] as const;
export type BurnInFontId = (typeof BURN_IN_FONTS)[number]['id'];
const FONT_IDS = BURN_IN_FONTS.map((font) => font.id) as [BurnInFontId, ...BurnInFontId[]];

export const BURN_IN_POSITIONS = ['bottom', 'center', 'top'] as const;
export type BurnInPosition = (typeof BURN_IN_POSITIONS)[number];

/**
 * Font sizes are given for a 1080-pixel-high frame and scaled to the real
 * height. Height alone, deliberately: on a 1080x1920 phone cut the same point
 * size comes out roughly twice as large relative to the frame's width as it
 * does on a landscape master, which is the convention for vertical social
 * cuts. Scaling by width instead, or by the smaller side, would shrink them
 * back to something unreadable at arm's length.
 */
export const BURN_IN_REFERENCE_HEIGHT = 1080;
/** A pause longer than this between words starts a new cue. */
export const BURN_IN_CUE_GAP_SECONDS = 1;
/**
 * A cue never disappears faster than this after it starts, unless the next cue
 * starts. Measured in the time the viewer experiences: the grouping works in
 * source seconds, so the floor is stretched by the playback rate here and comes
 * back to 0.6 s once `scaleCueTimes` has divided the cue by that rate.
 */
export const BURN_IN_MIN_CUE_SECONDS = 0.6;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * The ends of every numeric field, named once so the schema below and the UI
 * that draws the sliders cannot disagree. A control that offered a value
 * outside these would be refused by the route with a validation error the
 * operator has no way to act on.
 */
export const BURN_IN_BOUNDS = {
  fontSize: { min: 16, max: 120 },
  outlineWidth: { min: 0, max: 6 },
  backgroundOpacity: { min: 0, max: 1 },
  marginVertical: { min: 0, max: 400 },
  maxWordsPerCue: { min: 1, max: 14 },
  maxCueSeconds: { min: 0.5, max: 10 },
  playbackRate: { min: 0.5, max: 2 },
} as const;

export const burnInStyleSchema = z
  .object({
    font: z.enum(FONT_IDS).default('dejavu-sans'),
    fontSize: z
      .number()
      .int()
      .min(BURN_IN_BOUNDS.fontSize.min)
      .max(BURN_IN_BOUNDS.fontSize.max)
      .default(48),
    textColor: z.string().regex(HEX_COLOR).default('#FFFFFF'),
    outlineColor: z.string().regex(HEX_COLOR).default('#000000'),
    outlineWidth: z
      .number()
      .min(BURN_IN_BOUNDS.outlineWidth.min)
      .max(BURN_IN_BOUNDS.outlineWidth.max)
      .default(2),
    /** 0 draws an outline only; above 0 draws a box behind the text with this opacity. */
    backgroundOpacity: z
      .number()
      .min(BURN_IN_BOUNDS.backgroundOpacity.min)
      .max(BURN_IN_BOUNDS.backgroundOpacity.max)
      .default(0),
    position: z.enum(BURN_IN_POSITIONS).default('bottom'),
    marginVertical: z
      .number()
      .int()
      .min(BURN_IN_BOUNDS.marginVertical.min)
      .max(BURN_IN_BOUNDS.marginVertical.max)
      .default(60),
    bold: z.boolean().default(true),
    uppercase: z.boolean().default(false),
    maxWordsPerCue: z
      .number()
      .int()
      .min(BURN_IN_BOUNDS.maxWordsPerCue.min)
      .max(BURN_IN_BOUNDS.maxWordsPerCue.max)
      .default(6),
    maxCueSeconds: z
      .number()
      .min(BURN_IN_BOUNDS.maxCueSeconds.min)
      .max(BURN_IN_BOUNDS.maxCueSeconds.max)
      .default(4),
    /** 1 keeps the timing; anything else re-times video, audio and cues together. */
    playbackRate: z
      .number()
      .min(BURN_IN_BOUNDS.playbackRate.min)
      .max(BURN_IN_BOUNDS.playbackRate.max)
      .default(1),
  })
  .strict();

export type BurnInStyle = z.infer<typeof burnInStyleSchema>;

export function parseBurnInStyle(
  input: unknown
): { ok: true; value: BurnInStyle } | { ok: false; error: string } {
  const parsed = burnInStyleSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first ? `${first.path.join('.') || 'style'}: ${first.message}` : 'Invalid style',
    };
  }
  return { ok: true, value: parsed.data };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Words become cues by count, duration, pauses and speaker changes. A cue holds
 * until its last word ends, or until a beat after the cue started when that is
 * later, and never into the next cue.
 */
export function regroupWordsIntoCues(words: TimedWord[], style: BurnInStyle): SubtitleCue[] {
  const ordered = [...words].filter((word) => word.text.trim()).sort((a, b) => a.start - b.start);
  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];
  for (const word of ordered) {
    const first = current[0];
    const last = current[current.length - 1];
    // A turn is a hard boundary: one caption carrying the end of an answer
    // and the start of the next question reads as one person saying both.
    const speakerChange =
      last?.speaker != null && word.speaker != null && last.speaker !== word.speaker;
    const breaks =
      speakerChange ||
      current.length >= style.maxWordsPerCue ||
      (first !== undefined && word.end - first.start > style.maxCueSeconds) ||
      (last !== undefined && word.start - last.end > BURN_IN_CUE_GAP_SECONDS);
    if (breaks && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, index) => {
    const next = groups[index + 1];
    const lastEnd = group[group.length - 1]!.end;
    const held = Math.max(lastEnd, group[0]!.start + BURN_IN_MIN_CUE_SECONDS * style.playbackRate);
    const end = next ? Math.min(held, next[0]!.start) : held;
    const text = group.map((word) => word.text.trim()).join(' ');
    return {
      start: round3(group[0]!.start),
      end: round3(Math.max(end, group[0]!.start)),
      text: style.uppercase ? text.toUpperCase() : text,
    };
  });
}

/**
 * The version label a burn-in lands under. Shared so the dialog promises the
 * label the job actually writes: it used to say "Subtitled" whatever the
 * playback rate, and a re-timed render arrives as "Subtitled 1.25x".
 */
export function burnInVersionLabel(playbackRate: number): string {
  return playbackRate === 1 ? 'Subtitled' : `Subtitled ${playbackRate}x`;
}

export function scaleCueTimes(cues: SubtitleCue[], rate: number): SubtitleCue[] {
  if (rate === 1) return cues;
  return cues.map((cue) => ({
    ...cue,
    start: round3(cue.start / rate),
    end: round3(cue.end / rate),
  }));
}

/** `#RRGGBB` (+ alpha 0–1, 0 opaque) to ASS `&HAABBGGRR`. */
export function assColor(hex: string, alpha = 0): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** `H:MM:SS.cc` */
export function assTime(seconds: number): string {
  const totalCentis = Math.round(Math.max(0, seconds) * 100);
  const hours = Math.floor(totalCentis / 360000);
  const minutes = Math.floor((totalCentis % 360000) / 6000);
  const secs = Math.floor((totalCentis % 6000) / 100);
  const centis = totalCentis % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function assText(text: string): string {
  // Backslashes first: libass reads `\N`, `\n` and `\h` as controls, so one
  // that arrived in the text has to stop being one before the line break
  // rewrite below adds a real `\N`. Doubling it does not do that — ASS has no
  // backslash escape, so libass draws the first one and then reads the second
  // together with what follows, leaving `\\N` a hard break with a backslash in
  // front of it. The only way out is to stop it being a backslash: U+2216 SET
  // MINUS draws the same stroke and controls nothing. DejaVu covers it;
  // Liberation, Roboto and Open Sans most likely do not. Where the chosen
  // family has no glyph, libass falls back per glyph through fontconfig and
  // draws it from another installed face, so the worst case is one character
  // in a different typeface rather than a tofu box. The Dockerfile's
  // `fc-match` loop does not cover this either way: it asserts that each
  // family resolves, not that any of them covers a particular codepoint.
  // Braces would open an override block.
  return text.replace(/\\/g, '∖').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N');
}

const ALIGNMENT: Record<BurnInPosition, number> = { bottom: 2, center: 5, top: 8 };

/** Left and right margins at the reference height, in ASS units. */
const SIDE_MARGIN = 40;

export function buildAssDocument(
  cues: SubtitleCue[],
  style: BurnInStyle,
  video: { width: number; height: number }
): string {
  const font = BURN_IN_FONTS.find((entry) => entry.id === style.font) ?? BURN_IN_FONTS[0];
  const scale = video.height / BURN_IN_REFERENCE_HEIGHT;
  const fontSize = Math.max(8, Math.round(style.fontSize * scale));
  const margin = Math.round(style.marginVertical * scale);
  // Scaled like everything else, or a 4K line runs from one edge to the other.
  const sideMargin = Math.round(SIDE_MARGIN * scale);
  // The outline is given against the same 1080-line reference as the font size,
  // so it has to be scaled with it. `ScaledBorderAndShadow: yes` would do this
  // for us if PlayRes differed from the frame, but PlayRes *is* the frame here,
  // so its factor is 1 and an unscaled 2 would come out half as thick at 4K as
  // the operator saw it. Fractions are legal in this field; two decimals is
  // finer than libass renders.
  const outlineWidth = round2(style.outlineWidth * scale);
  const boxed = style.backgroundOpacity > 0;
  const styleLine = [
    'Default',
    font.family,
    String(fontSize),
    assColor(style.textColor),
    assColor(style.textColor),
    assColor(style.outlineColor),
    boxed ? assColor(style.outlineColor, 1 - style.backgroundOpacity) : assColor('#000000', 0.5),
    style.bold ? '-1' : '0',
    '0',
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    boxed ? '3' : '1',
    String(outlineWidth),
    // Shadow, always off: zero scales to zero, so it needs no factor.
    '0',
    String(ALIGNMENT[style.position]),
    String(sideMargin),
    String(sideMargin),
    String(margin),
    '1',
  ].join(',');
  const events = cues.map(
    (cue) =>
      `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${assText(cue.text)}`
  );
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${video.width}`,
    `PlayResY: ${video.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${styleLine}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

/**
 * Escape a path for an ffmpeg filter option that the caller wraps in `'…'`.
 *
 * ffmpeg reads the value twice. First the filtergraph is tokenised (terminators
 * `[`, `]`, `,`, `;`), where a `'…'` run is copied out literally and a
 * backslash inside it is *not* an escape. What comes out of that is then read
 * again by the option parser, which splits on `:` and this time does honour
 * backslash escapes and quotes. So a doubled backslash survives level one and
 * becomes one backslash at level two, `\:` reaches level two as `\:` and
 * becomes `:`, and the graph terminators are already safe inside the quotes —
 * the backslashes on them are dropped at level two and cost nothing.
 *
 * An apostrophe is the exception, and the reason this is not a plain escape
 * table: inside the quotes there is no way to write one, because the quote run
 * ends at the first `'` whatever precedes it. It has to leave the quotes and
 * come back — `\` (literal, inside), `'` (closes), `\'` (escaped apostrophe,
 * outside), `'` (reopens) — which is level one's `\'` and level two's `'`.
 */
export function escapeFfmpegFilterPath(path: string): string {
  return path
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'\\''")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/;/g, '\\;');
}

export function burnInFfmpegArgs(
  inputPath: string,
  assPath: string,
  outputPath: string,
  style: BurnInStyle,
  /** False re-times the picture alone; a silent source has no `[0:a]` to name. */
  hasAudio = true
): string[] {
  // The surrounding `'` quotes the whole filter option value; escaping a `'`
  // inside the path as `\'` is what ffmpeg's filtergraph parser expects. See
  // "Notes on filtergraph escaping" in the ffmpeg-filters documentation.
  const ass = `ass='${escapeFfmpegFilterPath(assPath)}'`;
  const encode = [
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
    outputPath,
  ];
  if (style.playbackRate === 1) {
    return [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      ass,
      ...encode,
    ];
  }
  const rate = String(style.playbackRate);
  // Indexed labels, matching the `0:v:0` / `0:a:0?` maps above: `[0:v]` is
  // rejected outright when it matches more than one stream, which an MP4 with
  // cover art or a second audio language routinely does.
  //
  // `-map 0:a:0?` makes a silent source harmless at normal speed, but a
  // filtergraph has no optional inputs: naming `[0:a:0]` when there is no audio
  // stream fails the whole render.
  if (!hasAudio) {
    return [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-filter_complex',
      `[0:v:0]setpts=PTS/${rate},${ass}[v]`,
      '-map',
      '[v]',
      ...encode,
    ];
  }
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-filter_complex',
    `[0:v:0]setpts=PTS/${rate},${ass}[v];[0:a:0]atempo=${rate}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...encode,
  ];
}
