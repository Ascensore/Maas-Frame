import { describe, expect, it } from 'vitest';
import {
  importTranscriptFile,
  interpolateWords,
  transcriptSegmentsFromCues,
} from '@/lib/transcript-import';

describe('interpolateWords', () => {
  it('splits a cue evenly across its words', () => {
    expect(interpolateWords(10, 12, 'Cut the wide')).toEqual([
      { text: 'Cut', start: 10, end: 10 + 2 / 3 },
      { text: 'the', start: 10 + 2 / 3, end: 10 + 4 / 3 },
      { text: 'wide', start: 10 + 4 / 3, end: 12 },
    ]);
  });

  it('returns nothing for blank text', () => {
    expect(interpolateWords(0, 1, '   ')).toEqual([]);
  });
});

describe('transcriptSegmentsFromCues', () => {
  it('keeps cue order and flattens cue line breaks', () => {
    const segments = transcriptSegmentsFromCues([
      { start: 1, end: 2, text: 'Hello\nthere' },
      { start: 2, end: 3, text: 'Next' },
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.text).toBe('Hello there');
    expect(segments[0]?.position).toBe(0);
    expect(segments[1]?.position).toBe(1);
    expect(segments[1]?.words).toEqual([{ text: 'Next', start: 2, end: 3 }]);
  });
});

describe('importTranscriptFile', () => {
  it('rejects a file that is not SRT or VTT', () => {
    expect(
      importTranscriptFile({ fileName: 'notes.txt', bytes: new TextEncoder().encode('hello') })
    ).toEqual({ ok: false, error: 'Transcript must be a .srt or .vtt file' });
  });

  it('rejects an empty file', () => {
    expect(importTranscriptFile({ fileName: 'cut.srt', bytes: new Uint8Array() })).toEqual({
      ok: false,
      error: 'Transcript file is empty',
    });
  });

  it('parses SRT cues into ready segments', () => {
    const srt = ['1', '00:00:01,000 --> 00:00:02,000', 'Hello there', '', ''].join('\n');
    const imported = importTranscriptFile({
      fileName: 'cut.en.srt',
      bytes: new TextEncoder().encode(srt),
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.searchText).toBe('Hello there');
    expect(imported.segments).toHaveLength(1);
    expect(imported.segments[0]?.startSec).toBe(1);
    expect(imported.segments[0]?.endSec).toBe(2);
    expect(imported.segments[0]?.words).toEqual([
      { text: 'Hello', start: 1, end: 1.5 },
      { text: 'there', start: 1.5, end: 2 },
    ]);
  });

  it('parses WebVTT cues into ready segments', () => {
    const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:02.000', 'Hello there', ''].join('\n');
    const imported = importTranscriptFile({
      fileName: 'cut.en.vtt',
      bytes: new TextEncoder().encode(vtt),
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.segments[0]?.text).toBe('Hello there');
    expect(imported.segments[0]?.startSec).toBe(1);
    expect(imported.segments[0]?.endSec).toBe(2);
  });

  it('rejects a file with no timed lines', () => {
    expect(
      importTranscriptFile({
        fileName: 'cut.vtt',
        bytes: new TextEncoder().encode('WEBVTT\n\nNOTE nothing timed\n'),
      })
    ).toEqual({
      ok: false,
      error: 'No timed lines found. Upload a valid .srt or .vtt file.',
    });
  });
});
