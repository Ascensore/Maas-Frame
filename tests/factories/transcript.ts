import { TranscriptStatus, type Transcript } from '@prisma/client';
import { db } from '@/lib/db';

export interface CreateTranscriptInput {
  versionId: string;
  language?: string;
  provider?: string;
  status?: TranscriptStatus;
  segments: Array<{ startSec: number; endSec: number; text: string }>;
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
          text: segment.text,
          words: [],
          position,
        })),
      },
    },
  });
}
