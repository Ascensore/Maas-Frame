// Unit tests for lib/r2-media-proxy.ts, the single helper behind every media
// proxy route (`/api/upload/image/[filename]`, `/api/upload/audio/[filename]`,
// `/api/upload/video/[filename]`).
//
// The routes decide *who* may read an object; this module decides *what* comes
// back. Everything interesting it does is invisible from the route tests, which
// stub this function out at its boundary: the Range and If-Range plumbing, the
// content-type fallback, the 404/416/500 mapping of S3 errors, and the header
// set. All of it is exercised here against a fake `r2Client`, so no test in this
// file speaks S3.
//
// The seam is `@/lib/r2`. Mocking it rather than the AWS SDK keeps the real
// GetObjectCommand in play, which is what lets the assertions below read the
// exact command input the module built.

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetObjectCommand } from '@aws-sdk/client-s3';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@/lib/r2', () => ({
  r2Client: { send: sendMock },
  R2_BUCKET_NAME: 'test-bucket',
  getObjectStorageBucketName: () => 'test-bucket',
}));

vi.mock('@/lib/feature-flags', () => ({
  isUsingSupabaseObjectStorage: () => false,
}));

import { proxyR2MediaObject } from '@/lib/r2-media-proxy';

/** A stored media key as the routes build one: a prefix plus a uuid file name. */
const SAFE_KEY = 'images/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1.png';

const BASE_OPTIONS = {
  key: SAFE_KEY,
  fallbackContentType: 'image/png',
  cacheControl: 'private, no-store',
  internalErrorMessage: 'Failed to retrieve image',
};

/** A GetObjectCommandOutput carrying `text` as a Node stream, the shape the SDK returns. */
function objectWith(overrides: Record<string, unknown> = {}, text = 'file-bytes') {
  return {
    Body: Readable.from([Buffer.from(text)]),
    ContentType: 'image/png',
    ContentLength: text.length,
    ...overrides,
  };
}

/** An error shaped like the ones @aws-sdk/client-s3 throws. */
function s3Error(props: { name?: string; Code?: string; httpStatusCode?: number }): Error {
  const error = new Error('s3 failure');
  if (props.name) error.name = props.name;
  return Object.assign(error, {
    Code: props.Code,
    $metadata: { httpStatusCode: props.httpStatusCode },
  });
}

/** The input of the nth GetObjectCommand handed to r2Client.send(). */
function commandInput(call = 0): Record<string, unknown> {
  const command = sendMock.mock.calls[call]?.[0] as GetObjectCommand;
  return command.input as unknown as Record<string, unknown>;
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/upload/image/photo.png', { headers });
}

beforeEach(() => {
  sendMock.mockReset();
  // logError() writes to console.error on the failure paths. Silenced so the
  // expected-error tests do not print, and so the last case can assert on it.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The object key
// ---------------------------------------------------------------------------
describe('key handling', () => {
  it('sends the caller-supplied key and the configured bucket verbatim', async () => {
    sendMock.mockResolvedValue(objectWith());

    await proxyR2MediaObject({ ...BASE_OPTIONS, request: request() });

    expect(commandInput()).toMatchObject({ Bucket: 'test-bucket', Key: SAFE_KEY });
  });

  // The guard lives here rather than in each caller, so it travels with the function. All
  // three call sites gate the file name on a uuid pattern first; a fourth that forgot
  // would otherwise hand the traversal straight to GetObject.
  it.each([
    ['a traversal segment', 'images/../../etc/passwd'],
    ['a nested path', 'images/nested/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1.png'],
    ['a non-uuid basename', 'images/photo.png'],
    ['an unknown prefix', 'secrets/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1.png'],
    ['no prefix at all', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1.png'],
    ['a trailing segment', 'images/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1.png/../x'],
    ['an empty key', ''],
  ])('refuses %s with a 400 and never reaches storage', async (_label, key) => {
    const response = await proxyR2MediaObject({ ...BASE_OPTIONS, key, request: request() });

    expect(response.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it.each([
    ['images/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1.png'],
    ['voice/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2.webm'],
    ['videos/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3.mp4'],
  ])('accepts the stored key shape %s', async (key) => {
    sendMock.mockResolvedValue(objectWith());

    await proxyR2MediaObject({ ...BASE_OPTIONS, key, request: request() });

    expect(commandInput().Key).toBe(key);
  });

  it('sends no Range or conditional fields when the request has no range header', async () => {
    sendMock.mockResolvedValue(objectWith());

    await proxyR2MediaObject({ ...BASE_OPTIONS, request: request() });

    const input = commandInput();
    expect(input.Range).toBeUndefined();
    expect(input.IfMatch).toBeUndefined();
    expect(input.IfUnmodifiedSince).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The success response
// ---------------------------------------------------------------------------
describe('a successful read', () => {
  it('returns 200 with the object bytes', async () => {
    sendMock.mockResolvedValue(objectWith({}, 'hello-media'));

    const response = await proxyR2MediaObject({ ...BASE_OPTIONS, request: request() });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('hello-media');
  });

  it('prefers the content type R2 reports over the fallback', async () => {
    sendMock.mockResolvedValue(objectWith({ ContentType: 'image/webp' }));

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      fallbackContentType: 'image/png',
      request: request(),
    });

    expect(response.headers.get('content-type')).toBe('image/webp');
  });

  // R2 stores objects uploaded without an explicit type as
  // application/octet-stream. Serving that back would make the browser download
  // the file instead of rendering it, so the route's extension-derived guess wins.
  it('falls back to the caller content type when R2 reports application/octet-stream', async () => {
    sendMock.mockResolvedValue(objectWith({ ContentType: 'application/octet-stream' }));

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      fallbackContentType: 'audio/webm',
      request: request(),
    });

    expect(response.headers.get('content-type')).toBe('audio/webm');
  });

  it('falls back to the caller content type when R2 reports none at all', async () => {
    sendMock.mockResolvedValue(objectWith({ ContentType: undefined }));

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      fallbackContentType: 'video/mp4',
      request: request(),
    });

    expect(response.headers.get('content-type')).toBe('video/mp4');
  });

  it('passes through length, etag and last-modified from the object', async () => {
    sendMock.mockResolvedValue(
      objectWith({
        ContentLength: 9,
        ETag: '"abc123"',
        LastModified: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
      })
    );

    const response = await proxyR2MediaObject({ ...BASE_OPTIONS, request: request() });

    expect(response.headers.get('content-length')).toBe('9');
    expect(response.headers.get('etag')).toBe('"abc123"');
    expect(response.headers.get('last-modified')).toBe('Fri, 02 Jan 2026 03:04:05 GMT');
  });

  it('omits headers R2 did not report rather than sending empty ones', async () => {
    sendMock.mockResolvedValue(
      objectWith({ ContentLength: undefined, ETag: undefined, LastModified: undefined })
    );

    const response = await proxyR2MediaObject({ ...BASE_OPTIONS, request: request() });

    expect(response.headers.has('etag')).toBe(false);
    expect(response.headers.has('last-modified')).toBe(false);
  });

  // nosniff and `inline` are what keep a stored .png that is really HTML from
  // being rendered as a document in the user's origin.
  it('always sets nosniff, inline disposition and the caller cache policy', async () => {
    sendMock.mockResolvedValue(objectWith());

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      cacheControl: 'private, max-age=3600',
      request: request(),
    });

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
  });

  it('applies extraHeaders on top, overriding what the module set', async () => {
    sendMock.mockResolvedValue(objectWith());

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      extraHeaders: {
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': 'attachment',
      },
      request: request(),
    });

    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('content-disposition')).toBe('attachment');
  });

  it('accepts a web ReadableStream body as well as a Node stream', async () => {
    sendMock.mockResolvedValue({
      ContentType: 'image/png',
      Body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('web-stream-bytes'));
          controller.close();
        },
      }),
    });

    const response = await proxyR2MediaObject({ ...BASE_OPTIONS, request: request() });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('web-stream-bytes');
  });

  it('returns 500 when the object came back with no body to stream', async () => {
    sendMock.mockResolvedValue({ ContentType: 'image/png', Body: undefined });

    const response = await proxyR2MediaObject({ ...BASE_OPTIONS, request: request() });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: 'Empty file' });
  });
});

// ---------------------------------------------------------------------------
// Range requests
// ---------------------------------------------------------------------------
// Video scrubbing depends entirely on this path: the browser asks for a byte
// window and expects 206 plus a Content-Range back. A regression that dropped
// the range and answered 200 with the whole file would still "work" in a
// download and break seeking.
describe('range requests', () => {
  it('forwards the range header and answers 206 when R2 returns a partial object', async () => {
    sendMock.mockResolvedValue(
      objectWith({ ContentRange: 'bytes 0-4/100', ContentLength: 5 }, 'first')
    );

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      request: request({ range: 'bytes=0-4' }),
    });

    expect(commandInput().Range).toBe('bytes=0-4');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-4/100');
    await expect(response.text()).resolves.toBe('first');
  });

  it('answers 200 when a range was asked for but R2 returned the whole object', async () => {
    sendMock.mockResolvedValue(objectWith({ ContentRange: undefined }));

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      request: request({ range: 'bytes=0-' }),
    });

    expect(response.status).toBe(200);
  });

  it('turns an unsatisfiable range into an empty 416', async () => {
    sendMock.mockRejectedValue(s3Error({ name: 'InvalidRange' }));

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      cacheControl: 'private, max-age=3600',
      request: request({ range: 'bytes=99999-' }),
    });

    expect(response.status).toBe(416);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600');
    await expect(response.text()).resolves.toBe('');
  });

  it('recognises an unsatisfiable range reported only as HTTP 416', async () => {
    sendMock.mockRejectedValue(s3Error({ httpStatusCode: 416 }));

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      request: request({ range: 'bytes=99999-' }),
    });

    expect(response.status).toBe(416);
  });
});

// ---------------------------------------------------------------------------
// If-Range
// ---------------------------------------------------------------------------
// If-Range asks "give me this window, but only if the file has not changed since
// I started". S3 has no If-Range, so the module translates it into IfMatch or
// IfUnmodifiedSince and handles the 412 itself.
describe('if-range handling', () => {
  it('translates a strong etag into IfMatch', async () => {
    sendMock.mockResolvedValue(objectWith({ ContentRange: 'bytes 0-4/100' }));

    await proxyR2MediaObject({
      ...BASE_OPTIONS,
      request: request({ range: 'bytes=0-4', 'if-range': '"abc123"' }),
    });

    expect(commandInput().IfMatch).toBe('"abc123"');
    expect(commandInput().IfUnmodifiedSince).toBeUndefined();
  });

  it('translates an HTTP date into IfUnmodifiedSince', async () => {
    sendMock.mockResolvedValue(objectWith({ ContentRange: 'bytes 0-4/100' }));

    await proxyR2MediaObject({
      ...BASE_OPTIONS,
      request: request({ range: 'bytes=0-4', 'if-range': 'Fri, 02 Jan 2026 03:04:05 GMT' }),
    });

    expect(commandInput().IfMatch).toBeUndefined();
    expect((commandInput().IfUnmodifiedSince as Date).toUTCString()).toBe(
      'Fri, 02 Jan 2026 03:04:05 GMT'
    );
  });

  // A weak validator (W/"...") cannot be used for byte-range equivalence, and
  // the token is not a date either, so neither condition is attachable.
  it('ignores a weak etag rather than sending it as IfMatch', async () => {
    sendMock.mockResolvedValue(objectWith({ ContentRange: 'bytes 0-4/100' }));

    await proxyR2MediaObject({
      ...BASE_OPTIONS,
      request: request({ range: 'bytes=0-4', 'if-range': 'W/"abc123"' }),
    });

    expect(commandInput().IfMatch).toBeUndefined();
    expect(commandInput().IfUnmodifiedSince).toBeUndefined();
    expect(commandInput().Range).toBe('bytes=0-4');
  });

  it('ignores if-range entirely when the request carries no range', async () => {
    sendMock.mockResolvedValue(objectWith());

    await proxyR2MediaObject({ ...BASE_OPTIONS, request: request({ 'if-range': '"abc123"' }) });

    expect(commandInput().IfMatch).toBeUndefined();
  });

  // The whole point of If-Range: when the validator no longer matches, the client
  // wants the full object back, not an error. S3 answers 412; the module retries
  // without the range and returns 200.
  it('retries without the range and returns the full object on a 412', async () => {
    sendMock
      .mockRejectedValueOnce(s3Error({ httpStatusCode: 412 }))
      .mockResolvedValueOnce(objectWith({ ContentRange: undefined }, 'whole-file'));

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      request: request({ range: 'bytes=0-4', 'if-range': '"stale-etag"' }),
    });

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(commandInput(1).Range).toBeUndefined();
    expect(commandInput(1).IfMatch).toBeUndefined();
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('whole-file');
  });

  // Without a conditional attached there is nothing to fall back to, so a 412
  // is just an error like any other.
  it('does not retry a 412 that arrived without an if-range', async () => {
    sendMock.mockRejectedValue(s3Error({ httpStatusCode: 412 }));

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      request: request({ range: 'bytes=0-4' }),
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(500);
  });

  it('reports the object as gone when the retry after a 412 finds nothing', async () => {
    sendMock
      .mockRejectedValueOnce(s3Error({ httpStatusCode: 412 }))
      .mockRejectedValueOnce(s3Error({ name: 'NoSuchKey' }));

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      notFoundLabel: 'Audio',
      request: request({ range: 'bytes=0-4', 'if-range': '"stale-etag"' }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'Audio not found' });
  });
});

// ---------------------------------------------------------------------------
// Missing objects and failures
// ---------------------------------------------------------------------------
describe('a missing object', () => {
  it('returns 404 labelled with the caller resource name', async () => {
    sendMock.mockRejectedValue(s3Error({ name: 'NoSuchKey' }));

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      notFoundLabel: 'Image',
      request: request(),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'Image not found' });
  });

  it('defaults the label to File when the caller gave none', async () => {
    sendMock.mockRejectedValue(s3Error({ name: 'NoSuchKey' }));

    const response = await proxyR2MediaObject({ ...BASE_OPTIONS, request: request() });

    await expect(response.json()).resolves.toMatchObject({ error: 'File not found' });
  });

  // Some S3-compatible backends report the condition as a `Code` field or as a
  // bare 404 rather than through the error name.
  it('recognises NoSuchKey reported as a Code field', async () => {
    sendMock.mockRejectedValue(s3Error({ Code: 'NoSuchKey' }));

    const response = await proxyR2MediaObject({ ...BASE_OPTIONS, request: request() });

    expect(response.status).toBe(404);
  });

  it('recognises a missing object reported only as HTTP 404', async () => {
    sendMock.mockRejectedValue(s3Error({ httpStatusCode: 404 }));

    const response = await proxyR2MediaObject({ ...BASE_OPTIONS, request: request() });

    expect(response.status).toBe(404);
  });
});

describe('an unexpected storage failure', () => {
  it('returns 500 with the caller message and never the underlying error', async () => {
    sendMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:9000'));

    const response = await proxyR2MediaObject({
      ...BASE_OPTIONS,
      internalErrorMessage: 'Failed to load video',
      request: request(),
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Failed to load video');
    expect(body.error).not.toContain('ECONNREFUSED');
  });

  it('logs the failure through logError so it reaches the sanitising sink', async () => {
    sendMock.mockRejectedValue(new Error('bucket exploded'));

    await proxyR2MediaObject({ ...BASE_OPTIONS, request: request() });

    expect(console.error).toHaveBeenCalledWith('Error proxying R2 object:', {
      type: 'Error',
      message: 'bucket exploded',
    });
  });
});
