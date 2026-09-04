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

/** OpenAI Whisper rejects uploads over 25 MiB. Leave headroom for multipart encoding. */
export const OPENAI_MAX_AUDIO_BYTES = 24 * 1024 * 1024;

/**
 * `extractAudio` writes 16 kHz mono 16-bit PCM. Ten minutes of that is ~19.2 MiB,
 * which stays under the OpenAI cap. Two-hour files are split into ~12 of these.
 */
export const OPENAI_WAV_CHUNK_SECONDS = 600;
export const OPENAI_CHUNK_OVERLAP_SECONDS = 1.5;
export const OPENAI_MAX_CHUNKS = 200;

export function shouldSplitForOpenAI(byteLength: number): boolean {
  return byteLength > OPENAI_MAX_AUDIO_BYTES;
}

export function openaiChunkOffsets(
  durationSeconds: number,
  chunkSeconds = OPENAI_WAV_CHUNK_SECONDS,
  overlapSeconds = OPENAI_CHUNK_OVERLAP_SECONDS
): number[] {
  if (!(durationSeconds > 0)) return [0];
  const step = Math.max(chunkSeconds - overlapSeconds, 1);
  const offsets: number[] = [];
  for (let offset = 0; offset < durationSeconds; offset += step) {
    offsets.push(offset);
    if (offsets.length >= OPENAI_MAX_CHUNKS) break;
  }
  return offsets;
}

function shiftTranscriptCue(cue: TranscriptCue, offsetSeconds: number): TranscriptCue {
  return {
    ...cue,
    start: cue.start + offsetSeconds,
    end: cue.end + offsetSeconds,
    words: cue.words.map((word) => ({
      ...word,
      start: word.start + offsetSeconds,
      end: word.end + offsetSeconds,
    })),
  };
}

export function mergeChunkTranscriptions(
  chunks: Array<{
    offsetSeconds: number;
    overlapSeconds: number;
    result: TranscriptionResult;
  }>
): TranscriptionResult {
  if (chunks.length === 0) {
    return { language: 'und', segments: [] };
  }

  const language =
    chunks.find((chunk) => chunk.result.language && chunk.result.language !== 'und')?.result
      .language ??
    chunks[0]?.result.language ??
    'und';

  const segments: TranscriptCue[] = [];
  for (const chunk of chunks) {
    for (const segment of chunk.result.segments) {
      if (chunk.overlapSeconds > 0 && segment.start < chunk.overlapSeconds) continue;
      segments.push(shiftTranscriptCue(segment, chunk.offsetSeconds));
    }
  }

  return { language, segments };
}

function isAudioFileName(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return (
    ext === 'mp3' ||
    ext === 'wav' ||
    ext === 'm4a' ||
    ext === 'ogg' ||
    ext === 'oga' ||
    ext === 'flac' ||
    ext === 'aac'
  );
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
    if (!isAudioFileName(fileName)) {
      throw new Error('OpenAI transcription only accepts audio files, not video');
    }
    if (audio.byteLength > OPENAI_MAX_AUDIO_BYTES) {
      throw new Error("Audio exceeds OpenAI's 25 MiB upload limit");
    }

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
      const bodyText = await response.text();
      throw new Error(
        `OpenAI transcription returned ${response.status}: ${bodyText.slice(0, 300)}`
      );
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
