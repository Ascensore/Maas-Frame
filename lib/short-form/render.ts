export type LoudnessMeasurement = {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
};

export function shortLoudnessAnalysisArgs(inputPath: string, start: number, end: number): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'info',
    '-ss',
    start.toFixed(3),
    '-t',
    (end - start).toFixed(3),
    '-i',
    inputPath,
    '-vn',
    '-af',
    'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json',
    '-f',
    'null',
    '-',
  ];
}

function trackValueExpression(
  track: Array<{ time: number; x: number; y: number }> | undefined,
  axis: 'x' | 'y'
): string | null {
  if (!track?.length) return null;
  const ordered = [...track].sort((a, b) => a.time - b.time);
  let expression = ordered[ordered.length - 1]![axis].toFixed(6);
  for (let index = ordered.length - 2; index >= 0; index -= 1) {
    const current = ordered[index]!;
    const next = ordered[index + 1]!;
    const duration = Math.max(0.001, next.time - current.time);
    const currentValue = current[axis];
    const delta = next[axis] - currentValue;
    const signedDelta = `${delta >= 0 ? '+' : ''}${delta.toFixed(6)}`;
    const interpolated = `${currentValue.toFixed(6)}${signedDelta}*max(0\\,min(1\\,(t-${current.time.toFixed(3)})/${duration.toFixed(3)}))`;
    expression = `if(lt(t\\,${next.time.toFixed(3)})\\,${interpolated}\\,${expression})`;
  }
  return expression;
}

function focusExpression(
  value: number | null | undefined,
  axis: 'x' | 'y',
  track?: Array<{ time: number; x: number; y: number }>
): string {
  const dynamic = trackValueExpression(track, axis);
  if (typeof value !== 'number' && !dynamic) return axis === 'x' ? '(iw-ow)/2' : '(ih-oh)/2';
  const dimension = axis === 'x' ? 'iw' : 'ih';
  const output = axis === 'x' ? 'ow' : 'oh';
  const focus = dynamic ?? value!.toFixed(6);
  return `max(0\\,min(${dimension}-${output}\\,${focus}*${dimension}-${output}/2))`;
}

export function shortRenderArgs(options: {
  inputPath: string;
  outputPath: string;
  assPath: string;
  start: number;
  end: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceFps: number;
  focusX?: number | null;
  focusY?: number | null;
  cropMode?: 'AUTO' | 'MANUAL' | 'PADDED';
  cropTrack?: Array<{ time: number; x: number; y: number }>;
  loudness: LoudnessMeasurement;
}): string[] {
  const sourceRatio = options.sourceWidth / options.sourceHeight;
  const targetRatio = 9 / 16;
  const crop =
    options.cropMode === 'PADDED' || sourceRatio < targetRatio
      ? `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black`
      : `crop=ih*9/16:ih:${focusExpression(options.focusX, 'x', options.cropTrack)}:${focusExpression(options.focusY, 'y', options.cropTrack)},scale=1080:1920`;
  const escapedAss = options.assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const loudness = options.loudness;
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    options.start.toFixed(3),
    '-t',
    (options.end - options.start).toFixed(3),
    '-i',
    options.inputPath,
    '-vf',
    `${crop},setsar=1,ass='${escapedAss}'`,
    '-af',
    `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${loudness.inputI}:measured_TP=${loudness.inputTp}:measured_LRA=${loudness.inputLra}:measured_thresh=${loudness.inputThresh}:offset=${loudness.targetOffset}:linear=true`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '21',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(Math.min(60, Math.max(1, options.sourceFps))),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    options.outputPath,
  ];
}
