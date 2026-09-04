import { randomUUID } from 'crypto';
import { MediaJobKind } from '@prisma/client';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, HttpStatus, successResponse, withCacheControl } from '@/lib/api-response';
import { isS3VideoUploadsEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { enqueueMediaJob } from '@/lib/media-jobs';
import { rateLimit } from '@/lib/rate-limit';
import {
  classifyDriveImportUrl,
  driveImportRefusalMessage,
  importMetadata,
} from '@/lib/rough-cut/drive-import';
import { gdriveProvider } from '@/lib/video-providers/gdrive';
import { buildVideoObjectKey, videoProxyPathFromFilename } from '@/lib/video-upload-validation';

type RouteParams = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'create-video');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { projectId } = await params;
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) return apiErrors.notFound('Project');

    const access = await checkProjectAccess(project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    if (!isS3VideoUploadsEnabled()) {
      return apiErrors.badRequest('Direct file uploads are disabled on this host');
    }

    const body = await request.json().catch(() => null);
    const url = typeof body?.url === 'string' ? body.url : '';
    const classified = classifyDriveImportUrl(url);
    if (!classified.ok) {
      return apiErrors.badRequest(driveImportRefusalMessage(classified.reason));
    }

    let resolvedFolderId: string | null = null;
    if (body && Object.prototype.hasOwnProperty.call(body, 'folderId')) {
      if (body.folderId !== null && typeof body.folderId !== 'string') {
        return apiErrors.badRequest('folderId must be a folder id or null');
      }
      if (typeof body.folderId === 'string') {
        const folder = await db.folder.findFirst({
          where: { id: body.folderId, projectId },
          select: { id: true },
        });
        if (!folder) return apiErrors.badRequest('folder was not found in this project');
        resolvedFolderId = folder.id;
      }
    }

    const title =
      typeof body?.title === 'string' && body.title.trim()
        ? body.title.trim()
        : `Drive ${classified.fileId.slice(0, 8)}`;

    const fileId = randomUUID();
    const filename = `${fileId}.mp4`;
    const objectKey = buildVideoObjectKey(filename);
    const videoUrl = videoProxyPathFromFilename(filename);
    const thumbnailUrl = gdriveProvider.getThumbnailUrl(classified.fileId, 'medium');

    const lastVideo = await db.video.findFirst({
      where: { projectId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const nextPosition = (lastVideo?.position ?? -1) + 1;

    const video = await db.video.create({
      data: {
        title,
        position: nextPosition,
        projectId,
        folderId: resolvedFolderId,
        kind: 'VIDEO',
        metadata: importMetadata({ fileId: classified.fileId, status: 'pending' }),
        versions: {
          create: {
            versionNumber: 1,
            providerId: 'r2',
            videoId: objectKey,
            originalUrl: videoUrl,
            title,
            thumbnailUrl,
            isActive: true,
            proxyStatus: 'NONE',
          },
        },
      },
      include: { versions: true },
    });

    const version = video.versions[0];
    if (!version) {
      await db.video.delete({ where: { id: video.id } });
      return apiErrors.internalError('Failed to import Drive file');
    }

    await enqueueMediaJob(version.id, MediaJobKind.IMPORT_DRIVE, {
      driveFileId: classified.fileId,
      objectKey,
    });

    return withCacheControl(
      successResponse(
        {
          video: {
            id: video.id,
            title: video.title,
            folderId: video.folderId,
            importStatus: 'pending',
          },
        },
        HttpStatus.CREATED
      ),
      'private, no-store'
    );
  } catch (error) {
    logError('Error importing Drive URL:', error);
    return apiErrors.internalError('Failed to import Drive file');
  }
}
