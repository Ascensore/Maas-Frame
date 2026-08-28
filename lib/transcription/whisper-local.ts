import type { TranscriptionProvider, TranscriptionResult } from '@/lib/transcription/types';

/**
 * Default provider. The actual faster-whisper call runs in the media worker;
 * this module is the in-process contract the API uses to name the provider.
 * The worker imports the same types and writes segments back through Prisma.
 */
export const whisperLocalProvider: TranscriptionProvider = {
  name: 'whisper-local',
  async transcribe(): Promise<TranscriptionResult> {
    throw new Error(
      'whisper-local runs in the media worker, not in the Next.js process. Enqueue a TRANSCRIBE job.'
    );
  },
};
