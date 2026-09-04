import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { auth, checkWorkspaceAccess } from '@/lib/auth';
import { apiErrors, HttpStatus, successResponse, withCacheControl } from '@/lib/api-response';
import { isRoughCutFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { parseEditorialBriefCreate } from '@/lib/rough-cut/brief';
import { shapeEditorialBrief } from '@/lib/rough-cut/serialize';

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

    const briefs = await db.editorialBrief.findMany({
      where: { workspaceId },
      orderBy: [{ projectType: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }],
    });

    return withCacheControl(
      successResponse({ briefs: briefs.map(shapeEditorialBrief) }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error listing editorial briefs:', error);
    return apiErrors.internalError('Failed to list editorial briefs');
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
    const parsed = parseEditorialBriefCreate(body ?? {});
    if (!parsed.ok) return apiErrors.badRequest(parsed.error);

    // One default per project type: the new default unseats the old one.
    const created = await db.$transaction(async (tx) => {
      if (parsed.value.isDefault) {
        await tx.editorialBrief.updateMany({
          where: { workspaceId, projectType: parsed.value.projectType, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.editorialBrief.create({
        data: {
          workspaceId,
          name: parsed.value.name,
          projectType: parsed.value.projectType,
          isDefault: parsed.value.isDefault,
          config: parsed.value.config as Prisma.InputJsonValue,
        },
      });
    });

    return withCacheControl(
      successResponse({ brief: shapeEditorialBrief(created) }, HttpStatus.CREATED),
      'private, no-store'
    );
  } catch (error) {
    const prismaError = error as { code?: string };
    if (prismaError.code === 'P2002') {
      return apiErrors.conflict('A brief with this name already exists');
    }
    logError('Error creating editorial brief:', error);
    return apiErrors.internalError('Failed to create editorial brief');
  }
}
