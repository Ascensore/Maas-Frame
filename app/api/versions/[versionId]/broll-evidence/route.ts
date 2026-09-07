import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { loadCommentEditAccess, CommentEditError } from '@/lib/comment-edit/store';
import { lockResourceInTransaction } from '@/lib/advisory-lock';
import { rateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/logger';
import { readVideoObjectBytes } from '@/lib/r2';
import { parseBrollEvidence } from '@/lib/rough-cut/broll-evidence-schema';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const { versionId } = await params;
    const version = await loadCommentEditAccess(versionId, session.user.id);
    const index = request.nextUrl.searchParams.get('frame');
    const generation = request.nextUrl.searchParams.get('generation');
    if (!index || !/^[012]$/.test(index) || !generation || !/^[a-zA-Z0-9_-]+$/.test(generation))
      return apiErrors.badRequest('Choose a sampled frame.');
    const evidence = parseBrollEvidence(version.visualEvidence, versionId);
    const frame = evidence?.frames[Number(index)];
    if (version.providerId !== 'r2' || !frame || frame.key.split('/').at(-2) !== generation)
      return apiErrors.notFound('B-roll frame');
    const bytes = await readVideoObjectBytes(frame.key, 262145);
    if (
      !bytes ||
      bytes.length < 4 ||
      bytes.length > 262144 ||
      bytes[0] !== 255 ||
      bytes[1] !== 216 ||
      bytes.at(-2) !== 255 ||
      bytes.at(-1) !== 217
    )
      return apiErrors.notFound('B-roll frame');
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      },
    });
  } catch (error) {
    if (error instanceof CommentEditError)
      return error.status === 403
        ? apiErrors.forbidden(error.message)
        : apiErrors.notFound('Version');
    logError('B-roll preview failed', error);
    return apiErrors.internalError('Could not load B-roll frame');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    const { versionId } = await params;
    const version = await loadCommentEditAccess(versionId, session.user.id);
    if (version.providerId !== 'r2' || !version.isActive || !version.duration)
      return apiErrors.badRequest('Choose an active uploaded video with a known duration.');
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;
    const job = await db.$transaction(async (tx) => {
      await lockResourceInTransaction(tx, 'broll-evidence:' + versionId);
      const existing = await tx.mediaJob.findFirst({
        where: {
          versionId,
          kind: 'ANALYZE_BROLL',
          status: { in: ['PENDING', 'QUEUED', 'RUNNING'] },
        },
      });
      return existing ?? tx.mediaJob.create({ data: { versionId, kind: 'ANALYZE_BROLL' } });
    });
    return withCacheControl(
      successResponse({ job: { id: job.id, status: job.status } }, 202),
      'private, no-store'
    );
  } catch (error) {
    if (error instanceof CommentEditError)
      return error.status === 403
        ? apiErrors.forbidden(error.message)
        : apiErrors.notFound('Version');
    logError('B-roll analysis failed', error);
    return apiErrors.internalError('Could not queue B-roll analysis');
  }
}
