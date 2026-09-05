import { TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { isTranscriptionFeatureEnabled } from '@/lib/feature-flags';
import { startVersionTranscription } from '@/lib/media-jobs';
import { canAutoTranscribe, type ReviewKind } from '@/lib/review-kind';

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
 * Queue the transcription a cut needs at the moment the cut is requested.
 *
 * This does not make a rough cut possible on a host without a media worker.
 * Video is transcribed only by the worker's EXTRACT_AUDIO/TRANSCRIBE jobs —
 * the inline runner behind `scheduleVersionTranscription` handles AUDIO alone
 * (`canRunInlineTranscription` in lib/transcription/source.ts) — and only the
 * worker runs ASSEMBLE_ROUGH_CUT at all. What this buys is timing: the jobs
 * are waiting for the worker from the request rather than from the run's
 * first assemble attempt, and the run carries its waiting warning
 * immediately instead of after a round trip through the assembler.
 *
 * READY and in-progress rows are left alone. A version with no row, or whose
 * rows all FAILED, gets a fresh PENDING row and the jobs, through the same
 * `startVersionTranscription` an upload uses.
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

    await startVersionTranscription(version.id);
    readiness.enqueued.push(version.id);
    readiness.pending.push(version.id);
  }

  return readiness;
}
