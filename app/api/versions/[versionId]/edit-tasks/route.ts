import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  CommentEditError,
  listCommentEdits,
  loadCommentEditAccess,
  runCommentEditBatch,
} from '@/lib/comment-edit/store';
import { logError } from '@/lib/logger';
import { editLibrary } from '@/lib/comment-edit/library';
import { z } from 'zod';
import { rateLimit } from '@/lib/rate-limit';
import { refuseIfAgentRunLimited } from '@/lib/agents/limit';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const { versionId } = await params;
    await loadCommentEditAccess(versionId, session.user.id);
    const limited =
      (await rateLimit(request, 'mutate')) ??
      (await refuseIfAgentRunLimited(session.user.id, versionId));
    if (limited) return limited;
    const body = z
      .object({ commentIds: z.array(z.string().min(1)).min(2).max(20) })
      .safeParse(await request.json().catch(() => null));
    if (!body.success) return apiErrors.badRequest('Choose between 2 and 20 queued comments.');
    return withCacheControl(
      successResponse({
        tasks: await runCommentEditBatch(versionId, session.user.id, body.data.commentIds),
      }),
      'private, no-store'
    );
  } catch (error) {
    if (error instanceof CommentEditError) {
      if (error.status === 403) return apiErrors.forbidden(error.message);
      if (error.status === 404) return apiErrors.notFound('Version');
      if (error.status === 409) return apiErrors.conflict(error.message);
      return apiErrors.badRequest(error.message);
    }
    logError('Comment batch failed', error);
    return apiErrors.internalError('Could not run the comment batch');
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const { versionId } = await params;
    const version = await loadCommentEditAccess(versionId, session.user.id);
    return withCacheControl(
      successResponse({
        tasks: await listCommentEdits(versionId),
        library: await editLibrary(version.video.projectId),
      }),
      'private, no-store'
    );
  } catch (error) {
    if (error instanceof CommentEditError)
      return error.status === 403
        ? apiErrors.forbidden(error.message)
        : apiErrors.notFound('Version');
    logError('Comment edit listing failed', error);
    return apiErrors.internalError('Could not load editing tasks');
  }
}
