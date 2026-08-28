import { MediaJobKind, type Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { isTranscriptionFeatureEnabled } from '@/lib/feature-flags';

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
 * Queue probe (always, for file-backed versions) and transcription (when
 * enabled). YouTube/Vimeo versions have no file we can ffprobe, so they skip
 * probe and only transcribe if a later extract step can obtain audio.
 */
export async function enqueueJobsForNewVersion(options: {
  versionId: string;
  providerId: string;
}): Promise<void> {
  const { versionId, providerId } = options;
  const fileBacked = providerId === 'r2' || providerId === 'bunny';

  if (fileBacked) {
    await enqueueMediaJob(versionId, MediaJobKind.PROBE_MEDIA);
  }

  if (isTranscriptionFeatureEnabled() && fileBacked) {
    await enqueueMediaJob(versionId, MediaJobKind.EXTRACT_AUDIO);
    await enqueueMediaJob(versionId, MediaJobKind.TRANSCRIBE);
  }
}
