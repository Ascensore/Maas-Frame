import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { notifyProjectOwner } from '@/lib/notifications';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { finalizeR2VideoUpload } from '@/lib/r2-video-finalize';
import { UPLOAD_RESERVATION_PURPOSES } from '@/lib/storage-quota';
import { logError } from '@/lib/logger';
import { eventKey, recordEvent } from '@/lib/analytics/record';
import { enqueueJobsForNewVersion } from '@/lib/media-jobs';
import { reviewKindFromUploadPath } from '@/lib/review-kind';
import { loadC2cCaller } from '@/lib/c2c-token';
import { isS3VideoUploadsEnabled } from '@/lib/feature-flags';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const limited = await rateLimit(request, 'create-video');
    if (limited) return limited;

    const caller = await loadC2cCaller(request);
    if (!caller) return apiErrors.unauthorized();

    if (!isS3VideoUploadsEnabled()) {
      return apiErrors.badRequest('S3 video uploads are disabled by this host');
    }

    const body = await request.json().catch(() => null);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const videoUrl = typeof body?.videoUrl === 'string' ? body.videoUrl.trim() : '';
    const objectKey = typeof body?.objectKey === 'string' ? body.objectKey.trim() : '';
    const uploadToken = typeof body?.uploadToken === 'string' ? body.uploadToken.trim() : '';
    const duration = typeof body?.duration === 'number' ? body.duration : null;

    if (!title || !videoUrl) {
      return apiErrors.badRequest('Title and video URL are required');
    }
    if (!videoUrl.startsWith('/api/upload/video/')) {
      return apiErrors.badRequest('Video URL must be a valid upload path');
    }
    if (!objectKey || !uploadToken) {
      return apiErrors.badRequest('R2 uploads must include objectKey and uploadToken');
    }

    let resolvedFolderId = caller.folderId;
    if (resolvedFolderId) {
      const folder = await db.folder.findFirst({
        where: { id: resolvedFolderId, projectId: caller.projectId },
        select: { id: true },
      });
      if (!folder) {
        return apiErrors.badRequest('ingest folder was not found in this project');
      }
      resolvedFolderId = folder.id;
    }

    const finalizeResult = await finalizeR2VideoUpload({
      userId: caller.createdById,
      projectId: caller.projectId,
      videoUrl,
      objectKey,
      uploadToken,
    });
    if (!finalizeResult.ok) {
      if (finalizeResult.status === 403) {
        return apiErrors.forbidden(finalizeResult.error);
      }
      return apiErrors.badRequest(finalizeResult.error);
    }

    const kind = reviewKindFromUploadPath(videoUrl, 'r2');
    const r2ThumbnailFallback =
      finalizeResult.thumbnailProxyUrl ?? '/placeholder-video-thumbnail.png';
    const versionThumbnailUrl = kind === 'IMAGE' ? videoUrl : r2ThumbnailFallback;

    const lastVideo = await db.video.findFirst({
      where: { projectId: caller.projectId },
      orderBy: { position: 'desc' },
    });
    const nextPosition = (lastVideo?.position ?? -1) + 1;

    const video = await db.$transaction(async (tx) => {
      const consumed = await tx.videoUploadSession.updateMany({
        where: {
          id: finalizeResult.sessionId,
          status: 'INITIATED',
          userId: caller.createdById,
          projectId: caller.projectId,
          objectKey,
        },
        data: {
          status: 'FINALIZED',
          consumedAt: new Date(),
        },
      });
      if (consumed.count !== 1) {
        throw new Error('Upload session already consumed');
      }
      if (finalizeResult.reservationId) {
        await tx.uploadReservation.deleteMany({
          where: {
            id: finalizeResult.reservationId,
            billedUserId: finalizeResult.billedUserId,
            purpose: UPLOAD_RESERVATION_PURPOSES.R2_VIDEO,
          },
        });
      }

      return tx.video.create({
        data: {
          title,
          description: null,
          position: nextPosition,
          projectId: caller.projectId,
          folderId: resolvedFolderId,
          kind,
          versions: {
            create: {
              versionNumber: 1,
              providerId: 'r2',
              videoId: objectKey,
              originalUrl: videoUrl,
              title,
              thumbnailUrl: versionThumbnailUrl,
              duration,
              sizeBytes: finalizeResult.sizeBytes,
              isActive: true,
              proxyStatus: kind === 'IMAGE' || kind === 'PDF' ? 'SKIPPED' : undefined,
            },
          },
        },
        include: {
          versions: true,
          _count: { select: { versions: true } },
        },
      });
    });

    if (caller.project.ownerId !== caller.createdById) {
      const baseUrl = process.env.NEXTAUTH_URL || '';
      notifyProjectOwner(caller.project.ownerId, {
        type: 'new_video',
        projectName: caller.project.name,
        videoTitle: title,
        addedBy: 'Camera ingest',
        url: `${baseUrl}/watch/${video.id}`,
      }).catch((err) => logError('Notification failed:', err));
    }

    await recordEvent({
      name: 'VIDEO_ADDED',
      dedupeKey: eventKey('VIDEO_ADDED', video.id),
      userId: caller.project.ownerId,
    });

    const firstVersion = video.versions[0];
    if (firstVersion) {
      await enqueueJobsForNewVersion({
        versionId: firstVersion.id,
        providerId: firstVersion.providerId,
        kind,
      }).catch((err) => logError('Failed to enqueue media jobs:', err));
    }

    const response = successResponse(video, 201);
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error creating C2C video:', error);
    return apiErrors.internalError('Failed to create video');
  }
}
