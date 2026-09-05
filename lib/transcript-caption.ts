import { randomUUID } from 'crypto';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';
import {
  releaseStorageReservation,
  reserveStorageQuota,
  UPLOAD_RESERVATION_PURPOSES,
} from '@/lib/storage-quota';
import {
  serializeWebVtt,
  SUBTITLE_CONTENT_TYPE,
  SUBTITLE_OBJECT_KEY_PREFIX,
  subtitleFileNameToProxyUrl,
  subtitleProxyPathToObjectKey,
} from '@/lib/subtitle-validation';
import { isTranscriptSegmentTimed } from '@/lib/transcript-import';

/**
 * The caption track for a language is derived state: it is rebuilt from the
 * transcript every time the transcript changes, so subtitles and the transcript
 * pane can never drift apart.
 */

const MAX_SUBTITLES_PER_VERSION = 20;

export type CaptionSegment = { startSec: number; endSec: number; text: string };

/**
 * Rebuild the caption track of a version's language from transcript segments.
 * Returns 'skipped' when the version already holds the maximum number of tracks
 * and none is in this language.
 */
export async function syncCaptionTrackFromSegments(input: {
  versionId: string;
  language: string;
  segments: CaptionSegment[];
  billedUserId: string;
  uploadedByUserId: string | null;
}): Promise<'updated' | 'skipped'> {
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
      return 'skipped';
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

    return 'updated';
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

/**
 * The same, from the transcript rows themselves. Returns 'empty' when the
 * transcript has no timed segment.
 */
export async function syncCaptionTrackFromTranscript(input: {
  transcriptId: string;
  billedUserId: string;
  uploadedByUserId: string | null;
}): Promise<'updated' | 'skipped' | 'empty'> {
  const transcript = await db.transcript.findUnique({
    where: { id: input.transcriptId },
    select: {
      versionId: true,
      language: true,
      segments: {
        orderBy: { position: 'asc' },
        select: { startSec: true, endSec: true, text: true },
      },
    },
  });
  if (!transcript) return 'empty';

  const segments = transcript.segments.filter(isTranscriptSegmentTimed);
  if (segments.length === 0) return 'empty';

  return syncCaptionTrackFromSegments({
    versionId: transcript.versionId,
    language: transcript.language,
    segments,
    billedUserId: input.billedUserId,
    uploadedByUserId: input.uploadedByUserId,
  });
}
