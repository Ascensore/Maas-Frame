import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { parseR2UploadToken, verifyR2UploadToken } from '@/lib/r2-upload-token';
import { abortMultipartVideoUpload, deleteR2Object, deleteVideoObject } from '@/lib/r2';
import { isS3VideoUploadsEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { releaseStorageReservation, UPLOAD_RESERVATION_PURPOSES } from '@/lib/storage-quota';
import { startR2ReviewUpload } from '@/lib/r2-review-upload';

type RouteParams = { params: Promise<{ projectId: string }> };

async function getProjectWithEditAccess(projectId: string, userId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      ownerId: true,
      workspaceId: true,
      visibility: true,
      workspace: { select: { ownerId: true } },
    },
  });

  if (!project) return null;

  const access = await checkProjectAccess(project, userId);
  if (!access.canEdit) return null;

  return project;
}

// POST /api/projects/[projectId]/videos/r2-init
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    if (!isS3VideoUploadsEnabled()) {
      return apiErrors.badRequest('S3 video uploads are disabled by this host');
    }

    const project = await getProjectWithEditAccess(projectId, session.user.id);
    if (!project) {
      return apiErrors.forbidden('Access denied');
    }

    const body = await request.json().catch(() => null);
    const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
    const contentTypeInput = typeof body?.contentType === 'string' ? body.contentType.trim() : '';
    const sizeBytesRaw = body?.sizeBytes;

    if (!fileName) {
      return apiErrors.badRequest('fileName is required');
    }

    let sizeBytes: bigint;
    try {
      sizeBytes = BigInt(sizeBytesRaw);
      if (sizeBytes <= BigInt(0)) {
        return apiErrors.badRequest('sizeBytes must be a positive integer');
      }
    } catch {
      return apiErrors.badRequest('sizeBytes must be a positive integer');
    }

    return startR2ReviewUpload({
      userId: session.user.id,
      projectId,
      billedUserId: project.workspace.ownerId,
      fileName,
      contentTypeInput,
      sizeBytes,
    });
  } catch (error) {
    logError('Error initializing R2 video upload:', error);
    return apiErrors.internalError('Failed to initialize upload');
  }
}

// DELETE /api/projects/[projectId]/videos/r2-init
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    if (!isS3VideoUploadsEnabled()) {
      return apiErrors.badRequest('S3 video uploads are disabled by this host');
    }

    const project = await getProjectWithEditAccess(projectId, session.user.id);
    if (!project) {
      return apiErrors.forbidden('Access denied');
    }

    const body = await request.json().catch(() => null);
    const objectKey = typeof body?.objectKey === 'string' ? body.objectKey.trim() : '';
    const uploadToken = typeof body?.uploadToken === 'string' ? body.uploadToken.trim() : '';
    const thumbnailObjectKey =
      typeof body?.thumbnailObjectKey === 'string' ? body.thumbnailObjectKey.trim() : '';

    if (!objectKey || !uploadToken) {
      return apiErrors.badRequest('objectKey and uploadToken are required');
    }

    const tokenPayload = parseR2UploadToken(uploadToken);
    if (!tokenPayload) {
      return apiErrors.forbidden('Invalid upload token');
    }

    const isValidUploadToken = verifyR2UploadToken(uploadToken, {
      userId: session.user.id,
      projectId,
      objectKey,
      sessionId: tokenPayload.sid,
      tokenId: tokenPayload.jti,
    });
    if (!isValidUploadToken) {
      return apiErrors.forbidden('Invalid upload token');
    }

    const uploadSession = await db.videoUploadSession.findFirst({
      where: {
        id: tokenPayload.sid,
        status: 'INITIATED',
        userId: session.user.id,
        projectId,
        objectKey,
        uploadJti: tokenPayload.jti,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        reservationId: true,
        billedUserId: true,
        thumbnailObjectKey: true,
        multipartUploadId: true,
      },
    });
    if (!uploadSession) {
      return apiErrors.forbidden('Invalid upload token');
    }

    if (thumbnailObjectKey && thumbnailObjectKey !== uploadSession.thumbnailObjectKey) {
      return apiErrors.badRequest('Invalid thumbnail object key');
    }

    const cancelled = await db.videoUploadSession.updateMany({
      where: {
        id: uploadSession.id,
        status: 'INITIATED',
      },
      data: {
        status: 'CANCELLED',
        consumedAt: new Date(),
      },
    });
    if (cancelled.count !== 1) {
      return apiErrors.forbidden('Invalid upload token');
    }

    try {
      await Promise.all([
        uploadSession.multipartUploadId
          ? abortMultipartVideoUpload(objectKey, uploadSession.multipartUploadId)
          : Promise.resolve(),
        deleteVideoObject(objectKey),
        uploadSession.thumbnailObjectKey.startsWith('images/')
          ? deleteR2Object(uploadSession.thumbnailObjectKey)
          : Promise.resolve(),
      ]);
    } catch (error) {
      logError('Failed to delete pending R2 video object:', error);
    }

    await releaseStorageReservation(
      uploadSession.reservationId,
      uploadSession.billedUserId,
      UPLOAD_RESERVATION_PURPOSES.R2_VIDEO
    );

    const response = successResponse({ message: 'Pending upload cleaned up' });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error cleaning up pending R2 video upload:', error);
    return apiErrors.internalError('Failed to cleanup pending upload');
  }
}
