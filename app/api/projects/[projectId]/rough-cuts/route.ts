import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, HttpStatus, successResponse, withCacheControl } from '@/lib/api-response';
import { isRoughCutFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { snapshotFromProfile } from '@/lib/rough-cut/profile';
import {
  isFileBackedProvider,
  loadFolderVideos,
  loadResolvedProfile,
  previewCameraRoles,
} from '@/lib/rough-cut/load';
import { enqueueAssembleRoughCut, shapeRoughCut } from '@/lib/rough-cut/serialize';

type RouteParams = { params: Promise<{ projectId: string }> };

function parseFolderId(raw: string | null): string | null | undefined {
  if (raw === null) return undefined;
  if (raw === '' || raw === 'root') return null;
  return raw;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { projectId } = await params;
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) return apiErrors.notFound('Project');

    const access = await checkProjectAccess(project, session.user.id);
    if (!access.hasAccess) return apiErrors.forbidden('Access denied');

    const folderParam = parseFolderId(request.nextUrl.searchParams.get('folderId'));
    const rows = await db.roughCut.findMany({
      where: {
        projectId,
        ...(folderParam === undefined ? {} : { folderId: folderParam }),
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return withCacheControl(
      successResponse({ roughCuts: rows.map(shapeRoughCut) }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error listing rough cuts:', error);
    return apiErrors.internalError('Failed to list rough cuts');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'rough-cut');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    if (!isRoughCutFeatureEnabled()) {
      return apiErrors.forbidden('Rough cut generation is disabled');
    }

    const { projectId } = await params;
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) return apiErrors.notFound('Project');

    const access = await checkProjectAccess(project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => null);
    let folderId: string | null = null;
    if (body && Object.prototype.hasOwnProperty.call(body, 'folderId')) {
      if (body.folderId !== null && typeof body.folderId !== 'string') {
        return apiErrors.badRequest('folderId must be a folder id or null');
      }
      folderId = body.folderId;
    }

    if (folderId) {
      const folder = await db.folder.findFirst({
        where: { id: folderId, projectId },
        select: { id: true },
      });
      if (!folder) return apiErrors.badRequest('folder was not found in this project');
    }

    let requestedProfileId: string | null = null;
    if (body && typeof body.profileId === 'string' && body.profileId.trim()) {
      const profileId = body.profileId.trim();
      const profile = await db.roughCutProfile.findFirst({
        where: { id: profileId, workspaceId: project.workspaceId },
        select: { id: true },
      });
      if (!profile) return apiErrors.badRequest('profile was not found in this workspace');
      requestedProfileId = profileId;
    }

    const videos = await loadFolderVideos(projectId, folderId);
    const fileBacked = videos.filter((video) => {
      const version = video.versions[0];
      return version && isFileBackedProvider(version.providerId);
    });
    if (fileBacked.length < 2) {
      return apiErrors.badRequest(
        'A rough cut needs at least two file-backed videos in this folder'
      );
    }

    const existing = await db.roughCut.findFirst({
      where: {
        projectId,
        folderId,
        status: { in: ['PENDING', 'RUNNING'] },
      },
      select: { id: true },
    });
    if (existing) {
      return apiErrors.conflict('A rough cut is already running for this folder');
    }

    const profile = await loadResolvedProfile({
      workspaceId: project.workspaceId,
      projectId,
      folderId,
      profileId: requestedProfileId,
    });
    const cameras = previewCameraRoles(fileBacked, profile.cameraRoleMetadataKey);
    const referenceVersionId = cameras.find((camera) => camera.versionId)?.versionId;
    if (!referenceVersionId) {
      return apiErrors.badRequest(
        'A rough cut needs at least two file-backed videos in this folder'
      );
    }

    const created = await db.roughCut.create({
      data: {
        projectId,
        folderId,
        profileId: profile.id,
        requestedById: session.user.id,
        profileSnapshot: snapshotFromProfile(profile),
      },
    });

    await enqueueAssembleRoughCut({
      versionId: referenceVersionId,
      roughCutId: created.id,
    });

    return withCacheControl(
      successResponse({ roughCut: shapeRoughCut(created), cameras }, HttpStatus.CREATED),
      'private, no-store'
    );
  } catch (error) {
    logError('Error creating rough cut:', error);
    return apiErrors.internalError('Failed to create rough cut');
  }
}
