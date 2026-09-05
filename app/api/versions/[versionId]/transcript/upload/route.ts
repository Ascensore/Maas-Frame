import { NextRequest } from 'next/server';
import { TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { normalizeSubtitleLanguage } from '@/lib/subtitle-validation';
import { syncCaptionTrackFromSegments } from '@/lib/transcript-caption';
import {
  importTranscriptFile,
  MAX_TRANSCRIPT_FILE_SIZE,
  TRANSCRIPT_UPLOAD_PROVIDER,
  type TranscriptImportSegment,
} from '@/lib/transcript-import';

type RouteParams = { params: Promise<{ versionId: string }> };

const MAX_MULTIPART_BODY_SIZE = MAX_TRANSCRIPT_FILE_SIZE + 64 * 1024;

function shapeTranscript(
  transcript: {
    id: string;
    versionId: string;
    language: string;
    provider: string;
    status: string;
  },
  segments: TranscriptImportSegment[]
) {
  return {
    id: transcript.id,
    versionId: transcript.versionId,
    language: transcript.language,
    provider: transcript.provider,
    status: transcript.status,
    segments: segments.map((segment, position) => ({
      startSec: segment.startSec,
      endSec: segment.endSec,
      speaker: null,
      text: segment.text,
      words: segment.words,
      position,
    })),
  };
}

// POST /api/versions/[versionId]/transcript/upload
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'transcript-upload');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { versionId } = await params;
    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      include: {
        video: {
          include: {
            project: {
              select: {
                id: true,
                ownerId: true,
                workspaceId: true,
                visibility: true,
                workspace: { select: { ownerId: true } },
              },
            },
          },
        },
      },
    });
    if (!version) return apiErrors.notFound('Version');

    const access = await checkProjectAccess(version.video.project, session.user.id);
    if (!access.hasAccess) return apiErrors.forbidden('Access denied');
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const contentLength = request.headers.get('content-length');
    if (contentLength) {
      const bodySize = Number.parseInt(contentLength, 10);
      if (!Number.isFinite(bodySize) || bodySize <= 0) {
        return apiErrors.badRequest('Invalid Content-Length header');
      }
      if (bodySize > MAX_MULTIPART_BODY_SIZE) {
        return apiErrors.badRequest('Transcript file is too large. Maximum size is 2MB.');
      }
    }

    const formData = await request.formData();
    const files = formData.getAll('transcript');
    if (files.length !== 1 || !(files[0] instanceof File)) {
      return apiErrors.badRequest('No transcript file provided');
    }
    const file = files[0];
    if (file.size > MAX_TRANSCRIPT_FILE_SIZE) {
      return apiErrors.badRequest('Transcript file is too large. Maximum size is 2MB.');
    }

    const languageValue = formData.get('language');
    const language =
      languageValue == null || languageValue === ''
        ? 'en'
        : normalizeSubtitleLanguage(languageValue);
    if (!language) {
      return apiErrors.badRequest('language must be a BCP-47 tag such as "tr" or "en-US"');
    }

    const imported = await importTranscriptFile({
      fileName: file.name,
      buffer: new Uint8Array(await file.arrayBuffer()),
    });
    if (!imported.ok) {
      return apiErrors.badRequest(imported.error);
    }

    const searchText = imported.segments.map((segment) => segment.text).join(' ');

    const transcript = await db.$transaction(async (tx) => {
      const row = await tx.transcript.upsert({
        where: { versionId_language: { versionId, language } },
        create: {
          versionId,
          language,
          provider: TRANSCRIPT_UPLOAD_PROVIDER,
          status: TranscriptStatus.READY,
          searchText,
        },
        update: {
          provider: TRANSCRIPT_UPLOAD_PROVIDER,
          status: TranscriptStatus.READY,
          searchText,
          error: null,
        },
      });
      await tx.transcriptSegment.deleteMany({ where: { transcriptId: row.id } });
      await tx.transcriptSegment.createMany({
        data: imported.segments.map((segment, position) => ({
          transcriptId: row.id,
          startSec: segment.startSec,
          endSec: segment.endSec,
          text: segment.text,
          words: segment.words,
          position,
        })),
      });
      return row;
    });

    if (imported.timed) {
      try {
        await syncCaptionTrackFromSegments({
          versionId,
          language,
          segments: imported.segments,
          billedUserId: version.video.project.workspace.ownerId,
          uploadedByUserId: session.user.id,
        });
      } catch (captionError) {
        if (captionError instanceof Error && captionError.message === 'storage-quota') {
          logError('Transcript caption skipped: storage quota exceeded', captionError);
        } else {
          logError('Failed to upsert caption track for uploaded transcript:', captionError);
        }
      }
    }

    return withCacheControl(
      successResponse(
        {
          transcript: shapeTranscript(transcript, imported.segments),
        },
        201
      ),
      'private, no-store'
    );
  } catch (error) {
    logError('Error uploading transcript:', error);
    return apiErrors.internalError('Failed to upload transcript');
  }
}
