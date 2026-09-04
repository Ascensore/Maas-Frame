import { describe, it, expect } from 'vitest';
import {
  getMultipartProgressPercent,
  getPartByteRange,
  getRetryDelayMs,
  getUploadProgressPercent,
  isRetryableUploadError,
  messageFromDirectUploadFailure,
  PART_RETRY_DELAYS_MS,
} from '@/lib/client/upload-chunking';

const MIB = 1024 * 1024;
/** The S3 floor for a non-final part, and the smallest size the host can configure. */
const MIN_PART_SIZE = 5 * MIB;
/** The default `OPENFRAME_R2_MULTIPART_PART_SIZE_BYTES`. */
const DEFAULT_PART_SIZE = 32 * MIB;

/**
 * The part list is built by the r2-init route, which sizes it with a ceiling
 * division over the same file length. Mirroring that here (rather than importing
 * it) keeps these expectations independent of the module under test.
 */
function partNumbers(totalBytes: number, partSizeBytes: number): number[] {
  const count = Math.ceil(totalBytes / partSizeBytes);
  return Array.from({ length: count }, (_unused, index) => index + 1);
}

function rangesFor(totalBytes: number, partSizeBytes: number) {
  return partNumbers(totalBytes, partSizeBytes).map((partNumber) =>
    getPartByteRange(partNumber, partSizeBytes, totalBytes)
  );
}

describe('PART_RETRY_DELAYS_MS', () => {
  it('gives a failing part three retries over at most 17 seconds', () => {
    expect(PART_RETRY_DELAYS_MS).toEqual([0, 2000, 5000, 10000]);
  });
});

describe('getRetryDelayMs', () => {
  it('runs the first attempt immediately', () => {
    expect(getRetryDelayMs(0)).toBe(0);
  });

  it('backs off further on each retry', () => {
    expect(getRetryDelayMs(1)).toBe(2000);
    expect(getRetryDelayMs(2)).toBe(5000);
    expect(getRetryDelayMs(3)).toBe(10000);
  });

  it('reads the delay from a caller-supplied schedule', () => {
    expect(getRetryDelayMs(1, [0, 50])).toBe(50);
    expect(getRetryDelayMs(2, [0, 50, 75])).toBe(75);
  });

  // Guards the `?? 0` fallback: without it the caller would await
  // setTimeout(undefined), which fires immediately and turns a bounded backoff
  // into a hot loop.
  it('waits not at all past the end of the schedule', () => {
    expect(getRetryDelayMs(4)).toBe(0);
    expect(getRetryDelayMs(99)).toBe(0);
    expect(getRetryDelayMs(-1)).toBe(0);
  });
});

describe('getPartByteRange', () => {
  it('gives each part a full, non-overlapping slice', () => {
    expect(getPartByteRange(1, MIN_PART_SIZE, 15 * MIB)).toEqual({ start: 0, end: 5 * MIB });
    expect(getPartByteRange(2, MIN_PART_SIZE, 15 * MIB)).toEqual({
      start: 5 * MIB,
      end: 10 * MIB,
    });
    expect(getPartByteRange(3, MIN_PART_SIZE, 15 * MIB)).toEqual({
      start: 10 * MIB,
      end: 15 * MIB,
    });
  });

  it('splits a file that lands exactly on a part boundary into whole parts', () => {
    const ranges = rangesFor(15 * MIB, MIN_PART_SIZE);

    expect(ranges).toHaveLength(3);
    // No short tail: the last part is as long as the others and stops on the
    // last byte of the file.
    expect(ranges[2].end - ranges[2].start).toBe(MIN_PART_SIZE);
    expect(ranges[2].end).toBe(15 * MIB);
  });

  it('gives one byte over a boundary its own one-byte part', () => {
    const totalBytes = 15 * MIB + 1;
    const ranges = rangesFor(totalBytes, MIN_PART_SIZE);

    expect(ranges).toHaveLength(4);
    expect(ranges[3]).toEqual({ start: 15 * MIB, end: totalBytes });
    expect(ranges[3].end - ranges[3].start).toBe(1);
  });

  it('leaves the remainder to the final part when the file is one byte short', () => {
    const totalBytes = 15 * MIB - 1;
    const ranges = rangesFor(totalBytes, MIN_PART_SIZE);

    expect(ranges).toHaveLength(3);
    expect(ranges[2]).toEqual({ start: 10 * MIB, end: totalBytes });
    expect(ranges[2].end - ranges[2].start).toBe(MIN_PART_SIZE - 1);
  });

  it('covers every byte of the file exactly once, whatever the remainder', () => {
    for (const totalBytes of [
      1,
      MIN_PART_SIZE - 1,
      MIN_PART_SIZE,
      MIN_PART_SIZE + 1,
      3 * MIN_PART_SIZE + 7,
      DEFAULT_PART_SIZE * 4,
      DEFAULT_PART_SIZE * 4 + 12345,
    ]) {
      for (const partSize of [MIN_PART_SIZE, DEFAULT_PART_SIZE]) {
        const ranges = rangesFor(totalBytes, partSize);
        expect(ranges[0].start).toBe(0);
        expect(ranges[ranges.length - 1].end).toBe(totalBytes);
        for (let index = 1; index < ranges.length; index += 1) {
          expect(ranges[index].start).toBe(ranges[index - 1].end);
        }
        const uploaded = ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
        expect(uploaded).toBe(totalBytes);
      }
    }
  });

  it('still lands on the last byte at the 10000-part S3 ceiling', () => {
    // 10000 parts of 5 MiB is the largest upload the smallest allowed part size
    // can express, and the offsets there are past 2^35, so this is where an
    // arithmetic slip would first show up as a truncated or duplicated part.
    const totalBytes = 10000 * MIN_PART_SIZE;
    const last = getPartByteRange(10000, MIN_PART_SIZE, totalBytes);

    expect(last.start).toBe(9999 * MIN_PART_SIZE);
    expect(last.end).toBe(totalBytes);
    expect(Number.isSafeInteger(last.start)).toBe(true);
  });

  it('produces an empty range for a zero-byte file', () => {
    // Unreachable today: r2-init rejects sizeBytes <= 0 before any part is
    // presigned. Pinned because the arithmetic must not produce a negative
    // length if that ever changes.
    expect(getPartByteRange(1, MIN_PART_SIZE, 0)).toEqual({ start: 0, end: 0 });
  });

  it('reports a part past the end of the file as an empty slice, not a negative one', () => {
    // A server that over-counted parts would send part 4 for a 15 MiB file.
    // `end` below `start` is what Blob.slice reads as empty, so the request goes
    // out with no bytes rather than with garbage.
    const range = getPartByteRange(4, MIN_PART_SIZE, 15 * MIB);
    expect(range.start).toBe(15 * MIB);
    expect(range.end).toBe(15 * MIB);
  });
});

describe('getUploadProgressPercent', () => {
  it('reports whole percent through the upload', () => {
    expect(getUploadProgressPercent(0, 200)).toBe(0);
    expect(getUploadProgressPercent(50, 200)).toBe(25);
    expect(getUploadProgressPercent(200, 200)).toBe(100);
  });

  it('rounds to the nearest percent rather than truncating', () => {
    expect(getUploadProgressPercent(7, 1000)).toBe(1);
    expect(getUploadProgressPercent(4, 1000)).toBe(0);
    expect(getUploadProgressPercent(995, 1000)).toBe(100);
  });
});

describe('getMultipartProgressPercent', () => {
  it('adds up the bytes reported by every part', () => {
    expect(getMultipartProgressPercent([0, 0, 0], 300)).toBe(0);
    expect(getMultipartProgressPercent([100, 50, 0], 300)).toBe(50);
    expect(getMultipartProgressPercent([100, 100, 100], 300)).toBe(100);
  });

  it('never reports past 100 when a retried part double-counts', () => {
    // A part that failed halfway and was retried has already reported those
    // bytes once; without the clamp the bar would run past the end of the track.
    expect(getMultipartProgressPercent([100, 100, 150], 300)).toBe(100);
  });

  it('counts progress against the whole file, not the part', () => {
    expect(getMultipartProgressPercent([100, 0, 0], 300)).toBe(33);
  });

  // Dividing by a total of zero produced NaN, which reached the UI as
  // "Uploading... NaN%". Not reachable from the product today (r2-init rejects
  // sizeBytes <= 0 and the multipart path only engages above 90 MiB), so the guard is
  // here to keep an arithmetic accident from becoming a visible one.
  it.each([
    ['zero', 0],
    ['a negative total', -1],
  ])('reports 0 rather than NaN for %s', (_label, totalBytes) => {
    expect(getMultipartProgressPercent([0, 0], totalBytes)).toBe(0);
    expect(getMultipartProgressPercent([50, 50], totalBytes)).toBe(0);
    expect(getUploadProgressPercent(50, totalBytes)).toBe(0);
  });
});

describe('isRetryableUploadError', () => {
  // The retry loop used to repeat every rejection. Cancelling an upload therefore did
  // not cancel it: the part sat through the full 2s, 5s and 10s backoff and fired three
  // more PUTs before the error surfaced.
  it('refuses to retry the user cancelling the upload', () => {
    expect(isRetryableUploadError(new Error('Upload aborted'))).toBe(false);
  });

  // An expired presigned part URL answers 403 every time, so retrying turned one dead
  // part into four requests and 17 seconds of apparent hanging.
  it.each([400, 401, 403, 404, 411, 413])('refuses to retry status %s', (status) => {
    expect(isRetryableUploadError(new Error(`Upload failed with status ${status}`))).toBe(false);
    expect(isRetryableUploadError(new Error(`Chunk upload failed with status ${status}`))).toBe(
      false
    );
  });

  it.each([408, 429, 500, 502, 503, 504])('retries status %s', (status) => {
    expect(isRetryableUploadError(new Error(`Upload failed with status ${status}`))).toBe(true);
  });

  it('retries an error that carries no status at all', () => {
    expect(isRetryableUploadError(new Error('Network error during upload.'))).toBe(true);
    expect(isRetryableUploadError(new Error('Upload response missing ETag header.'))).toBe(true);
  });

  it('retries a non-Error rejection rather than swallowing it', () => {
    expect(isRetryableUploadError('something went wrong')).toBe(true);
  });
});

describe('messageFromDirectUploadFailure', () => {
  it('reads EntityTooLarge out of a 400 that wraps a 413', () => {
    expect(
      messageFromDirectUploadFailure(
        400,
        '{"statusCode":"413","error":"Payload too large","message":"The object exceeded the maximum allowed size","code":"EntityTooLarge"}'
      )
    ).toBe('Upload failed with status 400: This file is larger than the storage upload limit.');
  });

  it('keeps the status-only wording when the body is not JSON', () => {
    expect(messageFromDirectUploadFailure(400, '')).toBe('Upload failed with status 400');
  });
});
