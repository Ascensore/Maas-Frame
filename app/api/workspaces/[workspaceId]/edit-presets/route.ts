import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { auth, checkWorkspaceAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { lockResourceInTransaction } from '@/lib/advisory-lock';
import { presetDefinitionSchema, shapeEditPreset } from '@/lib/comment-edit/presets';
import { logError } from '@/lib/logger';
type Params = { params: Promise<{ workspaceId: string }> };
const identity = z.object({ id: z.string().min(1), revision: z.number().int().positive() });
async function mutate(request: NextRequest, { params }: Params) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const { workspaceId } = await params;
    const workspace = await db.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) return apiErrors.notFound('Workspace');
    const access = await checkWorkspaceAccess(workspace, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Workspace editing permission is required');
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;
    const body = await request.json().catch(() => null);
    const definition = presetDefinitionSchema.safeParse(body);
    const key = identity.safeParse(body);
    if (
      (request.method !== 'DELETE' && !definition.success) ||
      (request.method !== 'POST' && !key.success)
    )
      return apiErrors.badRequest('Enter valid preset settings and the current revision.');
    return await db.$transaction(async (tx) => {
      await lockResourceInTransaction(tx, 'edit-presets:' + workspaceId);
      if (request.method === 'POST') {
        if ((await tx.editPreset.count({ where: { workspaceId, archived: false } })) >= 50)
          return apiErrors.conflict('Archive an unused preset before adding more than 50.');
        const row = await tx.editPreset.create({
          data: { workspaceId, name: definition.data!.name, definition: definition.data! },
        });
        return withCacheControl(
          successResponse({ preset: shapeEditPreset(row) }, 201),
          'private, no-store'
        );
      }
      const changed = await tx.editPreset.updateMany({
        where: { workspaceId, id: key.data!.id, revision: key.data!.revision, archived: false },
        data:
          request.method === 'DELETE'
            ? { archived: true, revision: { increment: 1 } }
            : {
                name: definition.data!.name,
                definition: definition.data!,
                revision: { increment: 1 },
              },
      });
      if (!changed.count)
        return apiErrors.conflict(
          'The preset changed or is unavailable. Refresh before trying again.'
        );
      const row = await tx.editPreset.findUniqueOrThrow({ where: { id: key.data!.id } });
      return withCacheControl(
        successResponse({ preset: shapeEditPreset(row), archived: row.archived }),
        'private, no-store'
      );
    });
  } catch (error) {
    logError('Edit preset update failed', error);
    return apiErrors.internalError('Could not save the preset');
  }
}
export const POST = mutate;
export const PATCH = mutate;
export const DELETE = mutate;
