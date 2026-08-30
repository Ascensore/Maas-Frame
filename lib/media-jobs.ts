import { MediaJobKind, type Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { isTranscriptionFeatureEnabled } from '@/lib/feature-flags';
import { shouldEnqueueProbe, shouldEnqueueTranscribe } from '@/lib/review-kind';
import type { ReviewKind } from '@/lib/review-kind';

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
 * Queue probe (file-backed VIDEO and AUDIO) and transcription (VIDEO only,
 * when enabled). Stills and PDFs skip both. YouTube/Vimeo skip probe.
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
    await enqueueMediaJob(versionId, MediaJobKind.EXTRACT_AUDIO);
    await enqueueMediaJob(versionId, MediaJobKind.TRANSCRIBE);
  }
}
