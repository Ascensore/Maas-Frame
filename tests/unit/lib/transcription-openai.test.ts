import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
