import { afterEach, describe, expect, it, vi } from 'vitest';
import { deepgramProvider } from '@/lib/transcription/deepgram';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => Buffer.from('audio')),
}));

describe('deepgramProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('asks Deepgram to detect language instead of forcing English', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', 'dg-test');
    const captured: { url: string } = { url: '' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        captured.url = String(input);
        return new Response(
          JSON.stringify({
            results: {
              channels: [
                {
                  detected_language: 'it',
                  alternatives: [{ words: [{ word: 'Ciao', start: 0, end: 0.4 }] }],
                },
              ],
            },
          }),
          { status: 200 }
        );
      })
    );

    const result = await deepgramProvider.transcribe({ audioPath: '/tmp/clip.wav' });

    const params = new URL(captured.url).searchParams;
    expect(params.get('detect_language')).toBe('true');
    expect(params.get('language')).toBeNull();
    expect(result.language).toBe('it');
  });
});
