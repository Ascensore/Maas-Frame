/**
 * Keep in lockstep with lib/transcription. The worker image cannot import
 * from the app tree (Docker context is ./worker).
 */

export type TranscriptWord = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptCue = {
  start: number;
  end: number;
  speaker?: string;
  text: string;
  words: TranscriptWord[];
};

export type TranscriptionResult = {
  language: string;
  segments: TranscriptCue[];
};

export interface TranscriptionProvider {
  name: string;
  transcribe(input: { audioPath: string; language?: string }): Promise<TranscriptionResult>;
}

function providerLanguage(language?: string): string | undefined {
  const normalized = language?.trim().toLowerCase();
  if (!normalized || normalized === 'und' || normalized === 'auto') return undefined;
  const primary = normalized.split('-')[0] ?? '';
  if (primary.length < 2 || primary.length > 3) return undefined;
  return primary;
}

function groupWordsIntoCues(words: TranscriptWord[]): TranscriptCue[] {
  if (words.length === 0) return [];

  const cues: TranscriptCue[] = [];
  let current: TranscriptCue = {
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

const deepgramProvider: TranscriptionProvider = {
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
    const language = providerLanguage(input.language);
    if (language) {
      params.set('language', language);
    } else {
      params.set('detect_language', 'true');
    }

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
      metadata?: { detected_language?: string };
      results?: {
        channels?: Array<{
          detected_language?: string;
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

    const detected =
      body.results?.channels?.[0]?.detected_language ?? body.metadata?.detected_language;

    return {
      language: detected ?? language ?? 'und',
      segments: groupWordsIntoCues(mapped),
    };
  },
};

const openaiProvider: TranscriptionProvider = {
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

    const form = new FormData();
    form.set('model', 'whisper-1');
    form.set('response_format', 'verbose_json');
    form.set('timestamp_granularities[]', 'word');
    form.set('temperature', '0');
    const language = providerLanguage(input.language);
    if (language) form.set('language', language);
    form.set('file', new Blob([audio], { type: 'audio/wav' }), fileName);

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

    const words = (body.words ?? [])
      .filter((word) => typeof word.word === 'string')
      .map((word) => ({
        start: typeof word.start === 'number' ? word.start : 0,
        end: typeof word.end === 'number' ? word.end : 0,
        text: word.word as string,
      }));

    if (words.length > 0) {
      return {
        language: body.language ?? language ?? 'und',
        segments: groupWordsIntoCues(words),
      };
    }

    return {
      language: body.language ?? language ?? 'und',
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

export function createWhisperLocalProvider(
  runLocal: (audioPath: string, language: string) => Promise<TranscriptionResult>
): TranscriptionProvider {
  return {
    name: 'whisper-local',
    transcribe(input) {
      return runLocal(input.audioPath, input.language ?? '');
    },
  };
}

export function getWorkerTranscriptionProvider(
  name: string,
  whisperLocal: TranscriptionProvider
): TranscriptionProvider {
  const provider = name.trim().toLowerCase();
  if (provider === 'deepgram') return deepgramProvider;
  if (provider === 'openai') return openaiProvider;
  return whisperLocal;
}
