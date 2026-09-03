import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkWorkspaceAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isRoughCutFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { parseRoughCutProfilePatch } from '@/lib/rough-cut/profile';
import { shapeRoughCutProfile } from '@/lib/rough-cut/serialize';

type RouteParams = { params: Promise<{ workspaceId: string; profileId: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    if (!isRoughCutFeatureEnabled()) {
      return apiErrors.forbidden('Rough cut generation is disabled');
    }

    const { workspaceId, profileId } = await params;
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, ownerId: true },
    });
    if (!workspace) return apiErrors.notFound('Workspace');

    const access = await checkWorkspaceAccess(workspace, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const existing = await db.roughCutProfile.findFirst({
      where: { id: profileId, workspaceId },
    });
    if (!existing) return apiErrors.notFound('Profile');

    const body = await request.json().catch(() => null);
    const parsed = parseRoughCutProfilePatch(body ?? {});
    if (!parsed.ok) return apiErrors.badRequest(parsed.error);

    const updated = await db.$transaction(async (tx) => {
      if (parsed.value.isDefault === true) {
        await tx.roughCutProfile.updateMany({
          where: { workspaceId, isDefault: true, NOT: { id: profileId } },
          data: { isDefault: false },
        });
      }
      return tx.roughCutProfile.update({
        where: { id: profileId },
        data: {
          ...(parsed.value.name !== undefined ? { name: parsed.value.name } : {}),
          ...(parsed.value.minShotSeconds !== undefined
            ? { minShotSeconds: parsed.value.minShotSeconds }
            : {}),
          ...(parsed.value.safetyPauseSeconds !== undefined
            ? { safetyPauseSeconds: parsed.value.safetyPauseSeconds }
            : {}),
          ...(parsed.value.maxShotSeconds !== undefined
            ? { maxShotSeconds: parsed.value.maxShotSeconds }
            : {}),
          ...(parsed.value.overlapBehaviour !== undefined
            ? { overlapBehaviour: parsed.value.overlapBehaviour }
            : {}),
          ...(parsed.value.handleFrames !== undefined
            ? { handleFrames: parsed.value.handleFrames }
            : {}),
          ...(parsed.value.wideCameraRole !== undefined
            ? { wideCameraRole: parsed.value.wideCameraRole }
            : {}),
          ...(parsed.value.cameraRoleMetadataKey !== undefined
            ? { cameraRoleMetadataKey: parsed.value.cameraRoleMetadataKey }
            : {}),
          ...(parsed.value.syncStrategy !== undefined
            ? { syncStrategy: parsed.value.syncStrategy }
            : {}),
          ...(parsed.value.mediaPathPrefix !== undefined
            ? { mediaPathPrefix: parsed.value.mediaPathPrefix }
            : {}),
          ...(parsed.value.isDefault !== undefined ? { isDefault: parsed.value.isDefault } : {}),
        },
      });
    });

    return withCacheControl(
      successResponse({ profile: shapeRoughCutProfile(updated) }),
      'private, no-store'
    );
  } catch (error) {
    const prismaError = error as { code?: string };
    if (prismaError.code === 'P2002') {
      return apiErrors.conflict('A profile with this name already exists');
    }
    logError('Error updating rough cut profile:', error);
    return apiErrors.internalError('Failed to update rough cut profile');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    if (!isRoughCutFeatureEnabled()) {
      return apiErrors.forbidden('Rough cut generation is disabled');
    }

    const { workspaceId, profileId } = await params;
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, ownerId: true },
    });
    if (!workspace) return apiErrors.notFound('Workspace');

    const access = await checkWorkspaceAccess(workspace, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const existing = await db.roughCutProfile.findFirst({
      where: { id: profileId, workspaceId },
      select: { id: true },
    });
    if (!existing) return apiErrors.notFound('Profile');

    await db.roughCutProfile.delete({ where: { id: profileId } });
    return withCacheControl(successResponse({ deleted: true }), 'private, no-store');
  } catch (error) {
    logError('Error deleting rough cut profile:', error);
    return apiErrors.internalError('Failed to delete rough cut profile');
  }
}
