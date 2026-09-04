import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { auth, checkWorkspaceAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isRoughCutFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import {
  briefConfigFromStored,
  mergeBriefConfig,
  parseEditorialBriefPatch,
} from '@/lib/rough-cut/brief';
import { shapeEditorialBrief } from '@/lib/rough-cut/serialize';

type RouteParams = { params: Promise<{ workspaceId: string; briefId: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    if (!isRoughCutFeatureEnabled()) {
      return apiErrors.forbidden('Rough cut generation is disabled');
    }

    const { workspaceId, briefId } = await params;
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, ownerId: true },
    });
    if (!workspace) return apiErrors.notFound('Workspace');

    const access = await checkWorkspaceAccess(workspace, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const existing = await db.editorialBrief.findFirst({ where: { id: briefId, workspaceId } });
    if (!existing) return apiErrors.notFound('Brief');

    const body = await request.json().catch(() => null);
    const parsed = parseEditorialBriefPatch(body ?? {});
    if (!parsed.ok) return apiErrors.badRequest(parsed.error);

    const projectType = parsed.value.projectType ?? existing.projectType;
    if (parsed.value.config?.projectType && parsed.value.config.projectType !== projectType) {
      return apiErrors.badRequest('config.projectType must match projectType');
    }
    // A config patch lays over the stored config, not the template, so an
    // edit to one field leaves every other choice the way it was.
    const nextConfig =
      parsed.value.config || parsed.value.projectType
        ? mergeBriefConfig(briefConfigFromStored(existing.config, existing.projectType), {
            ...(parsed.value.config ?? {}),
            projectType,
          })
        : null;
    const pointer = parsed.value.config?.technical?.roughCutProfileId;
    if (pointer) {
      const profile = await db.roughCutProfile.findFirst({
        where: { id: pointer, workspaceId },
        select: { id: true },
      });
      if (!profile) {
        return apiErrors.badRequest('technical.roughCutProfileId was not found in this workspace');
      }
    }
    // Moving a brief to another project type does not carry its default flag
    // along: that would silently unseat the other type's default. The patch
    // has to say isDefault: true to make it the default there.
    const typeChanged = projectType !== existing.projectType;
    const willBeDefault = parsed.value.isDefault ?? (typeChanged ? false : existing.isDefault);

    const updated = await db.$transaction(async (tx) => {
      if (willBeDefault) {
        await tx.editorialBrief.updateMany({
          where: { workspaceId, projectType, isDefault: true, NOT: { id: briefId } },
          data: { isDefault: false },
        });
      }
      return tx.editorialBrief.update({
        where: { id: briefId },
        data: {
          ...(parsed.value.name !== undefined ? { name: parsed.value.name } : {}),
          ...(parsed.value.projectType !== undefined ? { projectType } : {}),
          ...(parsed.value.isDefault !== undefined || typeChanged
            ? { isDefault: willBeDefault }
            : {}),
          ...(nextConfig ? { config: nextConfig as Prisma.InputJsonValue } : {}),
        },
      });
    });

    return withCacheControl(
      successResponse({ brief: shapeEditorialBrief(updated) }),
      'private, no-store'
    );
  } catch (error) {
    const prismaError = error as { code?: string };
    if (prismaError.code === 'P2002') {
      return apiErrors.conflict('A brief with this name already exists');
    }
    logError('Error updating editorial brief:', error);
    return apiErrors.internalError('Failed to update editorial brief');
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

    const { workspaceId, briefId } = await params;
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, ownerId: true },
    });
    if (!workspace) return apiErrors.notFound('Workspace');

    const access = await checkWorkspaceAccess(workspace, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const existing = await db.editorialBrief.findFirst({
      where: { id: briefId, workspaceId },
      select: { id: true },
    });
    if (!existing) return apiErrors.notFound('Brief');

    // Folders, projects and past runs that pointed here fall back to the next
    // level of the resolution order; the relations are SetNull.
    await db.editorialBrief.delete({ where: { id: briefId } });
    return withCacheControl(successResponse({ deleted: true }), 'private, no-store');
  } catch (error) {
    logError('Error deleting editorial brief:', error);
    return apiErrors.internalError('Failed to delete editorial brief');
  }
}
