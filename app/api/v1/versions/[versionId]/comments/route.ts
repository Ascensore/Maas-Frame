import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isAuthError, loadVersionForUser, withApiAuth } from '@/lib/v1-auth';
import { deriveTimestampFrame } from '@/lib/timecode';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ versionId: string }> };

const COMMENT_SELECT = {
  id: true,
  content: true,
  timestamp: true,
  timestampEnd: true,
  timestampFrame: true,
  isResolved: true,
  resolvedAt: true,
  parentId: true,
  authorId: true,
  guestName: true,
  tagId: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true } },
  tag: { select: { id: true, name: true, color: true } },
} as const;

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'api-v1');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;

    const { versionId } = await params;
    const loaded = await loadVersionForUser(versionId, authContext.userId);
    if ('error' in loaded) return loaded.error;

    const { searchParams } = new URL(request.url);
    const includeResolved = searchParams.get('includeResolved') !== 'false';
    const updatedSinceRaw = searchParams.get('updatedSince');
    let updatedSince: Date | null = null;
    if (updatedSinceRaw) {
      const parsed = new Date(updatedSinceRaw);
      if (Number.isNaN(parsed.getTime())) {
        return apiErrors.badRequest('updatedSince must be an ISO-8601 timestamp');
      }
      updatedSince = parsed;
    }

    const comments = await db.comment.findMany({
      where: {
        versionId,
        ...(includeResolved ? {} : { isResolved: false }),
        ...(updatedSince ? { updatedAt: { gte: updatedSince } } : {}),
      },
      orderBy: { timestamp: 'asc' },
      take: 5000,
      select: COMMENT_SELECT,
    });

    return withCacheControl(successResponse({ comments }), 'private, no-store');
  } catch (error) {
    logError('Error listing v1 comments:', error);
    return apiErrors.internalError('Failed to list comments');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'comment');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;

    const { versionId } = await params;
    const loaded = await loadVersionForUser(versionId, authContext.userId);
    if ('error' in loaded) return loaded.error;

    const body = await request.json().catch(() => null);
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    const timestamp =
      typeof body?.timestamp === 'number' ? body.timestamp : Number(body?.timestamp);
    const timestampEndRaw = body?.timestampEnd;
    const timestampEnd =
      timestampEndRaw === null || timestampEndRaw === undefined
        ? null
        : typeof timestampEndRaw === 'number'
          ? timestampEndRaw
          : Number(timestampEndRaw);

    if (!Number.isFinite(timestamp) || timestamp < 0) {
      return apiErrors.badRequest('timestamp is required and must be a non-negative number');
    }
    if (timestampEnd !== null && (!Number.isFinite(timestampEnd) || timestampEnd < timestamp)) {
      return apiErrors.badRequest('timestampEnd must be greater than or equal to timestamp');
    }
    if (!content) {
      return apiErrors.badRequest('content is required');
    }

    const version = loaded.version;
    const comment = await db.comment.create({
      data: {
        content,
        timestamp,
        timestampEnd,
        timestampFrame: deriveTimestampFrame(timestamp, version.frameRateNum, version.frameRateDen),
        versionId,
        authorId: authContext.userId,
      },
      select: COMMENT_SELECT,
    });

    return withCacheControl(successResponse({ comment }, 201), 'private, no-store');
  } catch (error) {
    logError('Error creating v1 comment:', error);
    return apiErrors.internalError('Failed to create comment');
  }
}
