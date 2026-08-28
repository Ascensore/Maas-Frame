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
  return tokens.includes('mp4') || tokens.includes('mov') || tokens.includes('m4v') || tokens.includes('isom');
}

/**
 * Keep in lockstep with lib/review-proxy.ts. The worker image cannot import
 * from the app tree (Docker context is ./worker).
 */
export function needsReviewProxy(probe: ProbedVideo): boolean {
  const video = (probe.videoCodec || '').toLowerCase();
  const audio = (probe.audioCodec || '').toLowerCase();
  const videoOk = PLAYABLE_VIDEO.has(video);
  const audioOk = !audio || PLAYABLE_AUDIO.has(audio);
  const containerOk = includesMp4Family(probe.formatName);
  return !(videoOk && audioOk && containerOk);
}

export function reviewProxyFfmpegArgs(inputPath: string, outputPath: string): string[] {
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
    "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2",
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
