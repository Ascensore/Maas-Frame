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

/** Font sizes are given for a 1080-pixel-high frame and scaled to the real height. */
export const BURN_IN_REFERENCE_HEIGHT = 1080;
/** A pause longer than this between words starts a new cue. */
export const BURN_IN_CUE_GAP_SECONDS = 1;
/** A cue never disappears faster than this after it starts, unless the next cue starts. */
export const BURN_IN_MIN_CUE_SECONDS = 0.6;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const burnInStyleSchema = z
  .object({
    font: z.enum(FONT_IDS).default('dejavu-sans'),
    fontSize: z.number().int().min(16).max(120).default(48),
    textColor: z.string().regex(HEX_COLOR).default('#FFFFFF'),
    outlineColor: z.string().regex(HEX_COLOR).default('#000000'),
    outlineWidth: z.number().min(0).max(6).default(2),
    /** 0 draws an outline only; above 0 draws a box behind the text with this opacity. */
    backgroundOpacity: z.number().min(0).max(1).default(0),
    position: z.enum(BURN_IN_POSITIONS).default('bottom'),
    marginVertical: z.number().int().min(0).max(400).default(60),
    bold: z.boolean().default(true),
    uppercase: z.boolean().default(false),
    maxWordsPerCue: z.number().int().min(1).max(14).default(6),
    maxCueSeconds: z.number().min(0.5).max(10).default(4),
    /** 1 keeps the timing; anything else re-times video, audio and cues together. */
    playbackRate: z.number().min(0.5).max(2).default(1),
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

/**
 * Words become cues by count, duration and pauses; a cue holds until its last
 * word plus a beat, never into the next cue.
 */
export function regroupWordsIntoCues(words: TimedWord[], style: BurnInStyle): SubtitleCue[] {
  const ordered = [...words].filter((word) => word.text.trim()).sort((a, b) => a.start - b.start);
  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];
  for (const word of ordered) {
    const first = current[0];
    const last = current[current.length - 1];
    const breaks =
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
    const held = Math.max(lastEnd, group[0]!.start + BURN_IN_MIN_CUE_SECONDS);
    const end = next ? Math.min(held, next[0]!.start) : held;
    const text = group.map((word) => word.text.trim()).join(' ');
    return {
      start: round3(group[0]!.start),
      end: round3(Math.max(end, group[0]!.start)),
      text: style.uppercase ? text.toUpperCase() : text,
    };
  });
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
  // Braces would open an override block; newlines are ASS line breaks.
  return text.replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N');
}

const ALIGNMENT: Record<BurnInPosition, number> = { bottom: 2, center: 5, top: 8 };

export function buildAssDocument(
  cues: SubtitleCue[],
  style: BurnInStyle,
  video: { width: number; height: number }
): string {
  const font = BURN_IN_FONTS.find((entry) => entry.id === style.font) ?? BURN_IN_FONTS[0];
  const scale = video.height / BURN_IN_REFERENCE_HEIGHT;
  const fontSize = Math.max(8, Math.round(style.fontSize * scale));
  const margin = Math.round(style.marginVertical * scale);
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
    String(style.outlineWidth),
    '0',
    String(ALIGNMENT[style.position]),
    '40',
    '40',
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

/** ffmpeg filter option values need these characters escaped. */
export function escapeFfmpegFilterPath(path: string): string {
  return path
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
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
  style: BurnInStyle
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
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-filter_complex',
    `[0:v]setpts=PTS/${rate},${ass}[v];[0:a]atempo=${rate}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...encode,
  ];
}
