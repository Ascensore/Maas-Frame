import type { TranscriptionProvider, TranscriptionResult } from '@/lib/transcription/types';

export const deepgramProvider: TranscriptionProvider = {
  name: 'deepgram',
  async transcribe(input: { audioPath: string; language?: string }): Promise<TranscriptionResult> {
    const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('DEEPGRAM_API_KEY is not set');
    }

    const fs = await import('node:fs/promises');
    const audio = await fs.readFile(input.audioPath);
    const params = new URLSearchParams({
      model: 'nova-2',
      smart_format: 'true',
      utterances: 'true',
      punctuate: 'true',
    });
    if (input.language) params.set('language', input.language);

    const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: audio,
    });

    if (!response.ok) {
      throw new Error(`Deepgram returned ${response.status}`);
    }

    const body = (await response.json()) as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{
            transcript?: string;
            words?: Array<{ word?: string; start?: number; end?: number }>;
          }>;
        }>;
      };
    };

    const words = body.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
    const mapped = words
      .filter((word) => typeof word.word === 'string')
      .map((word) => ({
        start: typeof word.start === 'number' ? word.start : 0,
        end: typeof word.end === 'number' ? word.end : 0,
        text: word.word as string,
      }));

    return {
      language: input.language ?? 'en',
      segments: groupWordsIntoCues(mapped),
    };
  },
};

function groupWordsIntoCues(
  words: Array<{ start: number; end: number; text: string }>
): TranscriptionResult['segments'] {
  if (words.length === 0) return [];

  const cues: TranscriptionResult['segments'] = [];
  let current: TranscriptionResult['segments'][number] = {
    start: words[0].start,
    end: words[0].end,
    text: words[0].text,
    words: [words[0]],
  };

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    const gap = word.start - current.end;
    const wouldBeLong = current.text.length + word.text.length + 1 > 80;
    if (gap > 0.8 || wouldBeLong) {
      cues.push(current);
      current = { start: word.start, end: word.end, text: word.text, words: [word] };
    } else {
      current.end = word.end;
      current.text = `${current.text} ${word.text}`;
      current.words.push(word);
    }
  }
  cues.push(current);
  return cues;
}
