import mammoth from 'mammoth';
import {
  decodeSubtitleBuffer,
  MAX_SUBTITLE_CUES,
  MAX_SUBTITLE_FILE_SIZE,
  parseSubtitleCues,
  stripCueMarkup,
} from '@/lib/subtitle-validation';
import type { TranscriptWord } from '@/lib/transcription/types';

/** Same ceiling as a subtitle upload: a feature-length script with room to spare. */
export const MAX_TRANSCRIPT_FILE_SIZE = MAX_SUBTITLE_FILE_SIZE;

export const MAX_TRANSCRIPT_SEGMENTS = MAX_SUBTITLE_CUES;

/** A script paragraph, not a subtitle cue. Long enough for a block of dialogue. */
export const MAX_UNTIMED_PARAGRAPH_LENGTH = 4000;

export const TRANSCRIPT_UPLOAD_PROVIDER = 'upload';

export const ALLOWED_TRANSCRIPT_EXTENSIONS = ['srt', 'vtt', 'txt', 'docx'] as const;

export type TranscriptUploadExtension = (typeof ALLOWED_TRANSCRIPT_EXTENSIONS)[number];

export type TranscriptImportWord = TranscriptWord;

export type TranscriptImportSegment = {
  startSec: number;
  endSec: number;
  text: string;
  words: TranscriptImportWord[];
};

export type TranscriptImportResult =
  | { ok: true; timed: boolean; segments: TranscriptImportSegment[] }
  | { ok: false; error: string };

export function getTranscriptUploadExtension(fileName: string): TranscriptUploadExtension | null {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'srt' || ext === 'vtt' || ext === 'txt' || ext === 'docx') return ext;
  return null;
}

export function isTranscriptSegmentTimed(segment: { startSec: number; endSec: number }): boolean {
  return segment.endSec > segment.startSec;
}

export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Spread `words` evenly across `[start, end)` so an uploaded SRT still has
 * click-to-seek targets. The last word ends exactly at `end`.
 */
export function spreadWordsAcrossRange(
  words: string[],
  start: number,
  end: number
): TranscriptImportWord[] {
  if (words.length === 0 || end <= start) return [];
  const slice = (end - start) / words.length;
  return words.map((text, index) => ({
    text,
    start: start + index * slice,
    end: index === words.length - 1 ? end : start + (index + 1) * slice,
  }));
}

export function cueToTimedSegment(cue: {
  start: number;
  end: number;
  text: string;
}): TranscriptImportSegment | null {
  const text = stripCueMarkup(cue.text);
  if (!text || cue.end <= cue.start) return null;
  return {
    startSec: cue.start,
    endSec: cue.end,
    text,
    words: spreadWordsAcrossRange(splitWords(text), cue.start, cue.end),
  };
}

export function sanitizeTranscriptText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n');
}

/**
 * Blank-line paragraphs when the file has them; otherwise one segment per
 * non-empty line. A single blob of text becomes one segment.
 */
export function splitUntimedParagraphs(text: string): string[] {
  const normalized = sanitizeTranscriptText(text).trim();
  if (!normalized) return [];

  const blankSplit = normalized
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (blankSplit.length > 1) return blankSplit;

  const lineSplit = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lineSplit.length > 1) return lineSplit;

  return [normalized.replace(/\s+/g, ' ').trim()].filter(Boolean);
}

export function paragraphsToUntimedSegments(paragraphs: string[]): TranscriptImportSegment[] {
  return paragraphs.slice(0, MAX_TRANSCRIPT_SEGMENTS).map((paragraph) => {
    const text = paragraph.slice(0, MAX_UNTIMED_PARAGRAPH_LENGTH).trim();
    return {
      startSec: 0,
      endSec: 0,
      text,
      words: [],
    };
  });
}

function importTimedBuffer(buffer: Uint8Array): TranscriptImportResult {
  const decoded = decodeSubtitleBuffer(buffer);
  if (decoded === null) {
    return { ok: false, error: 'Could not read the file. Save it as UTF-8 and retry.' };
  }

  const cues = parseSubtitleCues(decoded);
  const segments = cues
    .map(cueToTimedSegment)
    .filter((segment): segment is TranscriptImportSegment => segment !== null)
    .slice(0, MAX_TRANSCRIPT_SEGMENTS);

  if (segments.length === 0) {
    return { ok: false, error: 'No subtitle cues found. Upload a valid .srt or .vtt file.' };
  }

  return { ok: true, timed: true, segments };
}

function importPlainText(buffer: Uint8Array): TranscriptImportResult {
  const decoded = decodeSubtitleBuffer(buffer);
  if (decoded === null) {
    return { ok: false, error: 'Could not read the file. Save it as UTF-8 and retry.' };
  }

  const paragraphs = splitUntimedParagraphs(decoded);
  if (paragraphs.length === 0) {
    return { ok: false, error: 'The file is empty.' };
  }

  return { ok: true, timed: false, segments: paragraphsToUntimedSegments(paragraphs) };
}

async function importDocx(buffer: Uint8Array): Promise<TranscriptImportResult> {
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    const paragraphs = splitUntimedParagraphs(result.value ?? '');
    if (paragraphs.length === 0) {
      return { ok: false, error: 'The Word document has no readable text.' };
    }
    return { ok: true, timed: false, segments: paragraphsToUntimedSegments(paragraphs) };
  } catch {
    return { ok: false, error: 'Could not read the Word document.' };
  }
}

export async function importTranscriptFile(input: {
  fileName: string;
  buffer: Uint8Array;
}): Promise<TranscriptImportResult> {
  if (input.buffer.byteLength === 0) {
    return { ok: false, error: 'The file is empty.' };
  }
  if (input.buffer.byteLength > MAX_TRANSCRIPT_FILE_SIZE) {
    return { ok: false, error: 'Transcript file is too large. Maximum size is 2MB.' };
  }

  const extension = getTranscriptUploadExtension(input.fileName);
  if (!extension) {
    return { ok: false, error: 'Transcript must be a .srt, .vtt, .txt, or .docx file' };
  }

  if (extension === 'srt' || extension === 'vtt') {
    return importTimedBuffer(input.buffer);
  }
  if (extension === 'txt') {
    return importPlainText(input.buffer);
  }
  return importDocx(input.buffer);
}
