import { TranscriptStatus, type Transcript } from '@prisma/client';
import { db } from '@/lib/db';

export interface CreateTranscriptInput {
  versionId: string;
  language?: string;
  provider?: string;
  status?: TranscriptStatus;
  segments: Array<{
    startSec: number;
    endSec: number;
    text: string;
    speaker?: string | null;
    /** Word timings, as a provider writes them. Empty means an untimed segment. */
    words?: Array<{ start: number; end: number; text: string }>;
  }>;
}

export async function createReadyTranscript(input: CreateTranscriptInput): Promise<Transcript> {
  return db.transcript.create({
    data: {
      versionId: input.versionId,
      language: input.language ?? 'en',
      provider: input.provider ?? 'mock',
      status: input.status ?? TranscriptStatus.READY,
      searchText: input.segments.map((segment) => segment.text).join(' '),
      segments: {
        create: input.segments.map((segment, position) => ({
          startSec: segment.startSec,
          endSec: segment.endSec,
          speaker: segment.speaker ?? null,
          text: segment.text,
          words: segment.words ?? [],
          position,
        })),
      },
    },
  });
}
