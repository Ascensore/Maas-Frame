import type { TranscriptCue, TranscriptionResult } from '@/lib/transcription/types';

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

export function shiftTranscriptCue(cue: TranscriptCue, offsetSeconds: number): TranscriptCue {
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

/**
 * Stitch per-chunk Whisper results. Later chunks overlap the previous one so a
 * word split across the cut can be dropped from the following chunk.
 */
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
