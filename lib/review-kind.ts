import { detectImageMime } from '@/lib/image-upload-validation';

export type ReviewKind = 'VIDEO' | 'IMAGE' | 'PDF' | 'AUDIO';

export type ReviewPlayerMode = 'native-video' | 'image' | 'pdf' | 'embed';

type ReviewUpload = {
  contentType: string;
  kind: ReviewKind;
  extension: string;
};

const BY_EXTENSION: Record<string, ReviewUpload> = {
  mp4: { contentType: 'video/mp4', kind: 'VIDEO', extension: 'mp4' },
  webm: { contentType: 'video/webm', kind: 'VIDEO', extension: 'webm' },
  ogg: { contentType: 'video/ogg', kind: 'VIDEO', extension: 'ogg' },
  mov: { contentType: 'video/quicktime', kind: 'VIDEO', extension: 'mov' },
  m4v: { contentType: 'video/mp4', kind: 'VIDEO', extension: 'm4v' },
  mkv: { contentType: 'video/x-matroska', kind: 'VIDEO', extension: 'mkv' },
  avi: { contentType: 'video/x-msvideo', kind: 'VIDEO', extension: 'avi' },
  jpg: { contentType: 'image/jpeg', kind: 'IMAGE', extension: 'jpg' },
  jpeg: { contentType: 'image/jpeg', kind: 'IMAGE', extension: 'jpg' },
  png: { contentType: 'image/png', kind: 'IMAGE', extension: 'png' },
  webp: { contentType: 'image/webp', kind: 'IMAGE', extension: 'webp' },
  gif: { contentType: 'image/gif', kind: 'IMAGE', extension: 'gif' },
  pdf: { contentType: 'application/pdf', kind: 'PDF', extension: 'pdf' },
  mp3: { contentType: 'audio/mpeg', kind: 'AUDIO', extension: 'mp3' },
  wav: { contentType: 'audio/wav', kind: 'AUDIO', extension: 'wav' },
  m4a: { contentType: 'audio/mp4', kind: 'AUDIO', extension: 'm4a' },
  aac: { contentType: 'audio/aac', kind: 'AUDIO', extension: 'aac' },
  flac: { contentType: 'audio/flac', kind: 'AUDIO', extension: 'flac' },
};

function extensionOf(fileName: string): string | null {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (!ext || ext === fileName.toLowerCase()) return null;
  return ext;
}

export function reviewKindFromFileName(fileName: string): ReviewKind | null {
  const ext = extensionOf(fileName);
  if (!ext) return null;
  return BY_EXTENSION[ext]?.kind ?? null;
}

export function resolveReviewUpload(
  fileName: string,
  mime: string | undefined
): ReviewUpload | null {
  const ext = extensionOf(fileName);
  if (!ext) return null;
  const mapped = BY_EXTENSION[ext];
  if (!mapped) return null;
  void mime;
  return mapped;
}

export function shouldEnqueueProbe(kind: ReviewKind, providerId: string): boolean {
  const fileBacked = providerId === 'r2' || providerId === 'bunny';
  if (!fileBacked) return false;
  return kind === 'VIDEO' || kind === 'AUDIO';
}

/**
 * File-backed VIDEO and AUDIO can be sent to STT. YouTube/Vimeo have no
 * downloadable master, and stills/PDFs have no audio.
 */
export function canAutoTranscribe(kind: ReviewKind, providerId: string): boolean {
  const fileBacked = providerId === 'r2' || providerId === 'bunny';
  return fileBacked && (kind === 'VIDEO' || kind === 'AUDIO');
}

/**
 * Burning captions into the picture needs a picture and a master to re-encode.
 * Narrower than `canAutoTranscribe` by exactly one kind: an audio review is
 * file-backed and can hold a ready transcript, so nothing but the kind
 * separates it from a video, and the burn-in route refuses it with a 400. This
 * is the same gate, asked before the menu entry is drawn rather than after the
 * operator has filled in a dialog.
 */
export function canBurnInSubtitles(kind: ReviewKind, providerId: string): boolean {
  const fileBacked = providerId === 'r2' || providerId === 'bunny';
  return fileBacked && kind === 'VIDEO';
}

export function shouldEnqueueTranscribe(
  kind: ReviewKind,
  providerId: string,
  transcriptionEnabled: boolean
): boolean {
  return transcriptionEnabled && canAutoTranscribe(kind, providerId);
}

export function reviewPlayerMode(
  kind: ReviewKind,
  providerId: string | undefined
): ReviewPlayerMode {
  if (kind === 'IMAGE') return 'image';
  if (kind === 'PDF') return 'pdf';
  if (providerId === 'r2' || providerId === 'bunny' || kind === 'AUDIO') return 'native-video';
  return 'embed';
}

function hasKnownVideoContainerBytes(bytes: Uint8Array): boolean {
  if (bytes.length >= 12) {
    const box = String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0);
    if (box === 'ftyp') return true;
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return true;
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    return true;
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x41 &&
    bytes[9] === 0x56 &&
    bytes[10] === 0x49 &&
    bytes[11] === 0x20
  ) {
    return true;
  }
  return false;
}

function hasKnownAudioContainerBytes(extension: string, bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (extension === 'wav') {
    return (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x41 &&
      bytes[10] === 0x56 &&
      bytes[11] === 0x45
    );
  }
  if (extension === 'mp3') {
    const hasId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const hasMpegSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    return hasId3 || hasMpegSync;
  }
  if (extension === 'm4a') {
    return (
      bytes.length >= 8 &&
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    );
  }
  if (extension === 'flac') {
    return bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43;
  }
  if (extension === 'aac') {
    return bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0;
  }
  return false;
}

/**
 * First-bytes check keyed off the filename's extension. A renamed .exe that
 * claims to be a png still fails here, because the magic has to match the kind
 * the extension selected.
 */
export function hasKnownReviewMagicBytes(fileName: string, bytes: Uint8Array): boolean {
  const mapped = resolveReviewUpload(fileName, undefined);
  if (!mapped) return false;
  if (mapped.kind === 'VIDEO') return hasKnownVideoContainerBytes(bytes);
  if (mapped.kind === 'IMAGE') return detectImageMime(bytes) === mapped.contentType;
  if (mapped.kind === 'PDF') {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46
    );
  }
  return hasKnownAudioContainerBytes(mapped.extension, bytes);
}

export function reviewKindFromUploadPath(videoUrl: string, providerId: string): ReviewKind {
  if (providerId !== 'r2') return 'VIDEO';
  const fileName = videoUrl.split('/').pop() ?? '';
  return reviewKindFromFileName(fileName) ?? 'VIDEO';
}
