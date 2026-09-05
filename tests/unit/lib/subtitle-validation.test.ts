import { describe, expect, it } from 'vitest';
import {
  decodeSubtitleBuffer,
  getSubtitleExtension,
  MAX_SUBTITLE_CUES,
  normalizeSubtitleFile,
  normalizeSubtitleLanguage,
  parseSubtitleCues,
  sanitizeSubtitleLabel,
  SAFE_SUBTITLE_PROXY_PATH,
  serializeWebVtt,
  subtitleProxyPathToObjectKey,
} from '@/lib/subtitle-validation';

const UUID = '11111111-2222-3333-4444-555555555555';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('getSubtitleExtension', () => {
  it('accepts the two subtitle formats and nothing else', () => {
    expect(getSubtitleExtension('cut.srt')).toBe('srt');
    expect(getSubtitleExtension('cut.VTT')).toBe('vtt');
    expect(getSubtitleExtension('cut.ass')).toBeNull();
    expect(getSubtitleExtension('cut.srt.exe')).toBeNull();
  });
});

describe('normalizeSubtitleLanguage', () => {
  it('lowercases so a re-upload replaces the track it means to', () => {
    expect(normalizeSubtitleLanguage('TR')).toBe('tr');
    expect(normalizeSubtitleLanguage(' en-US ')).toBe('en-us');
    expect(normalizeSubtitleLanguage('zh-Hant-TW')).toBe('zh-hant-tw');
  });

  it('rejects anything that is not a language tag', () => {
    expect(normalizeSubtitleLanguage('')).toBeNull();
    expect(normalizeSubtitleLanguage('t')).toBeNull();
    expect(normalizeSubtitleLanguage('tr; drop table')).toBeNull();
    expect(normalizeSubtitleLanguage('<script>')).toBeNull();
    expect(normalizeSubtitleLanguage(42)).toBeNull();
  });
});

describe('sanitizeSubtitleLabel', () => {
  it('falls back when the label is empty after cleaning', () => {
    expect(sanitizeSubtitleLabel('   ', 'TR')).toBe('TR');
    expect(sanitizeSubtitleLabel(undefined, 'TR')).toBe('TR');
  });

  it('strips control characters and collapses whitespace', () => {
    expect(sanitizeSubtitleLabel('Türk\u0000\n  çe ', 'TR')).toBe('Türk çe');
  });

  it('caps the length', () => {
    expect(sanitizeSubtitleLabel('a'.repeat(200), 'TR')).toHaveLength(60);
  });
});

describe('decodeSubtitleBuffer', () => {
  it('reads UTF-8 and drops the byte order mark', () => {
    expect(decodeSubtitleBuffer(encode('\uFEFFmerhaba'))).toBe('merhaba');
  });

  it('falls back to a legacy codepage rather than rejecting the file', () => {
    // 0xFD is "ı" in windows-1254 and not valid UTF-8 on its own.
    const decoded = decodeSubtitleBuffer(new Uint8Array([0x61, 0xfd, 0x62]));
    expect(decoded).not.toBeNull();
    expect(decoded).toHaveLength(3);
  });
});

describe('parseSubtitleCues', () => {
  it('parses SRT, comma decimals and sequence numbers included', () => {
    const cues = parseSubtitleCues(
      [
        '1',
        '00:00:01,000 --> 00:00:02,500',
        'Merhaba',
        '',
        '2',
        '00:00:03,000 --> 00:00:04,000',
        'Dünya',
        '',
      ].join('\n')
    );
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: 'Merhaba' },
      { start: 3, end: 4, text: 'Dünya' },
    ]);
  });

  it('parses WebVTT with cue ids, settings and short timestamps', () => {
    const cues = parseSubtitleCues(
      ['WEBVTT', '', 'intro', '00:01.000 --> 00:02.000 align:start position:10%', 'Hello', ''].join(
        '\n'
      )
    );
    expect(cues).toEqual([{ start: 1, end: 2, text: 'Hello' }]);
  });

  it('skips NOTE, STYLE and REGION blocks', () => {
    const cues = parseSubtitleCues(
      [
        'WEBVTT',
        '',
        'NOTE this is a comment',
        'still the comment',
        '',
        'STYLE',
        '::cue { color: red }',
        '',
        '00:00:01.000 --> 00:00:02.000',
        'Kept',
        '',
      ].join('\n')
    );
    expect(cues).toEqual([{ start: 1, end: 2, text: 'Kept' }]);
  });

  it('drops cues that end before they start and cues with no text', () => {
    const cues = parseSubtitleCues(
      [
        '00:00:05,000 --> 00:00:02,000',
        'Backwards',
        '',
        '00:00:06,000 --> 00:00:07,000',
        '',
        '00:00:08,000 --> 00:00:09,000',
        'Good',
        '',
      ].join('\n')
    );
    expect(cues).toEqual([{ start: 8, end: 9, text: 'Good' }]);
  });

  it('keeps known cue markup and removes everything else', () => {
    const cues = parseSubtitleCues(
      ['00:00:01,000 --> 00:00:02,000', '<i>tilt</i><script>alert(1)</script>{\\an8}', ''].join(
        '\n'
      )
    );
    expect(cues[0].text).toBe('<i>tilt</i>alert(1)');
  });

  it('escapes the leftovers of a rejected tag so it cannot be reassembled', () => {
    // Deleting `<b>` out of the middle would close the two halves into a `<script>` that
    // was never written. Escaping what is left over is what stops that.
    const cues = parseSubtitleCues(
      ['00:00:01,000 --> 00:00:02,000', '<scr<b>ipt>alert(1)', ''].join('\n')
    );
    expect(cues[0].text).toBe('&lt;scr<b>ipt&gt;alert(1)');
    expect(cues[0].text).not.toContain('<script');
  });

  it('neutralises an arrow in cue text so the file cannot be re-split', () => {
    const cues = parseSubtitleCues(['00:00:01,000 --> 00:00:02,000', 'a --> b', ''].join('\n'));
    expect(cues[0].text).toBe('a --&gt; b');
    expect(parseSubtitleCues(serializeWebVtt(cues))).toHaveLength(1);
  });

  it('stops at the cue ceiling', () => {
    const lines: string[] = [];
    for (let index = 0; index < MAX_SUBTITLE_CUES + 10; index += 1) {
      lines.push(`00:00:0${index % 9}.000 --> 00:00:0${(index % 9) + 1}.000`, `line ${index}`, '');
    }
    expect(parseSubtitleCues(lines.join('\n'))).toHaveLength(MAX_SUBTITLE_CUES);
  });
});

describe('normalizeSubtitleFile', () => {
  it('converts SRT to a canonical WebVTT document', () => {
    const result = normalizeSubtitleFile(
      encode('1\r\n00:00:01,500 --> 00:00:02,000\r\nMerhaba\r\n\r\n')
    );
    expect(result).toEqual({
      ok: true,
      cueCount: 1,
      vtt: 'WEBVTT\n\n00:00:01.500 --> 00:00:02.000\nMerhaba\n',
    });
  });

  it('refuses an empty file', () => {
    const result = normalizeSubtitleFile(new Uint8Array());
    expect(result.ok).toBe(false);
  });

  it('refuses a file with no cues rather than storing an empty track', () => {
    const result = normalizeSubtitleFile(encode('this is just prose\nand more prose\n'));
    expect(result).toEqual({
      ok: false,
      error: 'No subtitle cues found. Upload a valid .srt or .vtt file.',
    });
  });
});

describe('subtitle proxy paths', () => {
  it('only recognises a uuid .vtt path', () => {
    expect(SAFE_SUBTITLE_PROXY_PATH.test(`/api/upload/subtitle/${UUID}.vtt`)).toBe(true);
    expect(SAFE_SUBTITLE_PROXY_PATH.test(`/api/upload/subtitle/${UUID}.srt`)).toBe(false);
    expect(SAFE_SUBTITLE_PROXY_PATH.test('/api/upload/subtitle/../../etc/passwd')).toBe(false);
  });

  it('maps a proxy path to its object key and refuses anything else', () => {
    expect(subtitleProxyPathToObjectKey(`/api/upload/subtitle/${UUID}.vtt`)).toBe(
      `subtitles/${UUID}.vtt`
    );
    expect(subtitleProxyPathToObjectKey(`/api/upload/image/${UUID}.png`)).toBeNull();
  });
});

describe('serializeWebVtt timestamps', () => {
  /**
   * A fraction that rounds up to a whole second used to be formatted as
   * `00:00:01.1000`: the seconds field was floored from the unrounded value
   * while the millisecond field was rounded on its own. WebVTT allows exactly
   * three digits there, so browsers dropped the cue.
   */
  it('carries a rounded-up millisecond into the seconds field', () => {
    const vtt = serializeWebVtt([{ start: 1.9997, end: 2.5, text: 'x' }]);
    expect(vtt).toContain('00:00:02.000 --> 00:00:02.500');
    expect(vtt).not.toContain('.1000');
  });

  it('never writes a four-digit millisecond field, at any boundary', () => {
    const cues = [59.9999, 3599.9996, 0.9995, 7199.99999].map((start) => ({
      start,
      end: start + 1,
      text: 'x',
    }));
    const timings = serializeWebVtt(cues)
      .split('\n')
      .filter((line) => line.includes('-->'));
    expect(timings).toEqual([
      '00:01:00.000 --> 00:01:01.000',
      '01:00:00.000 --> 01:00:01.000',
      '00:00:01.000 --> 00:00:02.000',
      '02:00:00.000 --> 02:00:01.000',
    ]);
    for (const line of timings) {
      expect(line).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/);
    }
  });
});
