import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { generateApiToken } from '@/lib/api-token';
import { logError } from '@/lib/logger';

const MAX_TOKENS_PER_USER = 20;
const MAX_NAME_LENGTH = 60;

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const tokens = await db.apiToken.findMany({
      where: { userId: session.user.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    return withCacheControl(successResponse({ tokens }), 'private, no-store');
  } catch (error) {
    logError('Error listing API tokens:', error);
    return apiErrors.internalError('Failed to list API tokens');
  }
}

export async function POST(request: NextRequest) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const body = await request.json().catch(() => null);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
      return apiErrors.badRequest(
        `Name is required and must be at most ${MAX_NAME_LENGTH} characters`
      );
    }

    const existing = await db.apiToken.count({
      where: { userId: session.user.id, revokedAt: null },
    });
    if (existing >= MAX_TOKENS_PER_USER) {
      return apiErrors.badRequest(`At most ${MAX_TOKENS_PER_USER} active tokens per user`);
    }

    const generated = generateApiToken();
    const row = await db.apiToken.create({
      data: {
        userId: session.user.id,
        name,
        tokenHash: generated.hash,
        tokenPrefix: generated.prefix,
      },
      select: { id: true, name: true, tokenPrefix: true, createdAt: true },
    });

    return withCacheControl(
      successResponse({ token: { ...row, secret: generated.raw } }, 201),
      'private, no-store'
    );
  } catch (error) {
    logError('Error creating API token:', error);
    return apiErrors.internalError('Failed to create API token');
  }
}
