import { describe, expect, it } from 'vitest';
import { readEmbeddedTimecode } from '@/lib/rough-cut/probe-timecode';

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

  it('ignores values that are not SMPTE timecode', () => {
    expect(
      readEmbeddedTimecode({
        format: { tags: { timecode: 'not-a-timecode' } },
      })
    ).toBeNull();
  });
});
