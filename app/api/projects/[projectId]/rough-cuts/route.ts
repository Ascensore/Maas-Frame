import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, HttpStatus, successResponse, withCacheControl } from '@/lib/api-response';
import { isRoughCutFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import {
  parseCameraRoles,
  parseClipOrder,
  parseWideCameraRole,
  snapshotWithAssembly,
} from '@/lib/rough-cut/assembly';
import {
  applyBriefTechnical,
  applyLayoutBias,
  buildBriefSnapshot,
  defaultProjectTypeForLayout,
  parseEditorialProjectType,
  type LayoutSource,
} from '@/lib/rough-cut/brief';
import {
  guessRoughCutLayout,
  minimumClipsForLayout,
  parseRoughCutLayout,
} from '@/lib/rough-cut/layout';
import {
  isReadyFileBackedVideo,
  loadFolderVideos,
  loadResolvedBrief,
  loadResolvedProfile,
  previewCameraRoles,
  toLayoutGuessClips,
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
    const fileBacked = videos.filter((video) => isReadyFileBackedVideo(video));

    const requestedLayout = parseRoughCutLayout(body?.layout);
    if (body && Object.prototype.hasOwnProperty.call(body, 'layout') && requestedLayout === null) {
      return apiErrors.badRequest('layout must be MULTICAM, SEQUENTIAL, or LINEAR');
    }

    let requestedBriefId: string | null = null;
    if (body && Object.prototype.hasOwnProperty.call(body, 'briefId')) {
      if (body.briefId !== null && typeof body.briefId !== 'string') {
        return apiErrors.badRequest('briefId must be a brief id or null');
      }
      if (typeof body.briefId === 'string' && body.briefId.trim()) {
        const brief = await db.editorialBrief.findFirst({
          where: { id: body.briefId.trim(), workspaceId: project.workspaceId },
          select: { id: true },
        });
        if (!brief) return apiErrors.badRequest('brief was not found in this workspace');
        requestedBriefId = brief.id;
      }
    }
    const requestedProjectType =
      body?.projectType === undefined ? null : parseEditorialProjectType(body.projectType);
    if (body?.projectType !== undefined && !requestedProjectType) {
      return apiErrors.badRequest('projectType must be ASCENSORE, TALKING_HEAD, or INTERVIEW');
    }

    // Merge order: profile (built-in → workspace default → folder → the
    // brief's own profile pointer → an explicit choice), then the brief's
    // technical overrides, then the dialog values. The project type only
    // matters when no brief is bound: it picks the template.
    const baseProfile = await loadResolvedProfile({
      workspaceId: project.workspaceId,
      projectId,
      folderId,
      profileId: requestedProfileId,
    });
    const preliminaryGuess = guessRoughCutLayout(toLayoutGuessClips(fileBacked), {
      cameraRoleMetadataKey: baseProfile.cameraRoleMetadataKey,
    });
    const resolvedBrief = await loadResolvedBrief({
      workspaceId: project.workspaceId,
      projectId,
      folderId,
      briefId: requestedBriefId,
      projectType:
        requestedProjectType ??
        defaultProjectTypeForLayout(requestedLayout ?? preliminaryGuess.layout),
    });
    const briefProfileId = resolvedBrief.brief.technical.roughCutProfileId;
    const profileBase =
      !requestedProfileId && briefProfileId
        ? await loadResolvedProfile({
            workspaceId: project.workspaceId,
            projectId,
            folderId,
            profileId: briefProfileId,
          })
        : baseProfile;
    const profile = applyBriefTechnical(profileBase, resolvedBrief.brief);
    const guess = guessRoughCutLayout(toLayoutGuessClips(fileBacked), {
      cameraRoleMetadataKey: profile.cameraRoleMetadataKey,
    });
    const chosen: { layout: typeof guess.layout; source: LayoutSource } = requestedLayout
      ? { layout: requestedLayout, source: 'dialog' }
      : applyLayoutBias(guess, resolvedBrief.brief.layoutBias, fileBacked.length);
    const layout = chosen.layout;
    if (fileBacked.length < minimumClipsForLayout(layout)) {
      return apiErrors.badRequest(
        layout === 'MULTICAM'
          ? 'A multicam rough cut needs at least two file-backed videos in this folder'
          : 'A rough cut needs at least one file-backed video in this folder'
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

    const allowedIds = new Set(fileBacked.map((video) => video.id));
    const clipOrderParsed = parseClipOrder(body?.clipOrder, allowedIds);
    if (!clipOrderParsed.ok) return apiErrors.badRequest(clipOrderParsed.error);
    const cameraRolesParsed = parseCameraRoles(body?.cameraRoles, allowedIds);
    if (!cameraRolesParsed.ok) return apiErrors.badRequest(cameraRolesParsed.error);
    const wideRoleParsed = parseWideCameraRole(body?.wideCameraRole);
    if (!wideRoleParsed.ok) return apiErrors.badRequest(wideRoleParsed.error);

    const cameras = previewCameraRoles(fileBacked, profile.cameraRoleMetadataKey).map((camera) => ({
      ...camera,
      role: cameraRolesParsed.value?.[camera.videoId] ?? camera.role,
    }));
    const orderIds = clipOrderParsed.value ?? guess.orderedIds;
    const orderSet = new Set(orderIds);
    const orderedCameras = [
      ...orderIds
        .map((id) => cameras.find((camera) => camera.videoId === id))
        .filter((camera): camera is (typeof cameras)[number] => Boolean(camera)),
      ...cameras.filter((camera) => !orderSet.has(camera.videoId)),
    ];
    const referenceVersionId =
      orderedCameras.find((camera) => camera.versionId)?.versionId ??
      cameras.find((camera) => camera.versionId)?.versionId;
    if (!referenceVersionId) {
      return apiErrors.badRequest(
        'A rough cut needs at least one file-backed video in this folder'
      );
    }

    const created = await db.roughCut.create({
      data: {
        projectId,
        folderId,
        profileId: profile.id,
        briefId: resolvedBrief.briefId,
        briefSnapshot: buildBriefSnapshot({
          resolved: resolvedBrief,
          layoutSource: chosen.source,
          projectGuidelines: resolvedBrief.projectGuidelines,
        }) as Prisma.InputJsonValue,
        requestedById: session.user.id,
        layout,
        profileSnapshot: snapshotWithAssembly(profile, {
          clipOrder: clipOrderParsed.value,
          cameraRoles: cameraRolesParsed.value,
          wideCameraRole: wideRoleParsed.value,
        }),
      },
    });

    await enqueueAssembleRoughCut({
      versionId: referenceVersionId,
      roughCutId: created.id,
    });

    return withCacheControl(
      successResponse(
        {
          roughCut: shapeRoughCut(created),
          cameras: orderedCameras,
          layout,
          guessedLayout: guess.layout,
          guessReason: guess.reason,
        },
        HttpStatus.CREATED
      ),
      'private, no-store'
    );
  } catch (error) {
    logError('Error creating rough cut:', error);
    return apiErrors.internalError('Failed to create rough cut');
  }
}
