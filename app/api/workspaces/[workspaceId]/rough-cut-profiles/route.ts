import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkWorkspaceAccess } from '@/lib/auth';
import { apiErrors, HttpStatus, successResponse, withCacheControl } from '@/lib/api-response';
import { isRoughCutFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { parseRoughCutProfileCreate } from '@/lib/rough-cut/profile';
import { shapeRoughCutProfile } from '@/lib/rough-cut/serialize';

type RouteParams = { params: Promise<{ workspaceId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { workspaceId } = await params;
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, ownerId: true },
    });
    if (!workspace) return apiErrors.notFound('Workspace');

    const access = await checkWorkspaceAccess(workspace, session.user.id);
    if (!access.hasAccess) return apiErrors.forbidden('Access denied');

    const profiles = await db.roughCutProfile.findMany({
      where: { workspaceId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    return withCacheControl(
      successResponse({ profiles: profiles.map(shapeRoughCutProfile) }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error listing rough cut profiles:', error);
    return apiErrors.internalError('Failed to list rough cut profiles');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    if (!isRoughCutFeatureEnabled()) {
      return apiErrors.forbidden('Rough cut generation is disabled');
    }

    const { workspaceId } = await params;
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, ownerId: true },
    });
    if (!workspace) return apiErrors.notFound('Workspace');

    const access = await checkWorkspaceAccess(workspace, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => null);
    const parsed = parseRoughCutProfileCreate(body ?? {});
    if (!parsed.ok) return apiErrors.badRequest(parsed.error);

    const created = await db.$transaction(async (tx) => {
      if (parsed.value.isDefault) {
        await tx.roughCutProfile.updateMany({
          where: { workspaceId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.roughCutProfile.create({
        data: {
          workspaceId,
          name: parsed.value.name,
          minShotSeconds: parsed.value.minShotSeconds,
          safetyPauseSeconds: parsed.value.safetyPauseSeconds,
          maxShotSeconds: parsed.value.maxShotSeconds ?? null,
          overlapBehaviour: parsed.value.overlapBehaviour,
          handleFrames: parsed.value.handleFrames,
          wideCameraRole: parsed.value.wideCameraRole,
          cameraRoleMetadataKey: parsed.value.cameraRoleMetadataKey,
          syncStrategy: parsed.value.syncStrategy,
          mediaPathPrefix: parsed.value.mediaPathPrefix,
          isDefault: parsed.value.isDefault,
        },
      });
    });

    return withCacheControl(
      successResponse({ profile: shapeRoughCutProfile(created) }, HttpStatus.CREATED),
      'private, no-store'
    );
  } catch (error) {
    const prismaError = error as { code?: string };
    if (prismaError.code === 'P2002') {
      return apiErrors.conflict('A profile with this name already exists');
    }
    logError('Error creating rough cut profile:', error);
    return apiErrors.internalError('Failed to create rough cut profile');
  }
}
