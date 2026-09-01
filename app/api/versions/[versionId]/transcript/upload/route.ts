import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import {
  releaseStorageReservation,
  reserveStorageQuota,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
import {
  normalizeSubtitleLanguage,
  serializeWebVtt,
  SUBTITLE_CONTENT_TYPE,
  SUBTITLE_OBJECT_KEY_PREFIX,
  subtitleFileNameToProxyUrl,
  subtitleProxyPathToObjectKey,
} from '@/lib/subtitle-validation';
import {
  importTranscriptFile,
  MAX_TRANSCRIPT_FILE_SIZE,
  TRANSCRIPT_UPLOAD_PROVIDER,
  type TranscriptImportSegment,
} from '@/lib/transcript-import';

type RouteParams = { params: Promise<{ versionId: string }> };

const MAX_MULTIPART_BODY_SIZE = MAX_TRANSCRIPT_FILE_SIZE + 64 * 1024;
const MAX_SUBTITLES_PER_VERSION = 20;

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

async function upsertCaptionTrack(input: {
  versionId: string;
  language: string;
  segments: TranscriptImportSegment[];
  billedUserId: string;
  uploadedByUserId: string;
}): Promise<void> {
  const vtt = serializeWebVtt(
    input.segments.map((segment) => ({
      start: segment.startSec,
      end: segment.endSec,
      text: segment.text,
    }))
  );
  const body = Buffer.from(vtt, 'utf8');
  const sizeBytes = BigInt(body.byteLength);

  const existing = await db.videoSubtitle.findUnique({
    where: { versionId_language: { versionId: input.versionId, language: input.language } },
    select: { id: true, sourceUrl: true },
  });

  if (!existing) {
    const trackCount = await db.videoSubtitle.count({ where: { versionId: input.versionId } });
    if (trackCount >= MAX_SUBTITLES_PER_VERSION) {
      return;
    }
  }

  const reserveResult = await reserveStorageQuota(
    input.billedUserId,
    sizeBytes,
    UPLOAD_RESERVATION_PURPOSES.SUBTITLE
  );
  if ('error' in reserveResult) {
    throw new Error('storage-quota');
  }

  const fileName = `${randomUUID()}.vtt`;
  const objectKey = `${SUBTITLE_OBJECT_KEY_PREFIX}${fileName}`;
  let stored = false;
  try {
    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: objectKey,
        Body: body,
        ContentType: SUBTITLE_CONTENT_TYPE,
      })
    );
    stored = true;

    await db.$transaction(async (tx) => {
      if (existing) {
        await tx.videoSubtitle.delete({ where: { id: existing.id } });
      }
      await tx.videoSubtitle.create({
        data: {
          versionId: input.versionId,
          language: input.language,
          label: `Transcript (${input.language})`,
          sourceUrl: subtitleFileNameToProxyUrl(fileName),
          sizeBytes,
          billedUserId: input.billedUserId,
          uploadedByUserId: input.uploadedByUserId,
        },
      });
    });

    await releaseStorageReservation(
      reserveResult.reservationId,
      input.billedUserId,
      UPLOAD_RESERVATION_PURPOSES.SUBTITLE
    );

    if (existing) {
      const staleKey = subtitleProxyPathToObjectKey(existing.sourceUrl);
      if (staleKey) {
        try {
          await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: staleKey }));
        } catch (deleteError) {
          logError('Failed to delete replaced transcript caption object:', deleteError);
        }
      }
    }
  } catch (error) {
    if (stored) {
      try {
        await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: objectKey }));
      } catch (cleanupError) {
        logError('Failed to clean up transcript caption object:', cleanupError);
      }
    }
    await releaseStorageReservation(
      reserveResult.reservationId,
      input.billedUserId,
      UPLOAD_RESERVATION_PURPOSES.SUBTITLE
    );
    throw error;
  }
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
        await upsertCaptionTrack({
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
