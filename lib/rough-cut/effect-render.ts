import type { TimelineEffect } from './effects';

function assTime(seconds: number): string {
  const cs = Math.round(seconds * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
function color(hex: string): string {
  return `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`;
}
// ASS has executable formatting syntax: feedback is always plain text.
function plain(text: string): string {
  return text
    .replace(/\\/g, '＼')
    .replace(/{/g, '｛')
    .replace(/}/g, '｝')
    .replace(/[\r\n]+/g, ' ');
}

/** libass scales the reference canvas to the video. Motion and colors are template-owned. */
export function graphicsAss(effects: TimelineEffect[]): string {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  return (
    header +
    effects
      .filter((e) => e.kind === 'graphic')
      .flatMap((e) => {
        const y = e.preset.id === 'lower-third' ? 820 : 400;
        const anim = `\\an7\\move(64,${y},96,${y},0,240)\\fad(180,180)`;
        const line = (layer: number, body: string) =>
          `Dialogue: ${layer},${assTime(e.start)},${assTime(e.end)},Default,,0,0,0,,${body}\n`;
        // Font shrinks for longer text; fixed limits bound the template's safe text box.
        const titleSize = Math.min(48, Math.floor(1600 / Math.max(1, e.title.length) / 0.7));
        const subtitleSize = Math.min(32, Math.floor(1600 / Math.max(1, e.subtitle.length) / 0.7));
        return [
          line(
            0,
            `{${anim}\\1c${color(e.preset.background)}\\1a&H20&\\p1}m 0 0 l 1728 0 1728 170 0 170{\\p0}`
          ),
          line(1, `{${anim}\\1c${color(e.preset.accent)}\\p1}m 0 0 l 10 0 10 170 0 170{\\p0}`),
          line(
            2,
            `{\\an7\\move(96,${y + 24},128,${y + 24},0,240)\\fad(180,180)\\fs${titleSize}\\1c${color(e.preset.foreground)}}${plain(e.title)}`
          ),
          ...(e.subtitle
            ? [
                line(
                  2,
                  `{\\an7\\move(96,${y + 94},128,${y + 94},0,240)\\fad(180,180)\\b0\\fs${subtitleSize}\\1c${color(e.preset.foreground)}}${plain(e.subtitle)}`
                ),
              ]
            : []),
        ];
      })
      .join('')
  );
}

export function effectFfmpegArgs(options: {
  input: string;
  output: string;
  effects: TimelineEffect[];
  files: Map<string, string>;
  width: number;
  height: number;
  assPath: string;
}): string[] {
  const { input, output, effects, files, width, height, assPath } = options;
  if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 16384))
    throw new Error('Invalid video dimensions');
  const broll = effects.filter((e) => e.kind === 'broll');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
  const filters: string[] = ['[0:v]setpts=PTS-STARTPTS[base0]'];
  broll.forEach((effect, index) => {
    const file = files.get(effect.sourceVersionId);
    if (!file) throw new Error('B-roll source file is missing');
    args.push('-ss', String(effect.sourceIn), '-t', String(effect.end - effect.start), '-i', file);
    filters.push(
      `[${index + 1}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,setpts=PTS-STARTPTS+${effect.start}/TB[cover${index}]`
    );
    filters.push(
      `[base${index}][cover${index}]overlay=eof_action=pass:repeatlast=0:enable='gte(t,${effect.start})*lt(t,${effect.end})'[base${index + 1}]`
    );
  });
  let label = `base${broll.length}`;
  if (effects.some((e) => e.kind === 'graphic')) {
    const path = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    filters.push(`[${label}]ass='${path}'[styled]`);
    label = 'styled';
  }
  return [
    ...args,
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${label}]`,
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    output,
  ];
}
