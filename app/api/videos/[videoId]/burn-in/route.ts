import { NextRequest } from 'next/server';
import { MediaJobKind, MediaJobStatus, TranscriptStatus, type Prisma } from '@prisma/client';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import type { BurnInPayload, BurnInSource } from '@/lib/rough-cut/burn-in-job';
import { isFileBackedProvider } from '@/lib/rough-cut/load';
import { parseBurnInStyle } from '@/lib/rough-cut/subtitle-style';
import { normalizeSubtitleLanguage } from '@/lib/subtitle-validation';
import { getVideoAssetAccessContext } from '@/lib/video-assets';

type RouteParams = { params: Promise<{ videoId: string }> };

/** A burn-in that has not finished yet, so a second one would race it. */
const ACTIVE_JOB: MediaJobStatus[] = [
  MediaJobStatus.PENDING,
  MediaJobStatus.QUEUED,
  MediaJobStatus.RUNNING,
];

function shapeJob(job: {
  id: string;
  status: MediaJobStatus;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}) {
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

/**
 * GET /api/videos/[videoId]/burn-in?versionId=… — the latest burn-in of one version.
 *
 * The pane polls this while a render is in flight, so it answers with the newest attempt
 * rather than a list: an earlier failure is history, and what the operator is waiting on
 * is the last thing they asked for.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'subtitle-list');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'VIEW');
    if (!context) return apiErrors.notFound('Video');
    // The same editor gate the subtitle upload uses. A burned-in caption is part of the
    // delivered cut, so guests and share-link viewers see nothing here.
    if (!context.viewerUserId || !context.canManageAssets) {
      return apiErrors.forbidden('Access denied');
    }

    const versionId = request.nextUrl.searchParams.get('versionId')?.trim();
    if (!versionId) return apiErrors.badRequest('versionId is required');

    const job = await db.mediaJob.findFirst({
      // Scoped through the version's parent video: a version id from another video
      // is answered as "no job", never with somebody else's render state.
      where: {
        versionId,
        kind: MediaJobKind.BURN_SUBTITLES,
        version: { videoParentId: videoId },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, error: true, createdAt: true, finishedAt: true },
    });

    return withCacheControl(
      successResponse({ job: job ? shapeJob(job) : null }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error loading the burn-in job:', error);
    return apiErrors.internalError('Failed to load the burn-in job');
  }
}

/**
 * POST /api/videos/[videoId]/burn-in — burn this version's words into the picture.
 *
 * The work is a media job, so this answers 202 and the caller polls the GET above. The
 * source is resolved here rather than in the worker: `subtitleId` names a caption track,
 * `language` names a transcript, and without either the version's oldest READY transcript
 * wins, falling back to a caption track when nothing has been transcribed. Every one of
 * those rows is checked to belong to this version before its id goes into a payload.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'VIEW');
    if (!context) return apiErrors.notFound('Video');
    if (!context.viewerUserId || !context.canManageAssets) {
      return apiErrors.forbidden('Access denied');
    }
    const requestedById = context.viewerUserId;

    const body = await request.json().catch(() => null);
    const versionId = typeof body?.versionId === 'string' ? body.versionId.trim() : '';
    if (!versionId) return apiErrors.badRequest('versionId is required');

    const style = parseBurnInStyle(body?.style);
    if (!style.ok) return apiErrors.badRequest(style.error);

    const requestedLanguage = body?.language;
    let language: string | null = null;
    if (requestedLanguage !== undefined && requestedLanguage !== null && requestedLanguage !== '') {
      language = normalizeSubtitleLanguage(requestedLanguage);
      if (!language) {
        return apiErrors.badRequest('language must be a BCP-47 tag such as "tr" or "en-US"');
      }
    }

    const version = await db.videoVersion.findFirst({
      where: { id: versionId, videoParentId: videoId },
      select: { id: true, providerId: true, video: { select: { kind: true } } },
    });
    if (!version) return apiErrors.notFound('Version');
    // A YouTube or Vimeo version has no master to re-encode, and a still or a deck has no
    // picture to burn anything into. Refused here rather than inside ffmpeg's temp
    // directory ten minutes later.
    if (version.video.kind !== 'VIDEO' || !isFileBackedProvider(version.providerId)) {
      return apiErrors.badRequest('Subtitles can only be burned into an uploaded video file');
    }

    const source = await resolveSource(versionId, body?.subtitleId, language);
    if ('error' in source) return source.error;

    const payload: BurnInPayload = {
      style: style.value,
      source: source.value,
      requestedById,
    };

    // Checking for a burn already in flight and queueing one has to be a single step, or
    // two clicks a moment apart both see an idle version and queue a job each, and the two
    // renders then race for the output video's next version number. The lock is per
    // version, so burns of different versions never wait on each other. Reading after
    // taking the lock only sees the other click's job under READ COMMITTED, which is this
    // database's default; under SERIALIZABLE the snapshot would predate the lock and both
    // callers would queue.
    const job = await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          ('x' || left(md5(${versionId}), 16))::bit(64)::bigint
        )
      `;
      const active = await tx.mediaJob.findFirst({
        where: { versionId, kind: MediaJobKind.BURN_SUBTITLES, status: { in: ACTIVE_JOB } },
        select: { id: true },
      });
      if (active) return null;
      // Created here rather than through enqueueMediaJob so the insert shares the
      // transaction that holds the lock.
      return tx.mediaJob.create({
        data: {
          versionId,
          kind: MediaJobKind.BURN_SUBTITLES,
          payload: payload as unknown as Prisma.InputJsonValue,
        },
        select: { id: true, status: true },
      });
    });
    if (!job) return apiErrors.conflict('A burn-in is already running for this version');

    return withCacheControl(
      successResponse({ job: { id: job.id, status: job.status } }, 202),
      'private, no-store'
    );
  } catch (error) {
    logError('Error queueing a burn-in:', error);
    return apiErrors.internalError('Failed to start the burn-in');
  }
}

/** The words to burn, or the refusal to send back instead. */
async function resolveSource(
  versionId: string,
  requestedSubtitleId: unknown,
  language: string | null
): Promise<{ value: BurnInSource } | { error: Response }> {
  const subtitleId = typeof requestedSubtitleId === 'string' ? requestedSubtitleId.trim() : '';

  if (subtitleId) {
    const track = await db.videoSubtitle.findFirst({
      where: { id: subtitleId, versionId },
      select: { id: true },
    });
    if (!track) return { error: apiErrors.notFound('Subtitle track') };
    return { value: { kind: 'subtitle', subtitleId: track.id } };
  }

  if (language) {
    const transcript = await db.transcript.findUnique({
      where: { versionId_language: { versionId, language } },
      select: { id: true, status: true },
    });
    // An explicit language never falls back: burning the wrong language into the picture
    // is worse than refusing to burn anything.
    if (!transcript || transcript.status !== TranscriptStatus.READY) {
      return { error: apiErrors.badRequest('No ready transcript in that language') };
    }
    return { value: { kind: 'transcript', transcriptId: transcript.id } };
  }

  // The oldest READY transcript, which is the one the job itself resolves a null
  // transcriptId to, so the two cannot pick different words.
  const transcript = await db.transcript.findFirst({
    where: { versionId, status: TranscriptStatus.READY },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (transcript) return { value: { kind: 'transcript', transcriptId: transcript.id } };

  const track = await db.videoSubtitle.findFirst({
    where: { versionId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (track) return { value: { kind: 'subtitle', subtitleId: track.id } };

  return {
    error: apiErrors.badRequest('This version has no transcript or caption track to burn in'),
  };
}
