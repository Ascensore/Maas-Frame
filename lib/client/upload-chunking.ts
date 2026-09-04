/**
 * Pure arithmetic extracted from `r2-video-upload.ts`.
 *
 * The uploader itself is XMLHttpRequest wiring, `fetch` calls and timers, so the
 * only test that can reach it is the end-to-end upload spec, and that spec only
 * ever walks the happy path. The numbers below are the part of the uploader that
 * is actually worth pinning down: which bytes each multipart part carries, how
 * long a failed part waits before it is retried, and what percentage the UI is
 * told. They live here so they can be called directly with fixed inputs.
 *
 * Nothing in this module touches the network, the DOM or a timer.
 */

/**
 * Wait, in milliseconds, before each attempt at uploading a single multipart
 * part, indexed by attempt number. Index 0 is the first try and is never waited
 * on, so the schedule is really "try, then retry after 2s, 5s and 10s": four
 * attempts and at most 17 seconds of backoff per part.
 */
export const PART_RETRY_DELAYS_MS = [0, 2000, 5000, 10000];

/**
 * How long attempt `attempt` waits before it runs. The first attempt never
 * waits, and an attempt past the end of the schedule is not one the caller
 * should be making, so it waits not at all rather than for `undefined` ms.
 */
export function getRetryDelayMs(attempt: number, delays: number[] = PART_RETRY_DELAYS_MS): number {
  if (attempt <= 0) return 0;
  return delays[attempt] ?? 0;
}

export type PartByteRange = { start: number; end: number };

/**
 * The slice of the file that a given part carries. Part numbers are 1-based
 * because that is what S3 uses, and the final part is short: it stops at the end
 * of the file rather than at a full part boundary.
 *
 * The part list comes from the server, which sized it from the same file length,
 * so `partNumber` is always within range in practice. A part beyond the end of
 * the file would produce `end` below `start`, which `Blob.slice` reads as an
 * empty range.
 */
export function getPartByteRange(
  partNumber: number,
  partSizeBytes: number,
  totalBytes: number
): PartByteRange {
  const start = (partNumber - 1) * partSizeBytes;
  const end = Math.min(start + partSizeBytes, totalBytes);
  return { start, end };
}

/** Whole-percent progress for a single-request upload. */
export function getUploadProgressPercent(loadedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.round((loadedBytes / totalBytes) * 100);
}

/**
 * Whole-percent progress across a multipart upload, given the bytes reported so
 * far for each part. Clamped at 100: parts report their own progress
 * independently and a re-tried part can briefly double-count.
 *
 * A total of zero reports 0 rather than dividing. The division produced NaN, which
 * reached the UI as "Uploading... NaN%".
 */
export function getMultipartProgressPercent(
  loadedBytesPerPart: number[],
  totalBytes: number
): number {
  if (totalBytes <= 0) return 0;
  const loaded = loadedBytesPerPart.reduce((sum, value) => sum + value, 0);
  return Math.min(100, Math.round((loaded / totalBytes) * 100));
}

/**
 * Whether a failed attempt is worth repeating.
 *
 * The retry loop used to repeat every rejection, including the user's own cancellation
 * and permanently-failing statuses. Cancelling an upload therefore did not cancel it: the
 * part sat through the full 2s, 5s and 10s backoff and fired three more PUTs before the
 * error surfaced. An expired presigned URL behaved the same way, turning one dead part
 * into four requests and 17 seconds of apparent hanging.
 */
export function isRetryableUploadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  if (/aborted/i.test(message)) return false;

  const status = statusFromUploadErrorMessage(message);
  if (status === null) return true; // A network error has no status and is worth a retry.
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
}

/** The status code an upload error message carries, if it carries one. */
export function statusFromUploadErrorMessage(message: string): number | null {
  const match = /failed with status (\d{3})\b/i.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : null;
}

/**
 * Storage often wraps a 413 in HTTP 400. The UI used to show only "status 400",
 * which is what the two oversized MP4s looked like.
 */
export function messageFromDirectUploadFailure(status: number, body: string): string {
  try {
    const payload = JSON.parse(body) as {
      code?: unknown;
      message?: unknown;
      statusCode?: unknown;
    };
    if (payload.code === 'EntityTooLarge' || payload.statusCode === '413') {
      return `Upload failed with status ${status}: This file is larger than the storage upload limit.`;
    }
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return `Upload failed with status ${status}: ${payload.message.trim()}`;
    }
  } catch {
    // The body is not JSON; fall through to the status-only message.
  }
  return `Upload failed with status ${status}`;
}
