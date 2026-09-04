import { parseTimecode } from '../timecode';

const CREATION_TIME_KEYS = [
  'creation_time',
  'com.apple.quicktime.creationdate',
  'date',
  'encoded_date',
  'tagged_date',
  'datetimeoriginal',
  'recorded_date',
  'media_create_date',
];

const CAMERA_MODEL_KEYS = [
  'com.apple.quicktime.model',
  'model',
  'com.apple.quicktime.camera.identifier',
  'device_model',
  'camera',
];

const CAMERA_MAKE_KEYS = ['com.apple.quicktime.make', 'make', 'manufacturer'];

const MUXER_ENCODER_RE = /(^|[^a-z])(lavf|lavc|ffmpeg|libx264|libx265|premiere|media encoder)/i;

export type ProbeJson = {
  format?: { tags?: Record<string, string | number | undefined> };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    codec_tag_string?: string;
    tags?: Record<string, string | number | undefined>;
  }>;
};

function tagText(value: string | number | undefined): string | null {
  if (value == null) return null;
  const text = typeof value === 'string' ? value.trim() : String(value).trim();
  return text || null;
}

function tagRecord(tags?: Record<string, string | number | undefined>): Record<string, string> {
  if (!tags) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    const text = tagText(value);
    if (text) result[key] = text;
  }
  return result;
}

function lookupTag(tags: Record<string, string>, key: string): string | null {
  const exact = tags[key]?.trim();
  if (exact) return exact;
  const wanted = key.toLowerCase();
  for (const [entryKey, entryValue] of Object.entries(tags)) {
    if (entryKey.toLowerCase() === wanted && entryValue.trim()) return entryValue.trim();
  }
  return null;
}

function isTimecodeKey(key: string): boolean {
  return /time[_-]?code/i.test(key);
}

function isTmcdStream(stream: NonNullable<ProbeJson['streams']>[number]): boolean {
  if (stream.codec_type !== 'data') return false;
  const name = (stream.codec_name ?? '').toLowerCase();
  const tag = (stream.codec_tag_string ?? '').toLowerCase();
  if (name === 'tmcd' || tag === 'tmcd') return true;
  const handler = tagRecord(stream.tags).handler_name ?? '';
  return /time\s*code/i.test(handler);
}

/**
 * Accept SMPTE as `HH:MM:SS:FF`, drop-frame `HH:MM:SS;FF`, a frame-dot
 * `HH:MM:SS.FF`, or an 8-digit `HHMMSSFF` when the tag name already says timecode.
 */
export function normalizeTimecode(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (parseTimecode(trimmed)) return trimmed;

  const dotted = /^(\d{1,3}):([0-5]\d):([0-5]\d)\.(\d{1,3})$/.exec(trimmed);
  if (dotted) {
    const rewritten = `${dotted[1]}:${dotted[2]}:${dotted[3]}:${dotted[4]}`;
    return parseTimecode(rewritten) ? rewritten : null;
  }

  const compact = /^(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(trimmed);
  if (compact) {
    const rewritten = `${compact[1]}:${compact[2]}:${compact[3]}:${compact[4]}`;
    return parseTimecode(rewritten) ? rewritten : null;
  }

  return null;
}

function firstTimecode(tags?: Record<string, string | number | undefined>): string | null {
  const record = tagRecord(tags);
  for (const [key, value] of Object.entries(record)) {
    if (!isTimecodeKey(key)) continue;
    const normalized = normalizeTimecode(value);
    if (normalized) return normalized;
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

  const tmcd = streams.find((stream) => isTmcdStream(stream));
  const fromTmcd = firstTimecode(tmcd?.tags);
  if (fromTmcd) return fromTmcd;

  for (const stream of streams) {
    if (stream.codec_type !== 'data') continue;
    const fromData = firstTimecode(stream.tags);
    if (fromData) return fromData;
  }

  return null;
}

function isPlausibleRecordingYear(year: number): boolean {
  return year >= 1990 && year <= 2100;
}

function dateFromParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): Date | null {
  if (!isPlausibleRecordingYear(year)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null;
  return date;
}

function parseCompactDateTime(value: string): Date | null {
  const match =
    /^(\d{4})[-_:]?(\d{2})[-_:]?(\d{2})(?:[T_ \-](\d{2})[:_]?(\d{2})[:_]?(\d{2}))?/.exec(
      value.trim()
    );
  if (!match) return null;
  return dateFromParts(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] ? Number(match[4]) : 0,
    match[5] ? Number(match[5]) : 0,
    match[6] ? Number(match[6]) : 0
  );
}

export function parseMediaCreationTime(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (parseTimecode(trimmed)) return null;

  const withoutUtc = trimmed.replace(/^utc\s+/i, '');
  const exif = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(withoutUtc);
  if (exif) {
    return dateFromParts(
      Number(exif[1]),
      Number(exif[2]),
      Number(exif[3]),
      Number(exif[4]),
      Number(exif[5]),
      Number(exif[6])
    );
  }

  const withColonTz = withoutUtc.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const isoish = /T/.test(withColonTz) ? withColonTz : withColonTz.replace(' ', 'T');
  const ms = Date.parse(isoish);
  if (Number.isFinite(ms)) {
    const date = new Date(ms);
    if (isPlausibleRecordingYear(date.getUTCFullYear())) return date;
  }

  return parseCompactDateTime(withoutUtc);
}

function isCreationTimeKey(key: string): boolean {
  const lowered = key.toLowerCase();
  if (lowered.includes('modif')) return false;
  return (
    /creation[_-]?time/.test(lowered) ||
    /creationdate/.test(lowered) ||
    /encoded[_-]?date/.test(lowered) ||
    /tagged[_-]?date/.test(lowered) ||
    /recorded[_-]?date/.test(lowered) ||
    /datetimeoriginal/.test(lowered) ||
    /media[_-]?create[_-]?date/.test(lowered) ||
    lowered === 'date' ||
    lowered === 'datetime' ||
    /(^|[._-])date$/.test(lowered)
  );
}

function isModificationTimeKey(key: string): boolean {
  return /modif/i.test(key) && /time|date/i.test(key);
}

function firstCreationTime(
  tags?: Record<string, string | number | undefined>,
  includeModification = false
): Date | null {
  const record = tagRecord(tags);
  for (const key of CREATION_TIME_KEYS) {
    const exact = lookupTag(record, key);
    if (!exact) continue;
    const parsed = parseMediaCreationTime(exact);
    if (parsed) return parsed;
  }
  for (const [key, value] of Object.entries(record)) {
    if (!isCreationTimeKey(key)) continue;
    const parsed = parseMediaCreationTime(value);
    if (parsed) return parsed;
  }
  if (!includeModification) return null;
  for (const [key, value] of Object.entries(record)) {
    if (!isModificationTimeKey(key)) continue;
    const parsed = parseMediaCreationTime(value);
    if (parsed) return parsed;
  }
  return null;
}

export function parseCreationTimeFromFileName(name: string): Date | null {
  if (!name.trim()) return null;
  const match =
    /(?:^|[^\d])((?:19|20)\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?:[-_T ]?([0-2]\d)[:_]?([0-5]\d)[:_]?([0-5]\d))?/.exec(
      name
    );
  if (!match) return null;
  return dateFromParts(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] ? Number(match[4]) : 0,
    match[5] ? Number(match[5]) : 0,
    match[6] ? Number(match[6]) : 0
  );
}

export function readEmbeddedCreationTime(probe: ProbeJson, fileName?: string | null): Date | null {
  const fromFormat = firstCreationTime(probe.format?.tags);
  if (fromFormat) return fromFormat;
  for (const stream of probe.streams ?? []) {
    const fromStream = firstCreationTime(stream.tags);
    if (fromStream) return fromStream;
  }

  const fromFormatMod = firstCreationTime(probe.format?.tags, true);
  if (fromFormatMod) return fromFormatMod;
  for (const stream of probe.streams ?? []) {
    const fromStreamMod = firstCreationTime(stream.tags, true);
    if (fromStreamMod) return fromStreamMod;
  }

  if (fileName) return parseCreationTimeFromFileName(fileName);
  return null;
}

function firstCameraTag(tags: Record<string, string>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = lookupTag(tags, key);
    if (value && !MUXER_ENCODER_RE.test(value)) return value;
  }
  return null;
}

function sanitizeCameraLabel(value: string): string | null {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed || MUXER_ENCODER_RE.test(collapsed)) return null;
  if (collapsed.length > 40) return collapsed.slice(0, 40).trim();
  return collapsed;
}

export function readEmbeddedCameraLabel(probe: ProbeJson): string | null {
  const bags = [
    tagRecord(probe.format?.tags),
    ...(probe.streams ?? []).map((stream) => tagRecord(stream.tags)),
  ];
  for (const tags of bags) {
    const model = firstCameraTag(tags, CAMERA_MODEL_KEYS);
    const make = firstCameraTag(tags, CAMERA_MAKE_KEYS);
    if (model && make && !model.toLowerCase().includes(make.toLowerCase())) {
      const combined = sanitizeCameraLabel(`${make} ${model}`);
      if (combined) return combined;
    }
    if (model) {
      const cleaned = sanitizeCameraLabel(model);
      if (cleaned) return cleaned;
    }
    if (make) {
      const cleaned = sanitizeCameraLabel(make);
      if (cleaned) return cleaned;
    }
  }
  return null;
}
