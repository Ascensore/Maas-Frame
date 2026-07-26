// Exercises lib/r2-upload-session.ts, the bookkeeping either side of a direct
// upload.
//
// Small module, but the `where` clause on the cancel is load-bearing in two
// directions: it must not let a caller cancel a session that is not theirs to
// cancel, and it must actually match the session they do own, because the
// r2-init DELETE route releases the quota reservation only when the update
// reports a row. A cancel that quietly matches nothing leaves the reservation
// pinned for its whole TTL.

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { cancelR2UploadSession, createR2UploadSession } from '@/lib/r2-upload-session';
import { seedProject } from '../factories';

const HOUR_MS = 60 * 60 * 1000;

async function newSession(
  overrides: { expiresAt?: Date; multipartUploadId?: string | null; reservationId?: string } = {}
) {
  const scenario = await seedProject();
  const fileId = randomUUID();
  const session = await createR2UploadSession({
    userId: scenario.owner.id,
    projectId: scenario.project.id,
    billedUserId: scenario.owner.id,
    objectKey: `videos/${fileId}.mp4`,
    thumbnailObjectKey: `images/${fileId}.jpg`,
    declaredSizeBytes: BigInt(4096),
    contentType: 'video/mp4',
    reservationId: overrides.reservationId ?? null,
    uploadJti: randomUUID(),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + HOUR_MS),
    ...(overrides.multipartUploadId === undefined
      ? {}
      : { multipartUploadId: overrides.multipartUploadId }),
  });
  return { scenario, session, fileId };
}

describe('createR2UploadSession', () => {
  it('writes an INITIATED row carrying every field the finalizer reads back', async () => {
    const scenario = await seedProject();
    const fileId = randomUUID();
    const uploadJti = randomUUID();
    const expiresAt = new Date(Date.now() + HOUR_MS);

    const created = await createR2UploadSession({
      userId: scenario.owner.id,
      projectId: scenario.project.id,
      billedUserId: scenario.owner.id,
      objectKey: `videos/${fileId}.mp4`,
      thumbnailObjectKey: `images/${fileId}.jpg`,
      declaredSizeBytes: BigInt(123_456),
      contentType: 'video/webm',
      reservationId: null,
      uploadJti,
      expiresAt,
    });

    const row = await db.videoUploadSession.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('INITIATED');
    expect(row.userId).toBe(scenario.owner.id);
    expect(row.projectId).toBe(scenario.project.id);
    expect(row.billedUserId).toBe(scenario.owner.id);
    expect(row.objectKey).toBe(`videos/${fileId}.mp4`);
    expect(row.thumbnailObjectKey).toBe(`images/${fileId}.jpg`);
    expect(row.declaredSizeBytes).toBe(BigInt(123_456));
    expect(row.contentType).toBe('video/webm');
    expect(row.uploadJti).toBe(uploadJti);
    expect(row.expiresAt.getTime()).toBe(expiresAt.getTime());
    expect(row.reservationId).toBeNull();
    expect(row.consumedAt).toBeNull();
  });

  // The field is optional on the input but the column is not nullable-by-
  // accident: a single-shot PUT must store null rather than undefined, because
  // the complete route branches on it to decide whether to assemble parts.
  it('stores a null multipart id when none is supplied', async () => {
    const { session } = await newSession();

    expect(session.multipartUploadId).toBeNull();
  });

  it('stores an explicit null multipart id as null', async () => {
    const { session } = await newSession({ multipartUploadId: null });

    expect(session.multipartUploadId).toBeNull();
  });

  it('records the multipart upload id when the upload is chunked', async () => {
    const { session } = await newSession({ multipartUploadId: 'multipart-upload-id-1' });

    expect(session.multipartUploadId).toBe('multipart-upload-id-1');
  });

  it('links the quota reservation the caller already took', async () => {
    const scenario = await seedProject();
    const reservation = await db.uploadReservation.create({
      data: {
        billedUserId: scenario.owner.id,
        sizeBytes: BigInt(4096),
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
    });
    const fileId = randomUUID();

    const created = await createR2UploadSession({
      userId: scenario.owner.id,
      projectId: scenario.project.id,
      billedUserId: scenario.owner.id,
      objectKey: `videos/${fileId}.mp4`,
      thumbnailObjectKey: `images/${fileId}.jpg`,
      declaredSizeBytes: BigInt(4096),
      contentType: 'video/mp4',
      reservationId: reservation.id,
      uploadJti: randomUUID(),
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    expect(created.reservationId).toBe(reservation.id);
  });

  // objectKey is unique in the schema, which is what stops two sessions from
  // ever pointing at the same object and racing each other's cleanup.
  it('refuses a second session for the same object key', async () => {
    const { scenario, fileId } = await newSession();

    await expect(
      createR2UploadSession({
        userId: scenario.owner.id,
        projectId: scenario.project.id,
        billedUserId: scenario.owner.id,
        objectKey: `videos/${fileId}.mp4`,
        thumbnailObjectKey: `images/${fileId}.jpg`,
        declaredSizeBytes: BigInt(4096),
        contentType: 'video/mp4',
        reservationId: null,
        uploadJti: randomUUID(),
        expiresAt: new Date(Date.now() + HOUR_MS),
      })
    ).rejects.toThrow();
  });
});

describe('cancelR2UploadSession', () => {
  it('flips an INITIATED session to CANCELLED and stamps consumedAt', async () => {
    const { session } = await newSession();

    const result = await cancelR2UploadSession(session.id);

    expect(result.count).toBe(1);
    const row = await db.videoUploadSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe('CANCELLED');
    expect(row.consumedAt).toBeInstanceOf(Date);
  });

  it('matches nothing on a second cancel, so the route cannot double-release', async () => {
    const { session } = await newSession();
    await cancelR2UploadSession(session.id);

    const result = await cancelR2UploadSession(session.id);

    expect(result.count).toBe(0);
  });

  it('refuses to cancel a session that was already finalized', async () => {
    const { session } = await newSession();
    await db.videoUploadSession.update({
      where: { id: session.id },
      data: { status: 'FINALIZED' },
    });

    const result = await cancelR2UploadSession(session.id);

    expect(result.count).toBe(0);
    expect(
      (await db.videoUploadSession.findUniqueOrThrow({ where: { id: session.id } })).status
    ).toBe('FINALIZED');
  });

  // The `expiresAt: { gt: now }` clause means an expired session cannot be
  // cancelled at all: the row stays INITIATED and consumedAt stays null. That
  // is the current contract, and it is why the sweeper rather than the route
  // has to be the thing that reclaims those reservations. See the report.
  it('matches nothing once the session has expired, leaving it INITIATED', async () => {
    const { session } = await newSession({ expiresAt: new Date(Date.now() - 60_000) });

    const result = await cancelR2UploadSession(session.id);

    expect(result.count).toBe(0);
    const row = await db.videoUploadSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe('INITIATED');
    expect(row.consumedAt).toBeNull();
  });

  it('does nothing for an id that matches no row', async () => {
    const { session } = await newSession();

    const result = await cancelR2UploadSession('no-such-session');

    expect(result.count).toBe(0);
    expect(
      (await db.videoUploadSession.findUniqueOrThrow({ where: { id: session.id } })).status
    ).toBe('INITIATED');
  });

  it('leaves every other session alone', async () => {
    const target = await newSession();
    const bystander = await newSession();

    await cancelR2UploadSession(target.session.id);

    expect(
      (await db.videoUploadSession.findUniqueOrThrow({ where: { id: bystander.session.id } }))
        .status
    ).toBe('INITIATED');
  });
});
