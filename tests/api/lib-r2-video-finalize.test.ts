// Exercises lib/r2-video-finalize.ts, the gate between "the browser says it
// finished uploading" and "a row is written that bills the user for it".
//
// Everything the caller supplies is hostile until proven otherwise: the object
// key, the proxy URL and the upload token all arrive in the request body. The
// module checks them against each other and then against the session row, and
// only then trusts storage. Each of those checks gets a test, because any one
// of them going missing turns the endpoint into "tell me a size and I will
// believe you".
//
// The failure branches matter as much as the happy path: when the object is
// missing, oversized or not a video, the session is cancelled and both objects
// are removed. Leaving an INITIATED session behind would pin the quota
// reservation for its whole TTL.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { deleteR2Object, deleteVideoObject, headVideoObject, readVideoObjectBytes } from '@/lib/r2';
import { createR2UploadToken } from '@/lib/r2-upload-token';
import { createR2UploadSession } from '@/lib/r2-upload-session';
import { finalizeR2VideoUpload } from '@/lib/r2-video-finalize';
import { createUser, seedProject } from '../factories';

/** 12 bytes whose 5th to 8th spell `ftyp`, the ISO base media signature. */
function mp4Header(): Uint8Array {
  const bytes = new Uint8Array(12);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  return bytes;
}

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/** Makes storage report an object of `sizeBytes` whose header is `header`. */
function storageHolds(sizeBytes: number, header: Uint8Array = mp4Header()): void {
  vi.mocked(headVideoObject).mockResolvedValue({
    contentLength: BigInt(sizeBytes),
    contentType: 'video/mp4',
  });
  vi.mocked(readVideoObjectBytes).mockResolvedValue(header);
}

interface SeededUpload {
  userId: string;
  projectId: string;
  sessionId: string;
  objectKey: string;
  thumbnailObjectKey: string;
  proxyUrl: string;
  uploadToken: string;
  reservationId: string | null;
  billedUserId: string;
}

/**
 * An INITIATED session plus the token the r2-init route would have handed back
 * for it, both built through the production helpers rather than by hand.
 */
async function seedUpload(
  overrides: {
    declaredSizeBytes?: bigint;
    expiresAt?: Date;
    thumbnailObjectKey?: string;
    reservationId?: string | null;
    billedUserId?: string;
    userId?: string;
    projectId?: string;
    tokenUserId?: string;
    tokenProjectId?: string;
    objectKey?: string;
  } = {}
): Promise<SeededUpload & { scenarioOwnerId: string }> {
  const scenario = await seedProject();
  const fileId = randomUUID();
  const objectKey = overrides.objectKey ?? `videos/${fileId}.mp4`;
  const thumbnailObjectKey = overrides.thumbnailObjectKey ?? `images/${fileId}.jpg`;
  const uploadJti = randomUUID();
  const userId = overrides.userId ?? scenario.owner.id;
  const projectId = overrides.projectId ?? scenario.project.id;
  const billedUserId = overrides.billedUserId ?? scenario.owner.id;

  const session = await createR2UploadSession({
    userId,
    projectId,
    billedUserId,
    objectKey,
    thumbnailObjectKey,
    declaredSizeBytes: overrides.declaredSizeBytes ?? BigInt(4096),
    contentType: 'video/mp4',
    reservationId: overrides.reservationId ?? null,
    uploadJti,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
  });

  const uploadToken = createR2UploadToken({
    userId: overrides.tokenUserId ?? userId,
    projectId: overrides.tokenProjectId ?? projectId,
    objectKey,
    sessionId: session.id,
    tokenId: uploadJti,
    thumbnailObjectKey,
  });

  return {
    userId,
    projectId,
    sessionId: session.id,
    objectKey,
    thumbnailObjectKey,
    proxyUrl: `/api/upload/video/${fileId}.mp4`,
    uploadToken,
    reservationId: session.reservationId,
    billedUserId,
    scenarioOwnerId: scenario.owner.id,
  };
}

function finalize(
  upload: SeededUpload,
  overrides: Partial<Parameters<typeof finalizeR2VideoUpload>[0]> = {}
) {
  return finalizeR2VideoUpload({
    userId: upload.userId,
    projectId: upload.projectId,
    videoUrl: upload.proxyUrl,
    objectKey: upload.objectKey,
    uploadToken: upload.uploadToken,
    ...overrides,
  });
}

beforeEach(() => {
  // tests/setup/api.ts already stubs both with the production shapes, but this
  // suite is the one that varies them per test, so it sets its own baseline
  // rather than depending on the shared default staying at 1024 bytes.
  storageHolds(1024);
  vi.mocked(deleteVideoObject).mockClear();
  vi.mocked(deleteR2Object).mockClear();
});

describe('finalizeR2VideoUpload request shape', () => {
  it('rejects a missing objectKey', async () => {
    const upload = await seedUpload();

    const result = await finalize(upload, { objectKey: '' });

    expect(result).toEqual({
      ok: false,
      error: 'R2 uploads must include objectKey and uploadToken',
      status: 400,
    });
  });

  it('rejects a missing uploadToken', async () => {
    const upload = await seedUpload();

    const result = await finalize(upload, { uploadToken: '' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(400);
  });

  it('rejects an object key outside the videos prefix', async () => {
    const upload = await seedUpload();

    const result = await finalize(upload, { objectKey: 'images/not-a-video.jpg' });

    expect(result).toEqual({ ok: false, error: 'Invalid object key', status: 400 });
  });

  it('rejects an object key whose basename is not a uuid', async () => {
    const upload = await seedUpload();

    const result = await finalize(upload, { objectKey: 'videos/../../etc/passwd' });

    expect(result).toEqual({ ok: false, error: 'Invalid object key', status: 400 });
  });

  // The proxy URL is what gets written into VideoVersion.originalUrl, so it has
  // to name the same object the token authorises. Otherwise a caller could
  // upload to their own key and point the row at somebody else's file.
  it('rejects a video URL that does not match the object key', async () => {
    const upload = await seedUpload();

    const result = await finalize(upload, {
      videoUrl: '/api/upload/video/99999999-9999-4999-8999-999999999999.mp4',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Video URL does not match the uploaded object',
      status: 400,
    });
  });

  it('rejects a video URL that is not a proxy path at all', async () => {
    const upload = await seedUpload();

    const result = await finalize(upload, { videoUrl: 'https://cdn.evil.test/clip.mp4' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(400);
  });
});

describe('finalizeR2VideoUpload token verification', () => {
  it('rejects a token that is not even parseable', async () => {
    const upload = await seedUpload();

    const result = await finalize(upload, { uploadToken: 'forged.token' });

    expect(result).toEqual({ ok: false, error: 'Invalid upload token', status: 403 });
  });

  it('rejects a token whose signature has been tampered with', async () => {
    const upload = await seedUpload();
    const [payload] = upload.uploadToken.split('.');

    const result = await finalize(upload, { uploadToken: `${payload}.notthesignature` });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(403);
  });

  // A validly signed token issued to somebody else. The signature checks out,
  // so only the subject comparison stands between the two accounts.
  it('rejects a well-formed token issued to a different user', async () => {
    const upload = await seedUpload({ tokenUserId: 'someone-else-entirely' });

    const result = await finalize(upload);

    expect(result).toEqual({ ok: false, error: 'Invalid upload token', status: 403 });
  });

  it('rejects a well-formed token issued for a different project', async () => {
    const upload = await seedUpload({ tokenProjectId: 'some-other-project' });

    const result = await finalize(upload);

    expect(result).toEqual({ ok: false, error: 'Invalid upload token', status: 403 });
  });

  it('rejects a valid token presented by a different caller', async () => {
    const upload = await seedUpload();
    const impostor = await createUser();

    const result = await finalize(upload, { userId: impostor.id });

    expect(result).toEqual({ ok: false, error: 'Invalid upload token', status: 403 });
  });
});

describe('finalizeR2VideoUpload session lookup', () => {
  it('rejects a session that has already been cancelled', async () => {
    const upload = await seedUpload();
    await db.videoUploadSession.update({
      where: { id: upload.sessionId },
      data: { status: 'CANCELLED' },
    });

    const result = await finalize(upload);

    expect(result).toEqual({ ok: false, error: 'Invalid upload token', status: 403 });
  });

  // Replay protection: a session that already produced a video row must not
  // produce a second one from the same token.
  it('rejects a session that has already been finalized', async () => {
    const upload = await seedUpload();
    await db.videoUploadSession.update({
      where: { id: upload.sessionId },
      data: { status: 'FINALIZED' },
    });

    const result = await finalize(upload);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(403);
  });

  it('rejects a session whose expiry has passed', async () => {
    const upload = await seedUpload({ expiresAt: new Date(Date.now() - 60 * 1000) });

    const result = await finalize(upload);

    expect(result).toEqual({ ok: false, error: 'Invalid upload token', status: 403 });
  });

  // The thumbnail key is carried in the token and re-read off the session row.
  // A key outside images/ would make the derived proxy URL point nowhere, and
  // the module refuses rather than emitting a half-formed URL.
  it('rejects a session whose thumbnail key is not under the images prefix', async () => {
    const upload = await seedUpload({ thumbnailObjectKey: 'thumbs/elsewhere.jpg' });

    const result = await finalize(upload);

    expect(result).toEqual({ ok: false, error: 'Invalid upload token', status: 403 });
  });
});

describe('finalizeR2VideoUpload storage checks', () => {
  /** Reads the session row back after a call that should have cancelled it. */
  async function sessionOf(sessionId: string) {
    return db.videoUploadSession.findUniqueOrThrow({ where: { id: sessionId } });
  }

  it('cancels the session and removes both objects when storage has no object', async () => {
    const upload = await seedUpload();
    vi.mocked(headVideoObject).mockResolvedValue(null);

    const result = await finalize(upload);

    expect(result).toEqual({
      ok: false,
      error: 'Uploaded video was not found in storage',
      status: 400,
    });
    const session = await sessionOf(upload.sessionId);
    expect(session.status).toBe('CANCELLED');
    expect(session.consumedAt).toBeInstanceOf(Date);
    expect(vi.mocked(deleteVideoObject)).toHaveBeenCalledWith(upload.objectKey);
    expect(vi.mocked(deleteR2Object)).toHaveBeenCalledWith(upload.thumbnailObjectKey);
  });

  it('refuses an object key outside the videos/ prefix without asking storage', async () => {
    // Two things at once, and the second is the reason the stubs are reset.
    //
    // The claim is that finalize refuses a key it has no business finalising
    // *before* it reaches out to storage, so the refusal cannot depend on what
    // the bucket happens to answer. Proving "before" means the storage stubs
    // must not be able to rescue it: this file's beforeEach calls
    // storageHolds(), which mockResolvedValues both functions for any key, so
    // mockReset() puts back the prefix-aware implementations from
    // tests/setup/api.ts (mockReset restores the implementation vi.fn() was
    // created with). Neither is called at all, which is the point.
    vi.mocked(headVideoObject).mockReset();
    vi.mocked(readVideoObjectBytes).mockReset();
    const upload = await seedUpload({ objectKey: `images/${randomUUID()}.mp4` });

    const result = await finalize(upload);

    expect(result).toEqual({ ok: false, error: 'Invalid object key', status: 400 });
    expect(vi.mocked(headVideoObject)).not.toHaveBeenCalled();
    expect(vi.mocked(readVideoObjectBytes)).not.toHaveBeenCalled();
    // Refused, not cancelled: nothing was uploaded under a key this session
    // could own, so there is nothing to clean up and the session is left alone.
    expect((await sessionOf(upload.sessionId)).status).toBe('INITIATED');
  });

  it('cancels when storage reports a zero-byte object', async () => {
    const upload = await seedUpload();
    vi.mocked(headVideoObject).mockResolvedValue({
      contentLength: BigInt(0),
      contentType: 'video/mp4',
    });

    const result = await finalize(upload);

    expect(result.ok === false && result.error).toBe('Uploaded video was not found in storage');
    expect((await sessionOf(upload.sessionId)).status).toBe('CANCELLED');
  });

  it('cancels when the stored object is over the configured maximum', async () => {
    vi.stubEnv('OPENFRAME_MAX_VIDEO_UPLOAD_BYTES', '2048');
    const upload = await seedUpload({ declaredSizeBytes: BigInt(1_000_000) });
    storageHolds(4096);

    const result = await finalize(upload);

    expect(result).toEqual({
      ok: false,
      error: 'Uploaded video exceeds the maximum allowed upload size',
      status: 400,
    });
    expect((await sessionOf(upload.sessionId)).status).toBe('CANCELLED');
  });

  // The declared size is what the quota reservation was sized against. An
  // object bigger than that has been billed for less than it costs.
  it('cancels when the stored object is larger than the declared size', async () => {
    const upload = await seedUpload({ declaredSizeBytes: BigInt(1024) });
    storageHolds(1025);

    const result = await finalize(upload);

    expect(result).toEqual({
      ok: false,
      error: 'Uploaded video size does not match upload request',
      status: 400,
    });
    expect((await sessionOf(upload.sessionId)).status).toBe('CANCELLED');
  });

  it('accepts an object exactly the declared size', async () => {
    const upload = await seedUpload({ declaredSizeBytes: BigInt(1024) });
    storageHolds(1024);

    const result = await finalize(upload);

    expect(result.ok).toBe(true);
  });

  it('accepts an object smaller than declared, because compression is allowed to win', async () => {
    const upload = await seedUpload({ declaredSizeBytes: BigInt(4096) });
    storageHolds(10);

    const result = await finalize(upload);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.sizeBytes).toBe(BigInt(10));
  });

  it('cancels when the header bytes cannot be read at all', async () => {
    const upload = await seedUpload();
    vi.mocked(readVideoObjectBytes).mockResolvedValue(null);

    const result = await finalize(upload);

    expect(result).toEqual({
      ok: false,
      error: 'Uploaded file is not a valid video',
      status: 400,
    });
    expect((await sessionOf(upload.sessionId)).status).toBe('CANCELLED');
  });

  // Content-type is caller-controlled, so the first 64 bytes are the only thing
  // that decides whether this is really a video. A renamed .exe stops here.
  it('cancels when the header bytes are not a known container', async () => {
    const upload = await seedUpload();
    storageHolds(1024, bytesOf(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0, 0, 0, 0));

    const result = await finalize(upload);

    expect(result.ok === false && result.error).toBe('Uploaded file is not a valid video');
    expect(vi.mocked(deleteVideoObject)).toHaveBeenCalledWith(upload.objectKey);
  });

  it('cancels when the object is too short to carry a signature', async () => {
    const upload = await seedUpload();
    storageHolds(1024, bytesOf(0x66, 0x74, 0x79));

    const result = await finalize(upload);

    expect(result.ok === false && result.error).toBe('Uploaded file is not a valid video');
  });

  it.each([
    ['an mp4 ftyp box', mp4Header()],
    ['a matroska EBML header', bytesOf(0x1a, 0x45, 0xdf, 0xa3)],
    ['an Ogg page header', bytesOf(0x4f, 0x67, 0x67, 0x53)],
    ['a RIFF AVI header', bytesOf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20)],
  ])('accepts %s', async (_label, header) => {
    const upload = await seedUpload();
    storageHolds(1024, header);

    expect((await finalize(upload)).ok).toBe(true);
  });

  // A RIFF container that is not AVI (a .wav, say) has the same first four
  // bytes and must not slip through on the prefix alone.
  it('cancels a RIFF container that is not AVI', async () => {
    const upload = await seedUpload();
    storageHolds(1024, bytesOf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45));

    expect((await finalize(upload)).ok).toBe(false);
  });
});

describe('finalizeR2VideoUpload success', () => {
  it('returns the proxy URLs, the session and the billing subject', async () => {
    const billed = await createUser();
    const upload = await seedUpload({ declaredSizeBytes: BigInt(8192), billedUserId: billed.id });
    storageHolds(7000);

    const result = await finalize(upload);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sizeBytes).toBe(BigInt(7000));
    expect(result.objectKey).toBe(upload.objectKey);
    expect(result.proxyUrl).toBe(upload.proxyUrl);
    expect(result.sessionId).toBe(upload.sessionId);
    expect(result.reservationId).toBeNull();
    expect(result.billedUserId).toBe(billed.id);
    expect(result.thumbnailObjectKey).toBe(upload.thumbnailObjectKey);
    expect(result.thumbnailProxyUrl).toBe(
      `/api/upload/image/${upload.thumbnailObjectKey.slice('images/'.length)}`
    );
  });

  // Finalisation validates; it does not consume. The caller writes the row and
  // then marks the session FINALIZED, so a success here must leave the session
  // exactly as it found it.
  it('leaves the session INITIATED and deletes nothing', async () => {
    const upload = await seedUpload();

    const result = await finalize(upload);

    expect(result.ok).toBe(true);
    const session = await db.videoUploadSession.findUniqueOrThrow({
      where: { id: upload.sessionId },
    });
    expect(session.status).toBe('INITIATED');
    expect(session.consumedAt).toBeNull();
    expect(vi.mocked(deleteVideoObject)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteR2Object)).not.toHaveBeenCalled();
  });

  it('carries the reservation id through so the caller can release it', async () => {
    const scenario = await seedProject();
    const reservation = await db.uploadReservation.create({
      data: {
        billedUserId: scenario.owner.id,
        sizeBytes: BigInt(4096),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    const fileId = randomUUID();
    const objectKey = `videos/${fileId}.mp4`;
    const thumbnailObjectKey = `images/${fileId}.jpg`;
    const uploadJti = randomUUID();
    const session = await createR2UploadSession({
      userId: scenario.owner.id,
      projectId: scenario.project.id,
      billedUserId: scenario.owner.id,
      objectKey,
      thumbnailObjectKey,
      declaredSizeBytes: BigInt(4096),
      contentType: 'video/mp4',
      reservationId: reservation.id,
      uploadJti,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await finalizeR2VideoUpload({
      userId: scenario.owner.id,
      projectId: scenario.project.id,
      videoUrl: `/api/upload/video/${fileId}.mp4`,
      objectKey,
      uploadToken: createR2UploadToken({
        userId: scenario.owner.id,
        projectId: scenario.project.id,
        objectKey,
        sessionId: session.id,
        tokenId: uploadJti,
        thumbnailObjectKey,
      }),
    });

    expect(result.ok === true && result.reservationId).toBe(reservation.id);
  });
});
