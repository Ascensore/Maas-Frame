import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  CommentEditError,
  listCommentEdits,
  loadCommentEditAccess,
} from '@/lib/comment-edit/store';
import { logError } from '@/lib/logger';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const { versionId } = await params;
    await loadCommentEditAccess(versionId, session.user.id);
    return withCacheControl(
      successResponse({ tasks: await listCommentEdits(versionId) }),
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
