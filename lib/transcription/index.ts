import { getTranscriptionProviderName } from '@/lib/feature-flags';
import { deepgramProvider } from '@/lib/transcription/deepgram';
import { openaiProvider } from '@/lib/transcription/openai';
import { whisperLocalProvider } from '@/lib/transcription/whisper-local';
import type { TranscriptionProvider } from '@/lib/transcription/types';

export function getTranscriptionProvider(): TranscriptionProvider {
  switch (getTranscriptionProviderName()) {
    case 'deepgram':
      return deepgramProvider;
    case 'openai':
      return openaiProvider;
    default:
      return whisperLocalProvider;
  }
}

export type {
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptCue,
  TranscriptWord,
} from '@/lib/transcription/types';
