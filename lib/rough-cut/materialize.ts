export type MaterializeSegment = {
  inputPath: string;
  inSeconds: number;
  outSeconds: number;
};

function formatSeconds(value: number): string {
  return value.toFixed(3);
}

/**
 * ffmpeg args that trim each source to its EDL in/out and concatenate onto
 * one H.264 AAC MP4. Inputs are already on disk; `-ss`/`-t` come before `-i`
 * so ffmpeg seeks in the source.
 */
export function materializeFfmpegArgs(
  segments: MaterializeSegment[],
  outputPath: string
): string[] {
  if (segments.length === 0) {
    throw new Error('A review proxy needs at least one edit');
  }

  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const segment of segments) {
    const duration = Math.max(0, segment.outSeconds - segment.inSeconds);
    args.push(
      '-ss',
      formatSeconds(segment.inSeconds),
      '-t',
      formatSeconds(duration),
      '-i',
      segment.inputPath
    );
  }

  const pairs = segments.map((_segment, index) => `[${index}:v:0][${index}:a:0]`).join('');
  const filter = `${pairs}concat=n=${segments.length}:v=1:a=1[vout][aout]`;

  args.push(
    '-filter_complex',
    filter,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    outputPath
  );
  return args;
}
