import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTranscriptionProvider } from '@/lib/transcription';
import { openaiProvider } from '@/lib/transcription/openai';
import { transcribeWithCloudFallback } from '@/lib/transcription/fallback';

const transcribe = vi.hoisted(() => vi.fn());
const openaiTranscribe = vi.hoisted(() => vi.fn());

vi.mock('@/lib/transcription', () => ({
  getTranscriptionProvider: vi.fn(),
}));

vi.mock('@/lib/transcription/openai', () => ({
  openaiProvider: {
    name: 'openai',
    transcribe: openaiTranscribe,
  },
}));

describe('transcribeWithCloudFallback', () => {
  afterEach(() => {
    transcribe.mockReset();
    openaiTranscribe.mockReset();
    vi.unstubAllEnvs();
  });

  it('returns the selected provider when it succeeds', async () => {
    vi.mocked(getTranscriptionProvider).mockReturnValue({
      name: 'deepgram',
      transcribe,
    });
    transcribe.mockResolvedValue({
      language: 'en',
      segments: [{ start: 0, end: 1, text: 'Hi', words: [] }],
    });

    const out = await transcribeWithCloudFallback({ audioPath: '/tmp/a.wav' });

    expect(out.provider).toBe('deepgram');
    expect(out.result.segments).toEqual([{ start: 0, end: 1, text: 'Hi', words: [] }]);
    expect(openaiTranscribe).not.toHaveBeenCalled();
  });

  it('does not call OpenAI when whisper-local fails and no key is set', async () => {
    vi.mocked(getTranscriptionProvider).mockReturnValue({
      name: 'whisper-local',
      transcribe,
    });
    transcribe.mockRejectedValue(new Error('Enqueue a TRANSCRIBE job.'));
    vi.stubEnv('OPENAI_API_KEY', '');

    await expect(transcribeWithCloudFallback({ audioPath: '/tmp/a.wav' })).rejects.toThrow(
      'Transcription cannot run in the app process. Set OPENAI_API_KEY, or run the media worker.'
    );
    expect(openaiTranscribe).not.toHaveBeenCalled();
  });

  it('uses OpenAI when whisper-local fails and OPENAI_API_KEY is set', async () => {
    vi.mocked(getTranscriptionProvider).mockReturnValue({
      name: 'whisper-local',
      transcribe,
    });
    transcribe.mockRejectedValue(new Error('Enqueue a TRANSCRIBE job.'));
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    openaiTranscribe.mockResolvedValue({
      language: 'en',
      segments: [{ start: 0, end: 1, text: 'Cloud', words: [] }],
    });

    const out = await transcribeWithCloudFallback({ audioPath: '/tmp/a.wav' });

    expect(out.provider).toBe('openai');
    expect(out.result.segments[0]?.text).toBe('Cloud');
    expect(openaiProvider.transcribe).toHaveBeenCalledWith({ audioPath: '/tmp/a.wav' });
  });

  it('rethrows errors from a cloud provider without calling OpenAI', async () => {
    vi.mocked(getTranscriptionProvider).mockReturnValue({
      name: 'deepgram',
      transcribe,
    });
    transcribe.mockRejectedValue(new Error('Deepgram returned 503'));
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');

    await expect(transcribeWithCloudFallback({ audioPath: '/tmp/a.wav' })).rejects.toThrow(
      'Deepgram returned 503'
    );
    expect(openaiTranscribe).not.toHaveBeenCalled();
  });
});
