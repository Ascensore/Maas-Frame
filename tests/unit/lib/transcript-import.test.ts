import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  cueToTimedSegment,
  getTranscriptUploadExtension,
  importTranscriptFile,
  isTranscriptSegmentTimed,
  paragraphsToUntimedSegments,
  sanitizeTranscriptText,
  splitUntimedParagraphs,
  splitWords,
  spreadWordsAcrossRange,
} from '@/lib/transcript-import';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

/** Uncompressed ZIP so the unit suite can build a real .docx without extra deps. */
function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encode(file.name);
    const crc = crc32(file.data) >>> 0;
    const local = concat([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(file.data.length),
      u32(file.data.length),
      u16(name.length),
      u16(0),
      name,
      file.data,
    ]);
    locals.push(local);
    centrals.push(
      concat([
        new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(file.data.length),
        u32(file.data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ])
    );
    offset += local.length;
  }

  const central = concat(centrals);
  const eocd = concat([
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, central, eocd]);
}

function buildMinimalDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((paragraph) => `<w:p><w:r><w:t xml:space="preserve">${paragraph}</w:t></w:r></w:p>`)
    .join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

  return zipStore([
    { name: '[Content_Types].xml', data: encode(contentTypes) },
    { name: '_rels/.rels', data: encode(rels) },
    { name: 'word/document.xml', data: encode(documentXml) },
    { name: 'word/_rels/document.xml.rels', data: encode(documentRels) },
  ]);
}

describe('getTranscriptUploadExtension', () => {
  it('accepts the four ingest formats and nothing else', () => {
    expect(getTranscriptUploadExtension('cut.srt')).toBe('srt');
    expect(getTranscriptUploadExtension('cut.VTT')).toBe('vtt');
    expect(getTranscriptUploadExtension('notes.TXT')).toBe('txt');
    expect(getTranscriptUploadExtension('script.docx')).toBe('docx');
    expect(getTranscriptUploadExtension('cut.ass')).toBeNull();
    expect(getTranscriptUploadExtension('cut.srt.exe')).toBeNull();
  });
});

describe('isTranscriptSegmentTimed', () => {
  it('treats a zero-width span as untimed', () => {
    expect(isTranscriptSegmentTimed({ startSec: 0, endSec: 0 })).toBe(false);
    expect(isTranscriptSegmentTimed({ startSec: 1.5, endSec: 1.5 })).toBe(false);
    expect(isTranscriptSegmentTimed({ startSec: 1, endSec: 2 })).toBe(true);
  });
});

describe('spreadWordsAcrossRange', () => {
  it('splits two words evenly across a two-second cue', () => {
    expect(spreadWordsAcrossRange(['Hello', 'world'], 1, 3)).toEqual([
      { text: 'Hello', start: 1, end: 2 },
      { text: 'world', start: 2, end: 3 },
    ]);
  });

  it('returns nothing for an empty, inverted, or zero-width range', () => {
    expect(spreadWordsAcrossRange(['Hello'], 3, 1)).toEqual([]);
    expect(spreadWordsAcrossRange(['Hello'], 2, 2)).toEqual([]);
    expect(spreadWordsAcrossRange([], 1, 3)).toEqual([]);
  });
});

describe('cueToTimedSegment', () => {
  it('turns a cue into words timed across the cue', () => {
    expect(cueToTimedSegment({ start: 1, end: 3, text: 'Hello world' })).toEqual({
      startSec: 1,
      endSec: 3,
      text: 'Hello world',
      words: [
        { text: 'Hello', start: 1, end: 2 },
        { text: 'world', start: 2, end: 3 },
      ],
    });
  });

  it('drops a cue with no readable text', () => {
    expect(cueToTimedSegment({ start: 1, end: 2, text: '<b></b>' })).toBeNull();
  });
});

describe('splitUntimedParagraphs', () => {
  it('keeps newlines inside a paragraph and only splits on a blank line', () => {
    expect(splitUntimedParagraphs('INT. KITCHEN\nNIGHT\n\nHello there.')).toEqual([
      'INT. KITCHEN NIGHT',
      'Hello there.',
    ]);
  });

  it('falls back to single newlines when there are no blank lines', () => {
    expect(splitUntimedParagraphs('First line\nSecond line')).toEqual([
      'First line',
      'Second line',
    ]);
  });

  it('keeps a single blob as one paragraph', () => {
    expect(splitUntimedParagraphs('Just one line')).toEqual(['Just one line']);
  });
});

describe('sanitizeTranscriptText', () => {
  it('strips a BOM and control characters', () => {
    expect(sanitizeTranscriptText('\uFEFFHello\u0000\nworld')).toBe('Hello\nworld');
  });
});

describe('paragraphsToUntimedSegments', () => {
  it('stores paragraphs with no timings', () => {
    expect(paragraphsToUntimedSegments(['Hello', 'World'])).toEqual([
      { startSec: 0, endSec: 0, text: 'Hello', words: [] },
      { startSec: 0, endSec: 0, text: 'World', words: [] },
    ]);
  });

  it('caps a paragraph at 4000 characters and a script at 5000 segments', () => {
    const long = 'a'.repeat(4001);
    expect(paragraphsToUntimedSegments([long])[0]?.text).toHaveLength(4000);
    const many = Array.from({ length: 5001 }, (_, index) => `Line ${index}`);
    expect(paragraphsToUntimedSegments(many)).toHaveLength(5000);
    expect(paragraphsToUntimedSegments(many)[4999]?.text).toBe('Line 4999');
  });
});

describe('importTranscriptFile', () => {
  it('parses SRT cues into timed segments with word spans', async () => {
    const result = await importTranscriptFile({
      fileName: 'cut.srt',
      buffer: encode(['1', '00:00:01,000 --> 00:00:03,000', 'Hello world', '', ''].join('\n')),
    });
    expect(result).toEqual({
      ok: true,
      timed: true,
      segments: [
        {
          startSec: 1,
          endSec: 3,
          text: 'Hello world',
          words: [
            { text: 'Hello', start: 1, end: 2 },
            { text: 'world', start: 2, end: 3 },
          ],
        },
      ],
    });
  });

  it('parses WebVTT the same way', async () => {
    const result = await importTranscriptFile({
      fileName: 'cut.vtt',
      buffer: encode(['WEBVTT', '', '00:00:01.000 --> 00:00:02.000', 'Merhaba', ''].join('\n')),
    });
    expect(result).toEqual({
      ok: true,
      timed: true,
      segments: [
        {
          startSec: 1,
          endSec: 2,
          text: 'Merhaba',
          words: [{ text: 'Merhaba', start: 1, end: 2 }],
        },
      ],
    });
  });

  it('rejects an SRT that has no cues', async () => {
    const result = await importTranscriptFile({
      fileName: 'empty.srt',
      buffer: encode('this is not a subtitle file'),
    });
    expect(result).toEqual({
      ok: false,
      error: 'No subtitle cues found. Upload a valid .srt or .vtt file.',
    });
  });

  it('splits a text file on blank lines as an untimed script', async () => {
    const result = await importTranscriptFile({
      fileName: 'script.txt',
      buffer: encode('INT. KITCHEN\n\nHello there.\n'),
    });
    expect(result).toEqual({
      ok: true,
      timed: false,
      segments: [
        { startSec: 0, endSec: 0, text: 'INT. KITCHEN', words: [] },
        { startSec: 0, endSec: 0, text: 'Hello there.', words: [] },
      ],
    });
  });

  it('rejects an empty text file', async () => {
    const result = await importTranscriptFile({
      fileName: 'blank.txt',
      buffer: encode('   \n\n'),
    });
    expect(result).toEqual({ ok: false, error: 'The file is empty.' });
  });

  it('strips control characters from uploaded text', async () => {
    const result = await importTranscriptFile({
      fileName: 'notes.txt',
      buffer: encode('Hello\u0000 world'),
    });
    expect(result).toEqual({
      ok: true,
      timed: false,
      segments: [{ startSec: 0, endSec: 0, text: 'Hello world', words: [] }],
    });
  });

  it('extracts paragraphs from a .docx', async () => {
    const result = await importTranscriptFile({
      fileName: 'script.docx',
      buffer: buildMinimalDocx(['First paragraph', 'Second paragraph']),
    });
    expect(result).toEqual({
      ok: true,
      timed: false,
      segments: [
        { startSec: 0, endSec: 0, text: 'First paragraph', words: [] },
        { startSec: 0, endSec: 0, text: 'Second paragraph', words: [] },
      ],
    });
  });

  it('rejects a file whose name is not a transcript format', async () => {
    const result = await importTranscriptFile({
      fileName: 'cut.ass',
      buffer: encode('hello'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('Transcript must be a .srt, .vtt, .txt, or .docx file');
  });

  it('rejects a file over two megabytes and accepts one that fits', async () => {
    const over = await importTranscriptFile({
      fileName: 'huge.txt',
      buffer: new Uint8Array(2 * 1024 * 1024 + 1),
    });
    expect(over).toEqual({
      ok: false,
      error: 'Transcript file is too large. Maximum size is 2MB.',
    });

    const fits = await importTranscriptFile({
      fileName: 'ok.txt',
      buffer: encode('Fits'),
    });
    expect(fits).toEqual({
      ok: true,
      timed: false,
      segments: [{ startSec: 0, endSec: 0, text: 'Fits', words: [] }],
    });
  });

  it('rejects a zero-byte file', async () => {
    const result = await importTranscriptFile({
      fileName: 'empty.txt',
      buffer: new Uint8Array(),
    });
    expect(result).toEqual({ ok: false, error: 'The file is empty.' });
  });
});

describe('splitWords', () => {
  it('drops extra whitespace', () => {
    expect(splitWords('  Hello   world  ')).toEqual(['Hello', 'world']);
  });
});
