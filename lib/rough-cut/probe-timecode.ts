import { parseTimecode } from '../timecode';

export type ProbeJson = {
  format?: { tags?: Record<string, string | undefined> };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    codec_tag_string?: string;
    tags?: Record<string, string | undefined>;
  }>;
};

function firstTimecode(tags?: Record<string, string | undefined>): string | null {
  if (!tags) return null;
  for (const [key, value] of Object.entries(tags)) {
    if (!value) continue;
    if (!/timecode/i.test(key)) continue;
    const trimmed = value.trim();
    if (parseTimecode(trimmed)) return trimmed;
  }
  return null;
}

export function readEmbeddedTimecode(probe: ProbeJson): string | null {
  const fromFormat = firstTimecode(probe.format?.tags);
  if (fromFormat) return fromFormat;

  const streams = probe.streams ?? [];
  for (const stream of streams) {
    if (stream.codec_type === 'data') continue;
    const fromTags = firstTimecode(stream.tags);
    if (fromTags) return fromTags;
  }

  const tmcd = streams.find(
    (stream) =>
      stream.codec_type === 'data' &&
      (stream.codec_name === 'tmcd' || stream.codec_tag_string === 'tmcd')
  );
  return firstTimecode(tmcd?.tags);
}
