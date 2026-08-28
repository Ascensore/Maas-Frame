import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import {
  FOLDER_DEPTH_MAX,
  depthAfterRelocate,
  parseFolderName,
  wouldCreateCycle,
} from '@/lib/folders';

type RouteParams = { params: Promise<{ projectId: string; folderId: string }> };

function shape(folder: {
  id: string;
  name: string;
  position: number;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: folder.id,
    name: folder.name,
    position: folder.position,
    parentId: folder.parentId,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { projectId, folderId } = await params;
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) return apiErrors.notFound('Project');

    const access = await checkProjectAccess(project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const folder = await db.folder.findFirst({
      where: { id: folderId, projectId },
    });
    if (!folder) return apiErrors.notFound('Folder');

    const body = await request.json().catch(() => null);
    const data: { name?: string; parentId?: string | null; position?: number } = {};

    if (body?.name !== undefined) {
      const name = parseFolderName(body.name);
      if (!name) return apiErrors.badRequest('name is required and must be at most 100 characters');
      data.name = name;
    }

    if (body && Object.prototype.hasOwnProperty.call(body, 'parentId')) {
      if (body.parentId !== null && typeof body.parentId !== 'string') {
        return apiErrors.badRequest('parentId must be a folder id or null');
      }
      const parentId = body.parentId as string | null;
      if (parentId) {
        const parent = await db.folder.findFirst({
          where: { id: parentId, projectId },
          select: { id: true },
        });
        if (!parent) return apiErrors.badRequest('parent folder was not found in this project');
      }
      const siblings = await db.folder.findMany({
        where: { projectId },
        select: { id: true, parentId: true },
      });
      if (wouldCreateCycle(folderId, parentId, siblings)) {
        return apiErrors.badRequest('A folder cannot be moved under itself');
      }
      if (depthAfterRelocate(folderId, parentId, siblings) > FOLDER_DEPTH_MAX) {
        return apiErrors.badRequest('Folder nesting cannot exceed 32 levels');
      }
      data.parentId = parentId;
    }

    if (
      body?.position !== undefined &&
      (typeof body.position !== 'number' || !Number.isInteger(body.position) || body.position < 0)
    ) {
      return apiErrors.badRequest('position must be a non-negative integer');
    }
    if (typeof body?.position === 'number') data.position = body.position;

    if (Object.keys(data).length === 0) {
      return apiErrors.badRequest('Provide name, parentId, and/or position');
    }

    const updated = await db.folder.update({
      where: { id: folderId },
      data,
    });

    return withCacheControl(successResponse({ folder: shape(updated) }), 'private, no-store');
  } catch (error) {
    logError('Error updating folder:', error);
    return apiErrors.internalError('Failed to update folder');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { projectId, folderId } = await params;
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) return apiErrors.notFound('Project');

    const access = await checkProjectAccess(project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const folder = await db.folder.findFirst({
      where: { id: folderId, projectId },
      select: { id: true },
    });
    if (!folder) return apiErrors.notFound('Folder');

    await db.folder.delete({ where: { id: folderId } });

    return withCacheControl(successResponse({ deleted: true }), 'private, no-store');
  } catch (error) {
    logError('Error deleting folder:', error);
    return apiErrors.internalError('Failed to delete folder');
  }
}
