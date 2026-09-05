import { MediaJobKind, Prisma, TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { getTranscriptionProviderName, isTranscriptionFeatureEnabled } from '@/lib/feature-flags';
import { enqueueMediaJob } from '@/lib/media-jobs';
import { canAutoTranscribe, type ReviewKind } from '@/lib/review-kind';
import { AUTO_DETECT_TRANSCRIPT_LANGUAGE } from '@/lib/transcription/language';
import { scheduleVersionTranscription } from '@/lib/transcription/schedule';

export type TranscriptReadiness = {
  /** Versions with a READY transcript. */
  ready: string[];
  /** Versions whose transcript is PENDING or RUNNING, including the ones started here. */
  pending: string[];
  /** Versions this call started a transcription for. */
  enqueued: string[];
  /** Versions that cannot be transcribed on this host. */
  failed: string[];
};

/**
 * Before a cut is assembled, every clip needs a transcript on the way. READY
 * and in-progress rows are left alone. A version with no row, or whose rows
 * all FAILED, gets a fresh PENDING row plus the extract and transcribe jobs,
 * exactly as an upload does, and the inline runner is scheduled for hosts
 * without a media worker. Auto-detect is the language, as on upload.
 */
export async function ensureTranscriptsForVersions(
  versions: Array<{ id: string; providerId: string; kind: ReviewKind }>
): Promise<TranscriptReadiness> {
  const readiness: TranscriptReadiness = { ready: [], pending: [], enqueued: [], failed: [] };
  if (versions.length === 0) return readiness;

  const rows = await db.transcript.findMany({
    where: { versionId: { in: versions.map((version) => version.id) } },
    select: { versionId: true, status: true },
  });
  const byVersion = new Map<string, TranscriptStatus[]>();
  for (const row of rows) {
    const list = byVersion.get(row.versionId) ?? [];
    list.push(row.status);
    byVersion.set(row.versionId, list);
  }

  for (const version of versions) {
    const statuses = byVersion.get(version.id) ?? [];
    if (statuses.includes(TranscriptStatus.READY)) {
      readiness.ready.push(version.id);
      continue;
    }
    if (
      statuses.includes(TranscriptStatus.PENDING) ||
      statuses.includes(TranscriptStatus.RUNNING)
    ) {
      readiness.pending.push(version.id);
      continue;
    }
    if (!isTranscriptionFeatureEnabled() || !canAutoTranscribe(version.kind, version.providerId)) {
      readiness.failed.push(version.id);
      continue;
    }

    const language = AUTO_DETECT_TRANSCRIPT_LANGUAGE;
    const transcript = await db.transcript.upsert({
      where: { versionId_language: { versionId: version.id, language } },
      create: {
        versionId: version.id,
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
    await enqueueMediaJob(version.id, MediaJobKind.EXTRACT_AUDIO);
    await enqueueMediaJob(version.id, MediaJobKind.TRANSCRIBE, {
      language,
      transcriptId: transcript.id,
    });
    scheduleVersionTranscription(version.id, language, transcript.id);
    readiness.enqueued.push(version.id);
    readiness.pending.push(version.id);
  }

  return readiness;
}
