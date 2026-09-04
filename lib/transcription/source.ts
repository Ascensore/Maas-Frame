import { OPENAI_MAX_AUDIO_BYTES } from '@/lib/transcription/chunk';
import { resolveServerBunnyCdnHostname } from '@/lib/bunny-cdn';
import { downloadVideoObject, headVideoObject } from '@/lib/r2';
import type { ReviewKind } from '@/lib/review-kind';
import { VIDEO_OBJECT_KEY_PREFIX, VIDEO_PROXY_PREFIX } from '@/lib/video-upload-validation';

/** Match the OpenAI upload budget, including multipart headroom. */
export const INLINE_TRANSCRIPTION_MAX_BYTES = OPENAI_MAX_AUDIO_BYTES;

const BUNNY_FALLBACK_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240];
const BUNNY_DOWNLOAD_TIMEOUT_MS = 60 * 1000;

export function isTooLargeForInlineTranscription(contentLength: bigint): boolean {
  return contentLength > BigInt(INLINE_TRANSCRIPTION_MAX_BYTES);
}

export function canRunInlineTranscription(kind: ReviewKind, contentLength?: bigint): boolean {
  if (kind !== 'AUDIO') return false;
  if (contentLength === undefined) return true;
  return !isTooLargeForInlineTranscription(contentLength);
}

export const INLINE_TRANSCRIPTION_TOO_LARGE_MESSAGE =
  'This file is too large to transcribe here (25 MiB limit). Start the media worker for larger files.';

export function r2ObjectKeyFromVersion(version: {
  providerId: string;
  videoId: string;
  originalUrl: string;
}): string | null {
  if (version.providerId !== 'r2') return null;
  if (version.videoId.startsWith(VIDEO_OBJECT_KEY_PREFIX)) return version.videoId;
  if (version.originalUrl.startsWith(VIDEO_OBJECT_KEY_PREFIX)) return version.originalUrl;
  if (version.originalUrl.startsWith(VIDEO_PROXY_PREFIX)) {
    return `${VIDEO_OBJECT_KEY_PREFIX}${version.originalUrl.slice(VIDEO_PROXY_PREFIX.length)}`;
  }
  const match = /\/api\/upload\/video\/([^/?]+)$/.exec(version.originalUrl);
  if (match?.[1]) return `${VIDEO_OBJECT_KEY_PREFIX}${match[1]}`;
  return null;
}

export type DownloadedVersionMedia = {
  bytes: Buffer;
  fileName: string;
};

async function fetchMediaUrl(url: string): Promise<Buffer | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(BUNNY_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) return null;
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && isTooLargeForInlineTranscription(BigInt(Math.trunc(length)))) {
      throw new Error(INLINE_TRANSCRIPTION_TOO_LARGE_MESSAGE);
    }
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) return null;
  if (isTooLargeForInlineTranscription(BigInt(bytes.byteLength))) {
    throw new Error(INLINE_TRANSCRIPTION_TOO_LARGE_MESSAGE);
  }
  return bytes;
}

async function downloadBunnyMedia(videoId: string): Promise<Buffer> {
  const hostname = resolveServerBunnyCdnHostname();
  if (!hostname) throw new Error('Bunny CDN is not configured');

  const urls = [
    `https://${hostname}/${videoId}/original`,
    ...BUNNY_FALLBACK_HEIGHTS.map((height) => `https://${hostname}/${videoId}/play_${height}p.mp4`),
  ];
  for (const url of urls) {
    try {
      const bytes = await fetchMediaUrl(url);
      if (bytes) return bytes;
    } catch (error) {
      if (error instanceof Error && error.message === INLINE_TRANSCRIPTION_TOO_LARGE_MESSAGE) {
        throw error;
      }
    }
  }
  throw new Error('Could not download this file from Bunny');
}

export async function downloadVersionMedia(version: {
  providerId: string;
  videoId: string;
  originalUrl: string;
}): Promise<DownloadedVersionMedia> {
  if (version.providerId === 'r2') {
    const key = r2ObjectKeyFromVersion(version);
    if (!key) throw new Error('Version has no extractable file');
    const head = await headVideoObject(key);
    if (!head) throw new Error('Media file was not found');
    if (isTooLargeForInlineTranscription(head.contentLength)) {
      throw new Error(INLINE_TRANSCRIPTION_TOO_LARGE_MESSAGE);
    }
    const bytes = await downloadVideoObject(key);
    if (!bytes) throw new Error('Media file was not found');
    if (isTooLargeForInlineTranscription(BigInt(bytes.byteLength))) {
      throw new Error(INLINE_TRANSCRIPTION_TOO_LARGE_MESSAGE);
    }
    const fileName = key.slice(VIDEO_OBJECT_KEY_PREFIX.length) || 'source.mp4';
    return { bytes, fileName };
  }

  if (version.providerId === 'bunny') {
    const bytes = await downloadBunnyMedia(version.videoId);
    return { bytes, fileName: `${version.videoId}.mp4` };
  }

  throw new Error('Version has no extractable file');
}

export function sourceFileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return '.mp4';
  return fileName.slice(dot);
}
