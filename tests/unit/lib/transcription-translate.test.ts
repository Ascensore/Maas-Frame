import { afterEach, describe, expect, it, vi } from 'vitest';
import { translateTranscriptTexts } from '@/lib/transcription/translate';

describe('translateTranscriptTexts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('does not call OpenAI when the source is already English', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');

    await expect(
      translateTranscriptTexts({
        texts: ['Hello there'],
        sourceLanguage: 'en',
        targetLanguage: 'en',
      })
    ).resolves.toEqual(['Hello there']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the chat API for one English line per Italian line', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const captured: { url: string; body: string } = { url: '', body: '' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(input);
      captured.body = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ lines: ['Hello everyone', 'Good morning'] }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await translateTranscriptTexts({
      texts: ['Ciao a tutti', 'Buongiorno'],
      sourceLanguage: 'it',
      targetLanguage: 'en',
    });

    expect(out).toEqual(['Hello everyone', 'Good morning']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(captured.url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(captured.body) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[1]?.content).toContain('Ciao a tutti');
    expect(body.messages[1]?.content).toContain('"targetLanguage":"en"');
    expect(body.messages[0]?.content).toContain('exactly one string per input line');
  });

  it('rejects a response that drops a line', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ lines: ['Hello'] }) } }],
          }),
          { status: 200 }
        );
      })
    );

    await expect(
      translateTranscriptTexts({
        texts: ['Ciao', 'Buongiorno'],
        sourceLanguage: 'it',
      })
    ).rejects.toThrow('wrong number of lines');
  });
});
