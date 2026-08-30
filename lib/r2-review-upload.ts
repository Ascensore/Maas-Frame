import { randomUUID } from 'crypto';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  abortMultipartVideoUpload,
  createMultipartVideoUpload,
  createPresignedImagePutUrl,
  createPresignedUploadPartUrl,
  createPresignedVideoPutUrl,
} from '@/lib/r2';
import { getR2MultipartPartSizeBytes, getR2MultipartThresholdBytes } from '@/lib/feature-flags';
import { buildVideoObjectKey, videoProxyPathFromFilename } from '@/lib/video-upload-validation';
import { resolveReviewUpload } from '@/lib/review-kind';
import { logError } from '@/lib/logger';
import {
  enforceStorageQuota,
  getMaxVideoUploadBytesForUser,
  releaseStorageReservation,
  reserveStorageQuota,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
import { uploadTooLargeMessage } from '@/lib/upload-size';
import { createR2UploadSession } from '@/lib/r2-upload-session';
import { createR2UploadToken } from '@/lib/r2-upload-token';

const VIDEO_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;
const THUMBNAIL_RESERVE_BYTES = BigInt(512 * 1024);

export async function startR2ReviewUpload(input: {
  userId: string;
  projectId: string;
  billedUserId: string;
  fileName: string;
  contentTypeInput: string;
  sizeBytes: bigint;
}) {
  const maxBytes = await getMaxVideoUploadBytesForUser(input.billedUserId);
  if (input.sizeBytes > maxBytes) {
    return apiErrors.badRequest(uploadTooLargeMessage(maxBytes));
  }

  const resolved = resolveReviewUpload(input.fileName, input.contentTypeInput);
  if (!resolved) {
    return apiErrors.badRequest('Unsupported file format');
  }

  const contentType = resolved.contentType;
  const ext = resolved.extension;

  const quotaError = await enforceStorageQuota(
    input.billedUserId,
    input.sizeBytes + THUMBNAIL_RESERVE_BYTES
  );
  if (quotaError) return quotaError;

  const reserveResult = await reserveStorageQuota(
    input.billedUserId,
    input.sizeBytes + THUMBNAIL_RESERVE_BYTES,
    UPLOAD_RESERVATION_PURPOSES.R2_VIDEO,
    VIDEO_RESERVATION_TTL_MS
  );
  if ('error' in reserveResult) return reserveResult.error;

  const fileId = randomUUID();
  const filename = `${fileId}.${ext}`;
  const objectKey = buildVideoObjectKey(filename);
  const proxyUrl = videoProxyPathFromFilename(filename);
  const thumbnailFilename = `${fileId}.jpg`;
  const thumbnailObjectKey = `images/${thumbnailFilename}`;
  const thumbnailProxyUrl = `/api/upload/image/${thumbnailFilename}`;

  const useMultipart = input.sizeBytes > getR2MultipartThresholdBytes();

  let presignedPutUrl = '';
  let thumbnailPresignedPutUrl: string;
  let multipartUploadId: string | null = null;
  let multipart: {
    uploadId: string;
    partSizeBytes: number;
    parts: Array<{ partNumber: number; url: string }>;
  } | null = null;

  try {
    if (useMultipart) {
      const partSize = getR2MultipartPartSizeBytes();
      const partCount = Number((input.sizeBytes + partSize - BigInt(1)) / partSize);

      multipartUploadId = await createMultipartVideoUpload(objectKey, contentType);

      try {
        const [parts, thumbnailUrl] = await Promise.all([
          Promise.all(
            Array.from({ length: partCount }, async (_unused, index) => {
              const partNumber = index + 1;
              const url = await createPresignedUploadPartUrl(
                objectKey,
                multipartUploadId as string,
                partNumber
              );
              return { partNumber, url };
            })
          ),
          createPresignedImagePutUrl(thumbnailObjectKey, 'image/jpeg'),
        ]);

        multipart = { uploadId: multipartUploadId, partSizeBytes: Number(partSize), parts };
        thumbnailPresignedPutUrl = thumbnailUrl;
      } catch (error) {
        await abortMultipartVideoUpload(objectKey, multipartUploadId).catch(() => undefined);
        throw error;
      }
    } else {
      [presignedPutUrl, thumbnailPresignedPutUrl] = await Promise.all([
        createPresignedVideoPutUrl(objectKey, contentType, input.sizeBytes),
        createPresignedImagePutUrl(thumbnailObjectKey, 'image/jpeg'),
      ]);
    }
  } catch (error) {
    await releaseStorageReservation(
      reserveResult.reservationId,
      input.billedUserId,
      UPLOAD_RESERVATION_PURPOSES.R2_VIDEO
    );
    logError('Failed to create presigned video upload URL:', error);
    return apiErrors.internalError('Failed to initialize video upload');
  }

  const uploadJti = randomUUID();
  const expiresAt = new Date(Date.now() + VIDEO_RESERVATION_TTL_MS);
  const uploadSession = await createR2UploadSession({
    userId: input.userId,
    projectId: input.projectId,
    billedUserId: input.billedUserId,
    objectKey,
    thumbnailObjectKey,
    declaredSizeBytes: input.sizeBytes,
    contentType,
    reservationId: reserveResult.reservationId,
    uploadJti,
    expiresAt,
    multipartUploadId,
  });

  const uploadToken = createR2UploadToken({
    userId: input.userId,
    projectId: input.projectId,
    objectKey,
    sessionId: uploadSession.id,
    tokenId: uploadJti,
    thumbnailObjectKey,
  });

  const response = successResponse({
    presignedPutUrl,
    objectKey,
    proxyUrl,
    uploadToken,
    reservationId: reserveResult.reservationId,
    contentType,
    thumbnailPresignedPutUrl,
    thumbnailObjectKey,
    thumbnailProxyUrl,
    multipart,
  });

  return withCacheControl(response, 'private, no-store');
}
