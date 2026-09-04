import { getTranscriptionProvider } from '@/lib/transcription';
import { openaiProvider } from '@/lib/transcription/openai';
import type { TranscriptionResult } from '@/lib/transcription/types';

export const WHISPER_LOCAL_APP_FALLBACK_ERROR =
  'Transcription cannot run in the app process. Set OPENAI_API_KEY, or run the media worker.';

export async function transcribeWithCloudFallback(input: {
  audioPath: string;
  language?: string;
}): Promise<{ provider: string; result: TranscriptionResult }> {
  const selected = getTranscriptionProvider();
  try {
    const result = await selected.transcribe(input);
    return { provider: selected.name, result };
  } catch (error) {
    if (selected.name !== 'whisper-local') throw error;
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error(WHISPER_LOCAL_APP_FALLBACK_ERROR);
    }
    const result = await openaiProvider.transcribe(input);
    return { provider: openaiProvider.name, result };
  }
}
