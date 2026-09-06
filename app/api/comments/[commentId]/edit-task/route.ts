import { NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { refuseIfAgentRunLimited } from '@/lib/agents/limit';
import { db } from '@/lib/db';
import { actOnCommentEdit, CommentEditError, listCommentEdits } from '@/lib/comment-edit/store';
import { logError } from '@/lib/logger';
import { editOptionsSchema } from '@/lib/comment-edit/plan';

const bodySchema = z.object({
  action: z.enum(['human', 'queue', 'run', 'accept']),
  options: editOptionsSchema.optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ commentId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;
    const { commentId } = await params;
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return apiErrors.badRequest('Choose human, queue, run, or accept.');
    if (body.data.action === 'run') {
      const comment = await db.comment.findUnique({
        where: { id: commentId },
        select: { versionId: true },
      });
      if (comment) {
        const refusal = await refuseIfAgentRunLimited(session.user.id, comment.versionId);
        if (refusal) return refusal;
      }
    }
    const task = await actOnCommentEdit(
      commentId,
      session.user.id,
      body.data.action,
      body.data.options
    );
    const comment = await db.comment.findUniqueOrThrow({
      where: { id: commentId },
      select: { versionId: true },
    });
    return withCacheControl(
      successResponse({
        task,
        tasks: await listCommentEdits(comment.versionId),
      }),
      'private, no-store'
    );
  } catch (error) {
    if (error instanceof CommentEditError) {
      if (error.status === 403) return apiErrors.forbidden(error.message);
      if (error.status === 404) return apiErrors.notFound('Comment or version');
      if (error.status === 409) return apiErrors.conflict(error.message);
      return apiErrors.badRequest(error.message);
    }
    logError('Comment edit action failed', error);
    return apiErrors.internalError('Could not update the editing task');
  }
}
