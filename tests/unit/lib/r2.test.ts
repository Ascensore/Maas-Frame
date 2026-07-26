// lib/r2.ts is stubbed wholesale in tests/setup/api.ts so the API suite never
// speaks S3. This file stubs the boundary instead: the real S3Client is
// constructed and the real presigner runs, only `send()` is replaced. That way
// the assertions are about the command objects the module builds (bucket, key,
// part number, range, abort path), which is where the bugs would be.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

// lib/r2.ts snapshots every R2_* variable into a module-level const when it is
// evaluated, so these have to be in place before the import below runs.
// vi.hoisted() is the only hook that fires early enough. All dummy values.
vi.hoisted(() => {
  process.env.R2_ENDPOINT = 'http://minio.test:9000';
  process.env.R2_ACCESS_KEY_ID = 'unit-test-access-key';
  process.env.R2_SECRET_ACCESS_KEY = 'unit-test-secret-key';
  process.env.R2_BUCKET_NAME = 'openframe-unit';
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_PRESIGN_ENDPOINT;
  delete process.env.R2_PUBLIC_BASE_URL;
});

import {
  R2_BUCKET_NAME,
  abortMultipartVideoUpload,
  completeMultipartVideoUpload,
  createMultipartVideoUpload,
  createPresignedImagePutUrl,
  createPresignedUploadPartUrl,
  createPresignedVideoPutUrl,
  deleteR2Object,
  deleteVideoObject,
  ensureR2BucketExists,
  ensureR2UploadCors,
  getR2PublicObjectUrl,
  getR2UploadCorsOrigins,
  headVideoObject,
  readVideoObjectBytes,
  uploadAudio,
} from '@/lib/r2';

const BUCKET = 'openframe-unit';
const VIDEO_KEY = 'videos/11111111-2222-4333-8444-555555555555.mp4';

let send: ReturnType<typeof vi.spyOn>;

/** The command object handed to the Nth send() call. */
function commandAt(index: number): { input: Record<string, unknown> } {
  return send.mock.calls[index][0] as { input: Record<string, unknown> };
}

function inputAt(index: number): Record<string, unknown> {
  return commandAt(index).input;
}

/** An AWS SDK error carries its HTTP status under $metadata, not on the Error. */
function s3Error(httpStatusCode: number | undefined): Error {
  const error = new Error('s3 rejected the request');
  if (httpStatusCode !== undefined) {
    Object.assign(error, { $metadata: { httpStatusCode } });
  }
  return error;
}

beforeEach(() => {
  send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('R2_BUCKET_NAME', () => {
  it('re-exports the configured bucket so callers do not read the env twice', () => {
    expect(R2_BUCKET_NAME).toBe(BUCKET);
  });
});

describe('getR2PublicObjectUrl', () => {
  it('serves objects from the endpoint and bucket when no public base url is set', () => {
    expect(getR2PublicObjectUrl('voice/note.webm')).toBe(
      'http://minio.test:9000/openframe-unit/voice/note.webm'
    );
  });

  it('strips leading slashes so the key is never doubled up', () => {
    expect(getR2PublicObjectUrl('///voice/note.webm')).toBe(
      'http://minio.test:9000/openframe-unit/voice/note.webm'
    );
  });

  // The remaining branches read env captured at module load, so they need a
  // fresh module registry rather than a stubEnv on the already-loaded copy.
  async function loadWith(env: Record<string, string | undefined>) {
    vi.resetModules();
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }
    return import('@/lib/r2');
  }

  it('prefers R2_PUBLIC_BASE_URL over the endpoint and trims its trailing slashes', async () => {
    const r2 = await loadWith({ R2_PUBLIC_BASE_URL: 'https://cdn.example.com//' });

    expect(r2.getR2PublicObjectUrl('images/a.png')).toBe('https://cdn.example.com/images/a.png');
  });

  it('builds the Cloudflare virtual-host url when only an account id is configured', async () => {
    const r2 = await loadWith({
      R2_ENDPOINT: undefined,
      R2_PUBLIC_BASE_URL: undefined,
      R2_ACCOUNT_ID: 'acct-123',
    });

    expect(r2.getR2PublicObjectUrl('images/a.png')).toBe(
      'https://openframe-unit.acct-123.r2.cloudflarestorage.com/images/a.png'
    );
  });

  it('throws rather than emitting a half-formed url when nothing is configured', async () => {
    const r2 = await loadWith({
      R2_ENDPOINT: undefined,
      R2_PUBLIC_BASE_URL: undefined,
      R2_ACCOUNT_ID: undefined,
    });

    expect(() => r2.getR2PublicObjectUrl('images/a.png')).toThrow(
      'Missing R2_PUBLIC_BASE_URL or R2_ACCOUNT_ID'
    );
  });
});

describe('ensureR2BucketExists', () => {
  it('stops after the head when the bucket already exists', async () => {
    await ensureR2BucketExists();

    expect(send).toHaveBeenCalledTimes(1);
    expect(commandAt(0)).toBeInstanceOf(HeadBucketCommand);
    expect(inputAt(0)).toEqual({ Bucket: BUCKET });
  });

  it.each([404, 301, 403])('creates the bucket when the head answers %i', async (status) => {
    send.mockRejectedValueOnce(s3Error(status)).mockResolvedValueOnce({} as never);

    await ensureR2BucketExists();

    expect(send).toHaveBeenCalledTimes(2);
    expect(commandAt(1)).toBeInstanceOf(CreateBucketCommand);
    expect(inputAt(1)).toEqual({ Bucket: BUCKET });
  });

  it('rethrows an unexpected head failure instead of trying to create the bucket', async () => {
    send.mockRejectedValueOnce(s3Error(500));

    await expect(ensureR2BucketExists()).rejects.toThrow('s3 rejected the request');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('treats a failure with no http status as a missing bucket', async () => {
    // A DNS or socket failure has no $metadata, so the guard falls through.
    send.mockRejectedValueOnce(s3Error(undefined)).mockResolvedValueOnce({} as never);

    await ensureR2BucketExists();

    expect(commandAt(1)).toBeInstanceOf(CreateBucketCommand);
  });
});

describe('uploadAudio', () => {
  it('writes under the voice prefix and returns the public url', async () => {
    const url = await uploadAudio(Buffer.from('audio'), 'note.webm');

    expect(commandAt(0)).toBeInstanceOf(PutObjectCommand);
    expect(inputAt(0)).toMatchObject({
      Bucket: BUCKET,
      Key: 'voice/note.webm',
      ContentType: 'audio/webm',
    });
    expect(url).toBe('http://minio.test:9000/openframe-unit/voice/note.webm');
  });

  it('keeps only the basename so a traversal cannot escape the voice prefix', async () => {
    await uploadAudio(Buffer.from('audio'), '../../etc/passwd');

    expect(inputAt(0).Key).toBe('voice/passwd');
  });

  it('strips a windows-style path separator too', async () => {
    await uploadAudio(Buffer.from('audio'), 'C:\\Users\\x\\note.webm');

    expect(inputAt(0).Key).toBe('voice/note.webm');
  });

  it('strips a dot run left behind after the basename is taken', async () => {
    await uploadAudio(Buffer.from('audio'), 'a..b.webm');

    expect(inputAt(0).Key).toBe('voice/ab.webm');
  });

  it('rejects a filename that sanitises down to nothing', async () => {
    await expect(uploadAudio(Buffer.from('audio'), 'dir/')).rejects.toThrow('Invalid filename');
    expect(send).not.toHaveBeenCalled();
  });

  it('honours an explicit content type', async () => {
    await uploadAudio(Buffer.from('audio'), 'note.mp3', 'audio/mpeg');

    expect(inputAt(0).ContentType).toBe('audio/mpeg');
  });
});

describe('createPresignedVideoPutUrl', () => {
  it('refuses a key outside the videos prefix', async () => {
    await expect(
      createPresignedVideoPutUrl('images/a.png', 'video/mp4', BigInt(1))
    ).rejects.toThrow('Invalid video object key');
  });

  it('refuses a key that only mentions the prefix further along', async () => {
    await expect(
      createPresignedVideoPutUrl('evil/videos/a.mp4', 'video/mp4', BigInt(1))
    ).rejects.toThrow('Invalid video object key');
  });

  it.each([BigInt(0), BigInt(-1)])('refuses a content length of %s', async (length) => {
    await expect(createPresignedVideoPutUrl(VIDEO_KEY, 'video/mp4', length)).rejects.toThrow(
      'Invalid video content length'
    );
  });

  it('refuses a content length past the safe integer range', async () => {
    await expect(
      createPresignedVideoPutUrl(
        VIDEO_KEY,
        'video/mp4',
        BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)
      )
    ).rejects.toThrow('Invalid video content length');
  });

  it('accepts the largest representable content length', async () => {
    await expect(
      createPresignedVideoPutUrl(VIDEO_KEY, 'video/mp4', BigInt(Number.MAX_SAFE_INTEGER))
    ).resolves.toContain('X-Amz-Signature=');
  });

  it('signs a one hour PUT against the bucket and key by default', async () => {
    const url = new URL(await createPresignedVideoPutUrl(VIDEO_KEY, 'video/mp4', BigInt(1024)));

    // Everything here is deterministic; the signature itself deliberately is not.
    expect(url.origin).toBe('http://minio.test:9000');
    expect(url.pathname).toBe(`/${BUCKET}/${VIDEO_KEY}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('x-id')).toBe('PutObject');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(send).not.toHaveBeenCalled();
  });

  it('honours a caller-supplied expiry window', async () => {
    const url = new URL(
      await createPresignedVideoPutUrl(VIDEO_KEY, 'video/mp4', BigInt(1024), 900)
    );

    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
  });

  it('binds the content length into the signature so the size cannot be swapped', async () => {
    const url = new URL(await createPresignedVideoPutUrl(VIDEO_KEY, 'video/mp4', BigInt(1024)));

    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-length');
  });

  it('produces a different signature for a different key', async () => {
    const a = new URL(await createPresignedVideoPutUrl(VIDEO_KEY, 'video/mp4', BigInt(1024)));
    const b = new URL(
      await createPresignedVideoPutUrl('videos/other.mp4', 'video/mp4', BigInt(1024))
    );

    expect(a.searchParams.get('X-Amz-Signature')).not.toBe(b.searchParams.get('X-Amz-Signature'));
  });
});

describe('createPresignedImagePutUrl', () => {
  it('refuses a key outside the images prefix', async () => {
    await expect(createPresignedImagePutUrl(VIDEO_KEY, 'image/png')).rejects.toThrow(
      'Invalid image object key'
    );
  });

  it('signs a PUT against the bucket and key', async () => {
    const url = new URL(await createPresignedImagePutUrl('images/avatar.png', 'image/png', 120));

    expect(url.origin).toBe('http://minio.test:9000');
    expect(url.pathname).toBe(`/${BUCKET}/images/avatar.png`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(send).not.toHaveBeenCalled();
  });

  it('defaults to a one hour window', async () => {
    const url = new URL(await createPresignedImagePutUrl('images/avatar.png', 'image/png'));

    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  });

  // Documents current behaviour rather than endorsing it: ContentType is passed
  // to the command but the presigner does not sign it, so the grant does not
  // pin the uploaded media type. See the note in the review notes.
  it('does not bind the content type into the signature', async () => {
    const url = new URL(await createPresignedImagePutUrl('images/avatar.png', 'image/png'));

    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
});

describe('createMultipartVideoUpload', () => {
  it('refuses a key outside the videos prefix', async () => {
    await expect(createMultipartVideoUpload('images/a.png', 'video/mp4')).rejects.toThrow(
      'Invalid video object key'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('returns the upload id the service assigned', async () => {
    send.mockResolvedValueOnce({ UploadId: 'upload-abc' } as never);

    await expect(createMultipartVideoUpload(VIDEO_KEY, 'video/mp4')).resolves.toBe('upload-abc');
    expect(commandAt(0)).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(inputAt(0)).toEqual({
      Bucket: BUCKET,
      Key: VIDEO_KEY,
      ContentType: 'video/mp4',
    });
  });

  it('throws when the service answers without an upload id', async () => {
    send.mockResolvedValueOnce({} as never);

    await expect(createMultipartVideoUpload(VIDEO_KEY, 'video/mp4')).rejects.toThrow(
      'Failed to create multipart upload'
    );
  });
});

describe('createPresignedUploadPartUrl', () => {
  it('refuses a key outside the videos prefix', async () => {
    await expect(createPresignedUploadPartUrl('images/a.png', 'upload-1', 1)).rejects.toThrow(
      'Invalid video object key'
    );
  });

  it.each([0, -1, 10001, 1.5, Number.NaN])('refuses part number %s', async (partNumber) => {
    await expect(createPresignedUploadPartUrl(VIDEO_KEY, 'upload-1', partNumber)).rejects.toThrow(
      'Invalid part number'
    );
  });

  it.each([1, 10000])('accepts the boundary part number %i', async (partNumber) => {
    const url = new URL(await createPresignedUploadPartUrl(VIDEO_KEY, 'upload-1', partNumber));

    expect(url.searchParams.get('partNumber')).toBe(String(partNumber));
  });

  it('signs the part number and upload id into the query string', async () => {
    const url = new URL(await createPresignedUploadPartUrl(VIDEO_KEY, 'upload-abc', 7, 600));

    expect(url.origin).toBe('http://minio.test:9000');
    expect(url.pathname).toBe(`/${BUCKET}/${VIDEO_KEY}`);
    expect(url.searchParams.get('partNumber')).toBe('7');
    expect(url.searchParams.get('uploadId')).toBe('upload-abc');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('x-id')).toBe('UploadPart');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('completeMultipartVideoUpload', () => {
  it('refuses a key outside the videos prefix', async () => {
    await expect(
      completeMultipartVideoUpload('images/a.png', 'upload-1', [{ partNumber: 1, etag: 'e1' }])
    ).rejects.toThrow('Invalid video object key');
  });

  it('refuses an empty part list rather than completing an empty object', async () => {
    await expect(completeMultipartVideoUpload(VIDEO_KEY, 'upload-1', [])).rejects.toThrow(
      'No parts provided for multipart completion'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('sorts the parts by number because S3 rejects an out-of-order manifest', async () => {
    await completeMultipartVideoUpload(VIDEO_KEY, 'upload-abc', [
      { partNumber: 3, etag: 'etag-3' },
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' },
    ]);

    expect(commandAt(0)).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(inputAt(0)).toEqual({
      Bucket: BUCKET,
      Key: VIDEO_KEY,
      UploadId: 'upload-abc',
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: 'etag-1' },
          { PartNumber: 2, ETag: 'etag-2' },
          { PartNumber: 3, ETag: 'etag-3' },
        ],
      },
    });
  });

  it('does not reorder the array the caller passed in', async () => {
    const parts = [
      { partNumber: 2, etag: 'etag-2' },
      { partNumber: 1, etag: 'etag-1' },
    ];

    await completeMultipartVideoUpload(VIDEO_KEY, 'upload-abc', parts);

    expect(parts.map((part) => part.partNumber)).toEqual([2, 1]);
  });
});

describe('abortMultipartVideoUpload', () => {
  it('refuses a key outside the videos prefix', async () => {
    await expect(abortMultipartVideoUpload('images/a.png', 'upload-1')).rejects.toThrow(
      'Invalid video object key'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('aborts the named upload on the named key', async () => {
    await abortMultipartVideoUpload(VIDEO_KEY, 'upload-abc');

    expect(commandAt(0)).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(inputAt(0)).toEqual({
      Bucket: BUCKET,
      Key: VIDEO_KEY,
      UploadId: 'upload-abc',
    });
  });

  it('propagates a failed abort so the caller can retry or alarm', async () => {
    send.mockRejectedValueOnce(s3Error(500));

    await expect(abortMultipartVideoUpload(VIDEO_KEY, 'upload-abc')).rejects.toThrow(
      's3 rejected the request'
    );
  });
});

describe('headVideoObject', () => {
  it('returns null for a key outside the videos prefix without touching the network', async () => {
    await expect(headVideoObject('images/a.png')).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('reports the length as a bigint and passes the content type through', async () => {
    send.mockResolvedValueOnce({ ContentLength: 4096, ContentType: 'video/mp4' } as never);

    await expect(headVideoObject(VIDEO_KEY)).resolves.toEqual({
      contentLength: BigInt(4096),
      contentType: 'video/mp4',
    });
    expect(commandAt(0)).toBeInstanceOf(HeadObjectCommand);
    expect(inputAt(0)).toEqual({ Bucket: BUCKET, Key: VIDEO_KEY });
  });

  it('falls back to zero when the service omits the length', async () => {
    send.mockResolvedValueOnce({ ContentType: 'video/mp4' } as never);

    await expect(headVideoObject(VIDEO_KEY)).resolves.toEqual({
      contentLength: BigInt(0),
      contentType: 'video/mp4',
    });
  });

  it('falls back to zero rather than throwing on a negative length', async () => {
    send.mockResolvedValueOnce({ ContentLength: -1 } as never);

    await expect(headVideoObject(VIDEO_KEY)).resolves.toEqual({
      contentLength: BigInt(0),
      contentType: undefined,
    });
  });

  it('returns null for a missing object', async () => {
    send.mockRejectedValueOnce(s3Error(404));

    await expect(headVideoObject(VIDEO_KEY)).resolves.toBeNull();
  });

  it('rethrows any other failure so a broken bucket is not read as an empty one', async () => {
    send.mockRejectedValueOnce(s3Error(403));

    await expect(headVideoObject(VIDEO_KEY)).rejects.toThrow('s3 rejected the request');
  });
});

describe('readVideoObjectBytes', () => {
  function bodyOf(bytes: Uint8Array) {
    return { Body: { transformToByteArray: async () => bytes } };
  }

  it('returns null for a key outside the videos prefix', async () => {
    await expect(readVideoObjectBytes('images/a.png', 16)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([0, -5])('returns null for a byte length of %i', async (byteLength) => {
    await expect(readVideoObjectBytes(VIDEO_KEY, byteLength)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('requests an inclusive range that is one byte shorter than the length asked for', async () => {
    send.mockResolvedValueOnce(bodyOf(new Uint8Array([1, 2, 3, 4])) as never);

    await expect(readVideoObjectBytes(VIDEO_KEY, 4)).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(commandAt(0)).toBeInstanceOf(GetObjectCommand);
    expect(inputAt(0)).toEqual({ Bucket: BUCKET, Key: VIDEO_KEY, Range: 'bytes=0-3' });
  });

  it('asks for a single byte when one byte is requested', async () => {
    send.mockResolvedValueOnce(bodyOf(new Uint8Array([1])) as never);

    await readVideoObjectBytes(VIDEO_KEY, 1);

    expect(inputAt(0).Range).toBe('bytes=0-0');
  });

  it('returns null when the response carries no body', async () => {
    send.mockResolvedValueOnce({} as never);

    await expect(readVideoObjectBytes(VIDEO_KEY, 4)).resolves.toBeNull();
  });

  it('returns null when the body cannot be collected into bytes', async () => {
    send.mockResolvedValueOnce({ Body: {} } as never);

    await expect(readVideoObjectBytes(VIDEO_KEY, 4)).resolves.toBeNull();
  });

  it.each([404, 416])('returns null when the range read answers %i', async (status) => {
    send.mockRejectedValueOnce(s3Error(status));

    await expect(readVideoObjectBytes(VIDEO_KEY, 4)).resolves.toBeNull();
  });

  it('rethrows any other read failure', async () => {
    send.mockRejectedValueOnce(s3Error(500));

    await expect(readVideoObjectBytes(VIDEO_KEY, 4)).rejects.toThrow('s3 rejected the request');
  });
});

describe('deleteVideoObject and deleteR2Object', () => {
  it('deletes a video key', async () => {
    await deleteVideoObject(VIDEO_KEY);

    expect(commandAt(0)).toBeInstanceOf(DeleteObjectCommand);
    expect(inputAt(0)).toEqual({ Bucket: BUCKET, Key: VIDEO_KEY });
  });

  it('refuses an image key through the video-specific entry point', async () => {
    await expect(deleteVideoObject('images/a.png')).rejects.toThrow('Invalid video object key');
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes an image key through the general entry point', async () => {
    await deleteR2Object('images/a.png');

    expect(inputAt(0)).toEqual({ Bucket: BUCKET, Key: 'images/a.png' });
  });

  // The allowlist is the whole safety story for delete: anything that is not a
  // video or an image key must never reach DeleteObject.
  it.each([
    'voice/note.webm',
    '',
    '/videos/a.mp4',
    'other/videos/a.mp4',
    '../videos/a.mp4',
    'videos',
  ])('refuses to delete %s', async (key) => {
    await expect(deleteR2Object(key)).rejects.toThrow('Invalid object key');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('getR2UploadCorsOrigins', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    vi.stubEnv('NODE_ENV', 'test');
  });

  it('reduces each configured url to its origin', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://app.example.com/some/path');

    expect(getR2UploadCorsOrigins()).toEqual(['https://app.example.com']);
  });

  it('deduplicates urls that share an origin', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://app.example.com');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com/');

    expect(getR2UploadCorsOrigins()).toEqual(['https://app.example.com']);
  });

  it('keeps the port, which is what makes a local origin distinct', () => {
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');

    expect(getR2UploadCorsOrigins()).toEqual(['http://localhost:3000']);
  });

  it('appends caller-supplied origins after the configured ones', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://app.example.com');

    expect(getR2UploadCorsOrigins(['https://extra.example.com'])).toEqual([
      'https://app.example.com',
      'https://extra.example.com',
    ]);
  });

  it('skips blank and unparseable entries instead of throwing', () => {
    vi.stubEnv('NEXTAUTH_URL', '   ');

    expect(getR2UploadCorsOrigins(['not a url', ''])).toEqual([]);
  });

  it('adds the loopback development origins only in development', () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(getR2UploadCorsOrigins()).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
  });
});

describe('ensureR2UploadCors', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_URL', 'https://app.example.com');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    vi.stubEnv('NODE_ENV', 'test');
  });

  const managedRule = {
    AllowedOrigins: ['https://app.example.com'],
    AllowedMethods: ['GET', 'PUT', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3600,
  };

  it('refuses to run with no origins rather than opening the bucket to everyone', async () => {
    vi.stubEnv('NEXTAUTH_URL', undefined);

    await expect(ensureR2UploadCors()).rejects.toThrow('No origins configured for R2 upload CORS');
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves an existing rule alone when it already covers the origin', async () => {
    send.mockResolvedValueOnce({
      CORSRules: [{ AllowedOrigins: ['https://app.example.com'], AllowedMethods: ['GET', 'PUT'] }],
    } as never);

    await expect(ensureR2UploadCors()).resolves.toEqual(['https://app.example.com']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(commandAt(0)).toBeInstanceOf(GetBucketCorsCommand);
  });

  it('accepts HEAD in place of GET on the existing rule', async () => {
    send.mockResolvedValueOnce({
      CORSRules: [{ AllowedOrigins: ['https://app.example.com'], AllowedMethods: ['head', 'put'] }],
    } as never);

    await ensureR2UploadCors();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('appends its own rule when the existing rules omit PUT', async () => {
    const existing = { AllowedOrigins: ['https://app.example.com'], AllowedMethods: ['GET'] };
    send.mockResolvedValueOnce({ CORSRules: [existing] } as never);

    await ensureR2UploadCors();

    expect(send).toHaveBeenCalledTimes(2);
    expect(commandAt(1)).toBeInstanceOf(PutBucketCorsCommand);
    expect(inputAt(1)).toEqual({
      Bucket: BUCKET,
      CORSConfiguration: { CORSRules: [existing, managedRule] },
    });
  });

  it('appends its own rule when the existing rules cover a different origin', async () => {
    send.mockResolvedValueOnce({
      CORSRules: [
        { AllowedOrigins: ['https://other.example.com'], AllowedMethods: ['GET', 'PUT'] },
      ],
    } as never);

    await ensureR2UploadCors();

    expect(commandAt(1)).toBeInstanceOf(PutBucketCorsCommand);
  });

  it('writes a fresh configuration when the bucket has no CORS config to read', async () => {
    send.mockRejectedValueOnce(s3Error(404)).mockResolvedValueOnce({} as never);

    await expect(ensureR2UploadCors()).resolves.toEqual(['https://app.example.com']);
    expect(send).toHaveBeenCalledTimes(2);
    expect(inputAt(1)).toEqual({
      Bucket: BUCKET,
      CORSConfiguration: { CORSRules: [managedRule] },
    });
  });

  // The try block wraps the write as well as the read, so a write that fails
  // lands in the same catch as "no config to read" and the retry re-sends only
  // the managed rule. Asserted as-is; see the review notes.
  it('drops the pre-existing rules when the first write fails and the retry succeeds', async () => {
    const existing = { AllowedOrigins: ['https://other.example.com'], AllowedMethods: ['GET'] };
    send
      .mockResolvedValueOnce({ CORSRules: [existing] } as never)
      .mockRejectedValueOnce(s3Error(500))
      .mockResolvedValueOnce({} as never);

    await ensureR2UploadCors();

    expect(send).toHaveBeenCalledTimes(3);
    expect(inputAt(2)).toEqual({
      Bucket: BUCKET,
      CORSConfiguration: { CORSRules: [managedRule] },
    });
  });

  it('includes the extra origins it was handed in the rule it writes', async () => {
    send.mockRejectedValueOnce(s3Error(404)).mockResolvedValueOnce({} as never);

    await ensureR2UploadCors(['https://preview.example.com']);

    expect(
      (inputAt(1).CORSConfiguration as { CORSRules: Array<{ AllowedOrigins: string[] }> })
        .CORSRules[0].AllowedOrigins
    ).toEqual(['https://app.example.com', 'https://preview.example.com']);
  });
});
