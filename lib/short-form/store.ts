import { db } from '@/lib/db';
import type { ShortFormTranscriptSegment } from './index';

export async function loadSourceTranscript(
  versionId: string
): Promise<ShortFormTranscriptSegment[]> {
  const transcript = await db.transcript.findFirst({
    where: { versionId, status: 'READY' },
    orderBy: { createdAt: 'asc' },
    include: { segments: { orderBy: { position: 'asc' } } },
  });
  if (!transcript) return [];
  return transcript.segments.map((segment) => ({
    start: segment.startSec,
    end: segment.endSec,
    text: segment.text,
    words: Array.isArray(segment.words)
      ? (segment.words as Array<{ start: number; end: number; text: string }>)
      : undefined,
  }));
}

export const shortFormCandidateInclude = {
  outputVideo: {
    select: {
      id: true,
      title: true,
      versions: {
        where: { isActive: true },
        take: 1,
        select: { id: true, originalUrl: true, duration: true },
      },
    },
  },
} as const;

export function shapeShortFormBatch(batch: {
  id: string;
  roughCutId: string;
  sourceVersionId: string;
  status: string;
  config: unknown;
  warnings: unknown;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  candidates?: unknown[];
}) {
  return {
    id: batch.id,
    roughCutId: batch.roughCutId,
    sourceVersionId: batch.sourceVersionId,
    status: batch.status,
    config: batch.config,
    warnings: Array.isArray(batch.warnings) ? batch.warnings : [],
    error: batch.error,
    candidates: batch.candidates ?? [],
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
  };
}
