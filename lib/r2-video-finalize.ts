import { db } from '@/lib/db';
import { getConfiguredMaxVideoUploadBytes } from '@/lib/feature-flags';
import { deleteR2Object, deleteVideoObject, headVideoObject, readVideoObjectBytes } from '@/lib/r2';
import { parseR2UploadToken, verifyR2UploadToken } from '@/lib/r2-upload-token';
import {
  objectKeyToVideoProxyPath,
  videoProxyPathToObjectKey,
} from '@/lib/video-upload-validation';
import { hasKnownReviewMagicBytes } from '@/lib/review-kind';

export type R2VideoFinalizeInput = {
  userId: string;
  projectId: string;
  videoUrl: string;
  objectKey: string;
  uploadToken: string;
};

export type R2VideoFinalizeResult =
  | {
      ok: true;
      sizeBytes: bigint;
      proxyUrl: string;
      objectKey: string;
      sessionId: string;
      reservationId: string | null;
      billedUserId: string;
      thumbnailObjectKey: string;
      thumbnailProxyUrl: string;
    }
  | { ok: false; error: string; status: 400 | 403 };

export async function finalizeR2VideoUpload(
  input: R2VideoFinalizeInput
): Promise<R2VideoFinalizeResult> {
  const { userId, projectId, videoUrl, objectKey, uploadToken } = input;

  if (!objectKey || !uploadToken) {
    return { ok: false, error: 'R2 uploads must include objectKey and uploadToken', status: 400 };
  }

  const expectedProxyUrl = objectKeyToVideoProxyPath(objectKey);
  if (!expectedProxyUrl) {
    return { ok: false, error: 'Invalid object key', status: 400 };
  }

  if (videoUrl !== expectedProxyUrl) {
    return { ok: false, error: 'Video URL does not match the uploaded object', status: 400 };
  }

  const keyFromUrl = videoProxyPathToObjectKey(videoUrl);
  if (!keyFromUrl || keyFromUrl !== objectKey) {
    return { ok: false, error: 'Video URL does not match the uploaded object', status: 400 };
  }

  const tokenPayload = parseR2UploadToken(uploadToken);
  if (!tokenPayload) {
    return { ok: false, error: 'Invalid upload token', status: 403 };
  }

  const isValidUploadToken = verifyR2UploadToken(uploadToken, {
    userId,
    projectId,
    objectKey,
    sessionId: tokenPayload.sid,
    tokenId: tokenPayload.jti,
  });
  if (!isValidUploadToken) {
    return { ok: false, error: 'Invalid upload token', status: 403 };
  }

  const uploadSession = await db.videoUploadSession.findFirst({
    where: {
      id: tokenPayload.sid,
      uploadJti: tokenPayload.jti,
      status: 'INITIATED',
      userId,
      projectId,
      objectKey,
      thumbnailObjectKey: tokenPayload.tkey,
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      billedUserId: true,
      reservationId: true,
      declaredSizeBytes: true,
      thumbnailObjectKey: true,
    },
  });
  if (!uploadSession) {
    return { ok: false, error: 'Invalid upload token', status: 403 };
  }

  const thumbnailFilename = uploadSession.thumbnailObjectKey.startsWith('images/')
    ? uploadSession.thumbnailObjectKey.slice('images/'.length)
    : '';
  if (!thumbnailFilename) {
    return { ok: false, error: 'Invalid upload token', status: 403 };
  }

  const cancelPendingUpload = async (error: string): Promise<R2VideoFinalizeResult> => {
    await db.videoUploadSession.updateMany({
      where: { id: uploadSession.id, status: 'INITIATED' },
      data: { status: 'CANCELLED', consumedAt: new Date() },
    });
    await Promise.all([
      deleteVideoObject(objectKey).catch(() => undefined),
      deleteR2Object(uploadSession.thumbnailObjectKey).catch(() => undefined),
    ]);
    return { ok: false, error, status: 400 };
  };

  const head = await headVideoObject(objectKey);
  if (!head || head.contentLength <= BigInt(0)) {
    return cancelPendingUpload('Uploaded video was not found in storage');
  }

  // Only the host's absolute cap is re-checked here. The account's own ceiling
  // was applied when the upload was initiated, and re-deriving it now would
  // delete a finished upload over a plan that lapsed while the bytes were in
  // flight. Anything larger than what was declared is caught on the next line.
  const hostCeiling = getConfiguredMaxVideoUploadBytes();
  if (hostCeiling !== null && head.contentLength > hostCeiling) {
    return cancelPendingUpload('Uploaded video exceeds the maximum allowed upload size');
  }

  if (head.contentLength > uploadSession.declaredSizeBytes) {
    return cancelPendingUpload('Uploaded video size does not match upload request');
  }

  const headerBytes = await readVideoObjectBytes(objectKey, 64);
  const fileName = objectKey.split('/').pop() ?? '';
  if (!headerBytes || !hasKnownReviewMagicBytes(fileName, headerBytes)) {
    return cancelPendingUpload('Uploaded file is not a valid video');
  }

  return {
    ok: true,
    sizeBytes: head.contentLength,
    proxyUrl: expectedProxyUrl,
    objectKey,
    sessionId: uploadSession.id,
    reservationId: uploadSession.reservationId,
    billedUserId: uploadSession.billedUserId,
    thumbnailObjectKey: uploadSession.thumbnailObjectKey,
    thumbnailProxyUrl: `/api/upload/image/${thumbnailFilename}`,
  };
}
