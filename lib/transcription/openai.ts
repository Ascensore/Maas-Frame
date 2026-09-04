import { mediaTypeFromFileName } from '@/lib/transcription/media-type';
import { AUTO_DETECT_TRANSCRIPT_LANGUAGE, languageForProvider } from '@/lib/transcription/language';
import type { TranscriptionProvider, TranscriptionResult } from '@/lib/transcription/types';

export const openaiProvider: TranscriptionProvider = {
  name: 'openai',
  async transcribe(input: { audioPath: string; language?: string }): Promise<TranscriptionResult> {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const audio = await fs.readFile(input.audioPath);
    const fileName = path.basename(input.audioPath) || 'audio.wav';
    const language = languageForProvider(input.language);

    const form = new FormData();
    form.set('model', 'whisper-1');
    form.set('response_format', 'verbose_json');
    form.set('timestamp_granularities[]', 'word');
    form.set('temperature', '0');
    if (language) form.set('language', language);
    form.set(
      'file',
      new Blob([new Uint8Array(audio)], { type: mediaTypeFromFileName(fileName) }),
      fileName
    );

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`OpenAI transcription returned ${response.status}`);
    }

    const body = (await response.json()) as {
      language?: string;
      words?: Array<{ word?: string; start?: number; end?: number }>;
      segments?: Array<{ start?: number; end?: number; text?: string }>;
    };

    const detected = body.language ?? language ?? AUTO_DETECT_TRANSCRIPT_LANGUAGE;
    const words = (body.words ?? [])
      .filter((word) => typeof word.word === 'string')
      .map((word) => ({
        start: typeof word.start === 'number' ? word.start : 0,
        end: typeof word.end === 'number' ? word.end : 0,
        text: word.word as string,
      }));

    if (words.length > 0) {
      return {
        language: detected,
        segments: groupWords(words),
      };
    }

    return {
      language: detected,
      segments: (body.segments ?? [])
        .filter((segment) => typeof segment.text === 'string' && segment.text.trim())
        .map((segment) => ({
          start: typeof segment.start === 'number' ? segment.start : 0,
          end: typeof segment.end === 'number' ? segment.end : 0,
          text: (segment.text as string).trim(),
          words: [],
        })),
    };
  },
};

function groupWords(
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
    if (word.start - current.end > 0.8 || current.text.length > 80) {
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
