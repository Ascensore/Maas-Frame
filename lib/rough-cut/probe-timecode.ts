import { parseTimecode } from '../timecode';

const CREATION_TIME_KEYS = ['creation_time', 'com.apple.quicktime.creationdate'];

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

export function parseMediaCreationTime(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (parseTimecode(trimmed)) return null;
  const isoish = /T/.test(trimmed) ? trimmed : trimmed.replace(' ', 'T');
  const ms = Date.parse(isoish);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  if (year < 1990 || year > 2100) return null;
  return date;
}

function firstCreationTime(tags?: Record<string, string | undefined>): Date | null {
  if (!tags) return null;
  for (const key of CREATION_TIME_KEYS) {
    const exact = tags[key];
    if (exact) {
      const parsed = parseMediaCreationTime(exact);
      if (parsed) return parsed;
    }
  }
  for (const [key, value] of Object.entries(tags)) {
    if (!value) continue;
    if (!/creation[_-]?time|creationdate/i.test(key)) continue;
    const parsed = parseMediaCreationTime(value);
    if (parsed) return parsed;
  }
  return null;
}

export function readEmbeddedCreationTime(probe: ProbeJson): Date | null {
  const fromFormat = firstCreationTime(probe.format?.tags);
  if (fromFormat) return fromFormat;
  for (const stream of probe.streams ?? []) {
    const fromStream = firstCreationTime(stream.tags);
    if (fromStream) return fromStream;
  }
  return null;
}
