import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { openaiProvider } from '@/lib/transcription/openai';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => Buffer.from('audio')),
}));

describe('openaiProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('calls transcriptions, not translations, and omits language so Whisper can detect Italian', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const captured: { url: string; form: FormData | null } = { url: '', form: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.url = String(input);
        captured.form = init?.body as FormData;
        return new Response(
          JSON.stringify({
            language: 'it',
            words: [{ word: 'Ciao', start: 0, end: 0.5 }],
          }),
          { status: 200 }
        );
      })
    );

    const result = await openaiProvider.transcribe({ audioPath: '/tmp/clip.wav' });

    expect(captured.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(captured.url).not.toContain('translations');
    expect(captured.form?.get('language')).toBeNull();
    expect(captured.form?.get('temperature')).toBe('0');
    expect(captured.form?.get('model')).toBe('whisper-1');
    expect(result.language).toBe('it');
    expect(result.segments[0]?.text).toContain('Ciao');
  });

  it('passes an explicit language through when the caller asked for one', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const captured: { form: FormData | null } = { form: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured.form = init?.body as FormData;
        return new Response(JSON.stringify({ language: 'en', words: [] }), { status: 200 });
      })
    );

    await openaiProvider.transcribe({ audioPath: '/tmp/clip.wav', language: 'en' });

    expect(captured.form?.get('language')).toBe('en');
  });

  it('refuses a video filename without calling fetch', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(openaiProvider.transcribe({ audioPath: '/tmp/clip.mp4' })).rejects.toThrow(
      'OpenAI transcription only accepts audio files, not video'
    );
    await expect(openaiProvider.transcribe({ audioPath: '/tmp/clip.webm' })).rejects.toThrow(
      'OpenAI transcription only accepts audio files, not video'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses oversized wav without calling fetch', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(readFile).mockResolvedValueOnce({
      byteLength: 25165825,
    } as unknown as Awaited<ReturnType<typeof readFile>>);

    await expect(openaiProvider.transcribe({ audioPath: '/tmp/clip.wav' })).rejects.toThrow(
      "Audio exceeds OpenAI's 25 MiB upload limit"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
