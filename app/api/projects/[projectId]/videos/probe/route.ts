import { NextRequest } from 'next/server';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { apiErrors, successResponse } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/logger';

// Re-read metadata from existing originals, including uploads made before parser fixes.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const { projectId } = await params;
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) return apiErrors.notFound('Project');
    if (!(await checkProjectAccess(project, session.user.id)).canEdit)
      return apiErrors.forbidden('Access denied');
    const body = await request.json().catch(() => null);
    if (
      !Array.isArray(body?.videoIds) ||
      body.videoIds.length === 0 ||
      body.videoIds.length > 50 ||
      !body.videoIds.every((id: unknown) => typeof id === 'string' && id.trim())
    ) {
      return apiErrors.badRequest('Select between 1 and 50 clips');
    }
    const ids = [...new Set<string>(body.videoIds)];
    const videos = await db.video.findMany({
      where: { id: { in: ids }, projectId, kind: 'VIDEO' },
      select: {
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
          select: { id: true, providerId: true },
        },
      },
    });
    if (
      videos.length !== ids.length ||
      videos.some((video) => !['r2', 'bunny'].includes(video.versions[0]?.providerId ?? ''))
    )
      return apiErrors.badRequest('Select file-backed video clips from this project');
    const queued = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`probe:${projectId}`}))`;
      let count = 0;
      for (const video of videos) {
        const versionId = video.versions[0]!.id;
        const active = await tx.mediaJob.findFirst({
          where: {
            versionId,
            kind: 'PROBE_MEDIA',
            status: { in: ['PENDING', 'QUEUED', 'RUNNING'] },
          },
        });
        if (active) continue;
        await tx.mediaJob.create({ data: { versionId, kind: 'PROBE_MEDIA' } });
        count += 1;
      }
      return count;
    });
    return successResponse({ queued });
  } catch (error) {
    logError('Failed to queue metadata extraction:', error);
    return apiErrors.internalError('Failed to refresh metadata');
  }
}
