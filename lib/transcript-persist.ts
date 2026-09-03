import { Prisma, TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import type { TranscriptImportSegment } from '@/lib/transcript-import';

export async function saveReadyTranscript(input: {
  versionId: string;
  language: string;
  provider: string;
  segments: TranscriptImportSegment[];
}) {
  const searchText = input.segments.map((segment) => segment.text).join(' ');

  return db.$transaction(async (tx) => {
    const row = await tx.transcript.upsert({
      where: { versionId_language: { versionId: input.versionId, language: input.language } },
      create: {
        versionId: input.versionId,
        language: input.language,
        provider: input.provider,
        status: TranscriptStatus.READY,
        searchText,
        error: null,
      },
      update: {
        provider: input.provider,
        status: TranscriptStatus.READY,
        searchText,
        error: null,
      },
    });

    await tx.transcriptSegment.deleteMany({ where: { transcriptId: row.id } });
    await tx.transcriptSegment.createMany({
      data: input.segments.map((segment, position) => ({
        transcriptId: row.id,
        startSec: segment.startSec,
        endSec: segment.endSec,
        text: segment.text,
        words: segment.words as Prisma.InputJsonValue,
        position,
      })),
    });

    return tx.transcript.findUniqueOrThrow({
      where: { id: row.id },
      include: { segments: { orderBy: { position: 'asc' } } },
    });
  });
}

export async function saveFailedTranscript(input: {
  versionId: string;
  language: string;
  provider: string;
  error: string;
}) {
  return db.transcript.upsert({
    where: { versionId_language: { versionId: input.versionId, language: input.language } },
    create: {
      versionId: input.versionId,
      language: input.language,
      provider: input.provider,
      status: TranscriptStatus.FAILED,
      error: input.error,
    },
    update: {
      provider: input.provider,
      status: TranscriptStatus.FAILED,
      error: input.error,
    },
  });
}
