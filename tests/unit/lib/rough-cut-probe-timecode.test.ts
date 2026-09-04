import { describe, expect, it } from 'vitest';
import {
  normalizeTimecode,
  parseCreationTimeFromFileName,
  parseMediaCreationTime,
  readEmbeddedCameraLabel,
  readEmbeddedCreationTime,
  readEmbeddedTimecode,
} from '@/lib/rough-cut/probe-timecode';

describe('readEmbeddedTimecode', () => {
  it('prefers the format-level timecode tag', () => {
    expect(
      readEmbeddedTimecode({
        format: { tags: { timecode: '01:00:00:00' } },
        streams: [{ codec_type: 'video', tags: { timecode: '02:00:00:00' } }],
      })
    ).toBe('01:00:00:00');
  });

  it('falls back to a stream tag, then a tmcd data stream', () => {
    expect(
      readEmbeddedTimecode({
        streams: [{ codec_type: 'video', tags: { TIMECODE: '00:00:10:00' } }],
      })
    ).toBe('00:00:10:00');

    expect(
      readEmbeddedTimecode({
        streams: [
          { codec_type: 'video', tags: {} },
          { codec_type: 'data', codec_name: 'tmcd', tags: { timecode: '01:00:00;00' } },
        ],
      })
    ).toBe('01:00:00;00');
  });

  it('does not let a non-tmcd data stream steal the later tmcd tag', () => {
    expect(
      readEmbeddedTimecode({
        streams: [
          { codec_type: 'data', codec_name: 'other', tags: { timecode: '09:00:00:00' } },
          { codec_type: 'data', codec_name: 'tmcd', tags: { timecode: '01:00:00:00' } },
        ],
      })
    ).toBe('01:00:00:00');
  });

  it('reads a time-code data stream that ffprobe did not name tmcd', () => {
    expect(
      readEmbeddedTimecode({
        streams: [
          {
            codec_type: 'data',
            codec_name: 'unknown',
            tags: { handler_name: 'Time Code Media Handler', time_code: '15:41:07:10' },
          },
        ],
      })
    ).toBe('15:41:07:10');
  });

  it('normalizes a dotted frame separator and an 8-digit packed value', () => {
    expect(normalizeTimecode('01:00:00.12')).toBe('01:00:00:12');
    expect(normalizeTimecode('01000012')).toBe('01:00:00:12');
    expect(
      readEmbeddedTimecode({
        format: { tags: { timecode: '01:00:00.12' } },
      })
    ).toBe('01:00:00:12');
  });

  it('ignores values that are not SMPTE timecode', () => {
    expect(
      readEmbeddedTimecode({
        format: { tags: { timecode: 'not-a-timecode' } },
      })
    ).toBeNull();
  });
});

describe('parseMediaCreationTime', () => {
  it('parses ffmpeg UTC creation_time', () => {
    expect(parseMediaCreationTime('2026-03-15T14:22:01.000000Z')?.toISOString()).toBe(
      '2026-03-15T14:22:01.000Z'
    );
  });

  it('parses EXIF-style colon dates that Date.parse rejects', () => {
    expect(Date.parse('2026:03:15 14:22:01')).toBeNaN();
    expect(parseMediaCreationTime('2026:03:15 14:22:01')?.toISOString()).toBe(
      '2026-03-15T14:22:01.000Z'
    );
  });

  it('parses a compact camera-roll timestamp', () => {
    expect(parseMediaCreationTime('20260315_142201')?.toISOString()).toBe(
      '2026-03-15T14:22:01.000Z'
    );
  });

  it('ignores SMPTE timecode masquerading as creation_time', () => {
    expect(parseMediaCreationTime('01:00:00:00')).toBeNull();
  });
});

describe('readEmbeddedCreationTime', () => {
  it('reads format.tags.creation_time', () => {
    expect(
      readEmbeddedCreationTime({
        format: { tags: { creation_time: '2026-03-15T14:22:01.000000Z' } },
      })?.toISOString()
    ).toBe('2026-03-15T14:22:01.000Z');
  });

  it('reads a QuickTime date tag, then a generic date tag', () => {
    expect(
      readEmbeddedCreationTime({
        format: { tags: { 'com.apple.quicktime.creationdate': '2026-03-15T14:22:01+0100' } },
      })?.toISOString()
    ).toBe('2026-03-15T13:22:01.000Z');

    expect(
      readEmbeddedCreationTime({
        format: { tags: { date: '2026:03:15 14:22:01' } },
      })?.toISOString()
    ).toBe('2026-03-15T14:22:01.000Z');
  });

  it('falls back to the original file name when tags are missing', () => {
    expect(
      readEmbeddedCreationTime({ format: { tags: {} } }, 'VID_20260315_142201.mp4')?.toISOString()
    ).toBe('2026-03-15T14:22:01.000Z');
  });

  it('ignores SMPTE timecode masquerading as creation_time', () => {
    expect(
      readEmbeddedCreationTime({
        format: { tags: { creation_time: '01:00:00:00' } },
      })
    ).toBeNull();
  });
});

describe('parseCreationTimeFromFileName', () => {
  it('reads Pixel and DJI date stamps and ignores clip numbers', () => {
    expect(parseCreationTimeFromFileName('PXL_20260315_142201123.mp4')?.toISOString()).toBe(
      '2026-03-15T14:22:01.000Z'
    );
    expect(parseCreationTimeFromFileName('DJI_20260315142201_0001_D.MP4')?.toISOString()).toBe(
      '2026-03-15T14:22:01.000Z'
    );
    expect(parseCreationTimeFromFileName('Clip_002.mp4')).toBeNull();
    expect(parseCreationTimeFromFileName('GH011234.MP4')).toBeNull();
  });
});

describe('readEmbeddedCameraLabel', () => {
  it('combines QuickTime make and model', () => {
    expect(
      readEmbeddedCameraLabel({
        format: {
          tags: {
            'com.apple.quicktime.make': 'Apple',
            'com.apple.quicktime.model': 'iPhone 15 Pro',
          },
        },
      })
    ).toBe('Apple iPhone 15 Pro');
  });

  it('ignores muxer encoder strings', () => {
    expect(
      readEmbeddedCameraLabel({
        format: { tags: { encoder: 'Lavf60.16.100' } },
      })
    ).toBeNull();
  });
});
