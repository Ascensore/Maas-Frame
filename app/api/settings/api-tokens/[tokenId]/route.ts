import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ tokenId: string }> };

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { tokenId } = await params;
    const updated = await db.apiToken.updateMany({
      where: { id: tokenId, userId: session.user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (updated.count !== 1) {
      return apiErrors.notFound('API token');
    }

    return withCacheControl(successResponse({ ok: true }), 'private, no-store');
  } catch (error) {
    logError('Error revoking API token:', error);
    return apiErrors.internalError('Failed to revoke API token');
  }
}
