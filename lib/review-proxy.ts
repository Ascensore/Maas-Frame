export type ProbedVideo = {
  videoCodec: string | null;
  audioCodec: string | null;
  formatName: string | null;
};

const PLAYABLE_VIDEO = new Set(['h264', 'avc1', 'avc']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp4a', 'mp3', 'mp2']);

function includesMp4Family(formatName: string | null): boolean {
  if (!formatName) return false;
  const tokens = formatName.toLowerCase().split(',');
  return (
    tokens.includes('mp4') ||
    tokens.includes('mov') ||
    tokens.includes('m4v') ||
    tokens.includes('isom')
  );
}

/**
 * Camera masters (ProRes, DNxHR, HEVC, MXF, PCM-in-MOV, …) will not play in a
 * Chromium `<video>` tag. A review proxy is an H.264 AAC MP4 the player can use
 * instead. Browser-safe H.264 AAC MP4/MOV uploads skip the transcode unless the
 * project burns a watermark into the proxy.
 */
export function needsReviewProxy(probe: ProbedVideo): boolean {
  const video = (probe.videoCodec || '').toLowerCase();
  const audio = (probe.audioCodec || '').toLowerCase();
  const videoOk = PLAYABLE_VIDEO.has(video);
  const audioOk = !audio || PLAYABLE_AUDIO.has(audio);
  const containerOk = includesMp4Family(probe.formatName);
  return !(videoOk && audioOk && containerOk);
}

export function shouldTranscodeReviewProxy(
  probe: ProbedVideo,
  options: { kind?: string | null; watermarkReviews?: boolean }
): boolean {
  if (options.kind && options.kind !== 'VIDEO') return false;
  if (options.watermarkReviews) return true;
  return needsReviewProxy(probe);
}

export function reviewProxyBurnInLabel(projectName: string): string {
  const name = projectName.trim().slice(0, 60);
  return `CONFIDENTIAL · ${name || 'Review'}`;
}

function escapeFfmpegDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '%%')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 80);
}

const SCALE_PAD =
  "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2";

export function reviewProxyFfmpegArgs(
  inputPath: string,
  outputPath: string,
  burnInLabel?: string | null
): string[] {
  const label = burnInLabel?.trim() ?? '';
  const vf = label
    ? `${SCALE_PAD},drawtext=text='${escapeFfmpegDrawtext(label)}':fontsize=h/18:fontcolor=white@0.18:x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.35:shadowx=2:shadowy=2`
    : SCALE_PAD;

  return [
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    vf,
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
}
