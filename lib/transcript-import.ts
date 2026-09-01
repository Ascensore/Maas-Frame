import {
  decodeSubtitleBuffer,
  getSubtitleExtension,
  MAX_SUBTITLE_CUES,
  MAX_SUBTITLE_FILE_SIZE,
  parseSubtitleCues,
  type SubtitleCue,
} from '@/lib/subtitle-validation';

export type TranscriptImportWord = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptImportSegment = {
  startSec: number;
  endSec: number;
  text: string;
  words: TranscriptImportWord[];
  position: number;
};

export type TranscriptImportResult =
  | { ok: true; segments: TranscriptImportSegment[]; searchText: string }
  | { ok: false; error: string };

/**
 * Spread a cue's duration across its words so an uploaded SRT still has
 * clickable word timings. Even spacing is a stand-in for a forced-aligned
 * transcript, not a claim that the original file carried word clocks.
 */
export function interpolateWords(start: number, end: number, text: string): TranscriptImportWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  const span = Math.max(end - start, 0);
  const each = span / parts.length;
  return parts.map((word, index) => ({
    text: word,
    start: start + index * each,
    end: start + (index + 1) * each,
  }));
}

export function transcriptSegmentsFromCues(cues: SubtitleCue[]): TranscriptImportSegment[] {
  return cues.slice(0, MAX_SUBTITLE_CUES).map((cue, position) => {
    const text = cue.text.replace(/\s+/g, ' ').trim();
    return {
      startSec: cue.start,
      endSec: cue.end,
      text,
      words: interpolateWords(cue.start, cue.end, text),
      position,
    };
  });
}

export function importTranscriptFile(input: {
  fileName: string;
  bytes: Uint8Array;
}): TranscriptImportResult {
  if (input.bytes.byteLength === 0) {
    return { ok: false, error: 'Transcript file is empty' };
  }
  if (input.bytes.byteLength > MAX_SUBTITLE_FILE_SIZE) {
    return { ok: false, error: 'Transcript file is too large' };
  }
  if (!getSubtitleExtension(input.fileName)) {
    return { ok: false, error: 'Transcript must be a .srt or .vtt file' };
  }

  const decoded = decodeSubtitleBuffer(input.bytes);
  if (decoded === null) {
    return { ok: false, error: 'Could not read the transcript file. Save it as UTF-8 and retry.' };
  }

  const cues = parseSubtitleCues(decoded);
  if (cues.length === 0) {
    return { ok: false, error: 'No timed lines found. Upload a valid .srt or .vtt file.' };
  }

  const segments = transcriptSegmentsFromCues(cues);
  return {
    ok: true,
    segments,
    searchText: segments.map((segment) => segment.text).join(' '),
  };
}
