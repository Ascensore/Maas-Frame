import { MediaJobKind, Prisma, TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { getTranscriptionProviderName, isTranscriptionFeatureEnabled } from '@/lib/feature-flags';
import { shouldEnqueueProbe, shouldEnqueueTranscribe, type ReviewKind } from '@/lib/review-kind';
import { AUTO_DETECT_TRANSCRIPT_LANGUAGE } from '@/lib/transcription/language';
import { scheduleVersionTranscription } from '@/lib/transcription/schedule';

export async function enqueueMediaJob(
  versionId: string,
  kind: MediaJobKind,
  payload?: Prisma.InputJsonValue
): Promise<string> {
  const job = await db.mediaJob.create({
    data: {
      versionId,
      kind,
      payload: payload ?? undefined,
    },
    select: { id: true },
  });
  return job.id;
}

/**
 * Queue probe (file-backed VIDEO and AUDIO) and transcription (file-backed
 * VIDEO and AUDIO, when enabled). Stills and PDFs skip both. YouTube/Vimeo
 * skip probe and STT.
 */
export async function enqueueJobsForNewVersion(options: {
  versionId: string;
  providerId: string;
  kind?: ReviewKind;
}): Promise<void> {
  const { versionId, providerId } = options;
  const kind = options.kind ?? 'VIDEO';

  if (shouldEnqueueProbe(kind, providerId)) {
    await enqueueMediaJob(versionId, MediaJobKind.PROBE_MEDIA);
  }

  if (shouldEnqueueTranscribe(kind, providerId, isTranscriptionFeatureEnabled())) {
    const language = AUTO_DETECT_TRANSCRIPT_LANGUAGE;
    const transcript = await db.transcript.upsert({
      where: { versionId_language: { versionId, language } },
      create: {
        versionId,
        language,
        provider: getTranscriptionProviderName(),
        status: TranscriptStatus.PENDING,
      },
      update: {
        status: TranscriptStatus.PENDING,
        error: null,
        provider: getTranscriptionProviderName(),
        translationLanguage: null,
        translationStatus: null,
        translationError: null,
        translatedTexts: Prisma.DbNull,
      },
    });
    await enqueueMediaJob(versionId, MediaJobKind.EXTRACT_AUDIO);
    await enqueueMediaJob(versionId, MediaJobKind.TRANSCRIBE, {
      language,
      transcriptId: transcript.id,
    });
    scheduleVersionTranscription(versionId, language, transcript.id);
  }
}
