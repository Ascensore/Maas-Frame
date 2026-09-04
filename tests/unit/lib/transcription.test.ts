import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTranscriptionProvider } from '@/lib/transcription';

describe('getTranscriptionProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses whisper-local when the env is unset', () => {
    vi.stubEnv('OPENFRAME_TRANSCRIPTION_PROVIDER', '');
    expect(getTranscriptionProvider().name).toBe('whisper-local');
  });

  it('uses deepgram when OPENFRAME_TRANSCRIPTION_PROVIDER is deepgram', () => {
    vi.stubEnv('OPENFRAME_TRANSCRIPTION_PROVIDER', 'deepgram');
    expect(getTranscriptionProvider().name).toBe('deepgram');
  });

  it('uses openai when OPENFRAME_TRANSCRIPTION_PROVIDER is openai', () => {
    vi.stubEnv('OPENFRAME_TRANSCRIPTION_PROVIDER', 'openai');
    expect(getTranscriptionProvider().name).toBe('openai');
  });

  it('falls back to whisper-local for an unknown name', () => {
    vi.stubEnv('OPENFRAME_TRANSCRIPTION_PROVIDER', 'assemblyai');
    expect(getTranscriptionProvider().name).toBe('whisper-local');
  });
});
