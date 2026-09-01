import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, computeProjectAccess, projectAccessInclude } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { validateShareLinkAccess } from '@/lib/share-links';
import { logError } from '@/lib/logger';

export { POST } from '@/app/api/v1/versions/[versionId]/transcript/route';

type RouteParams = { params: Promise<{ versionId: string }> };

function shapeTranscript(transcript: {
  id: string;
  versionId: string;
  language: string;
  provider: string;
  status: string;
  segments: Array<{
    id: string;
    startSec: number;
    endSec: number;
    speaker: string | null;
    text: string;
    words: unknown;
    position: number;
  }>;
}) {
  return {
    id: transcript.id,
    versionId: transcript.versionId,
    language: transcript.language,
    provider: transcript.provider,
    status: transcript.status,
    segments: transcript.segments.map((segment) => ({
      id: segment.id,
      startSec: segment.startSec,
      endSec: segment.endSec,
      speaker: segment.speaker,
      text: segment.text,
      words: segment.words,
      position: segment.position,
    })),
  };
}

// GET /api/versions/[versionId]/transcript
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'transcript-read');
    if (limited) return limited;

    const session = await auth();
    const { versionId } = await params;
    const userId = session?.user?.id;

    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      include: {
        video: {
          include: {
            project: { include: projectAccessInclude(userId) },
          },
        },
      },
    });

    if (!version) {
      return apiErrors.notFound('Version');
    }

    const project = version.video.project;
    const access = computeProjectAccess(project, userId);
    const shareSession = getShareSessionFromRequest(request, version.video.id);
    const shareAccess = shareSession
      ? await validateShareLinkAccess({
          token: shareSession.token,
          projectId: project.id,
          videoId: version.video.id,
          requiredPermission: 'VIEW',
          passwordVerified: shareSession.passwordVerified,
        })
      : { hasAccess: false, requiresPassword: false };

    if (!access.hasAccess && !shareAccess.hasAccess) {
      return apiErrors.forbidden('Access denied');
    }

    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim() ?? '';

    const transcript = await db.transcript.findFirst({
      where: { versionId },
      orderBy: { createdAt: 'desc' },
      include: {
        segments: { orderBy: { position: 'asc' } },
      },
    });

    if (!transcript) {
      return withCacheControl(successResponse({ transcript: null }), 'private, no-store');
    }

    const segments = q
      ? transcript.segments.filter((segment) =>
          segment.text.toLowerCase().includes(q.toLowerCase())
        )
      : transcript.segments;

    return withCacheControl(
      successResponse({
        transcript: shapeTranscript({ ...transcript, segments }),
      }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error fetching transcript:', error);
    return apiErrors.internalError('Failed to fetch transcript');
  }
}
