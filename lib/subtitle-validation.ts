/**
 * Subtitle uploads are normalised before they are stored: whatever the user hands us,
 * SRT or WebVTT, is parsed into cues and re-serialised as a canonical WebVTT file.
 * Anything we did not understand is dropped rather than passed through, so the file the
 * player fetches contains cues and nothing else. That is what makes it safe to serve a
 * user-supplied text file from our own origin.
 */

/** Uploaded subtitle files are text. Two megabytes is a feature-length film with room to spare. */
export const MAX_SUBTITLE_FILE_SIZE = 2 * 1024 * 1024;

/** Ceiling on the normalised output, so a pathological input cannot be stored. */
export const MAX_NORMALIZED_SUBTITLE_SIZE = 1024 * 1024;

export const MAX_SUBTITLE_CUES = 5000;

/** Longer than this and it is not a subtitle, it is a document being smuggled in. */
const MAX_CUE_TEXT_LENGTH = 500;

export const ALLOWED_SUBTITLE_EXTENSIONS = ['vtt', 'srt'] as const;

export const SUBTITLE_OBJECT_KEY_PREFIX = 'subtitles/';

export const SUBTITLE_PROXY_PREFIX = '/api/upload/subtitle/';

/** The only shape a subtitle URL may take once it has been through our upload API. */
export const SAFE_SUBTITLE_PROXY_PATH =
  /^\/api\/upload\/subtitle\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.vtt$/i;

export const SAFE_SUBTITLE_FILENAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.vtt$/i;

export const SUBTITLE_CONTENT_TYPE = 'text/vtt; charset=utf-8';

/** Room for a label a human typed, not for a paragraph. */
const MAX_SUBTITLE_LABEL_LENGTH = 60;

/**
 * BCP-47, narrowed: a primary subtag plus optional subtags. Wide enough for `tr`,
 * `en-US` and `zh-Hant-TW`, narrow enough that the value is safe in an HTML attribute
 * and in a unique index.
 */
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i;

export type SubtitleCue = {
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  text: string;
};

export type SubtitleNormalizeResult =
  | { ok: true; vtt: string; cueCount: number }
  | { ok: false; error: string };

/**
 * Cue text may carry a small amount of WebVTT markup. Everything outside this list is
 * removed: the browser's VTT parser does not execute scripts, but a file that only ever
 * contains tags we recognise is one less thing to reason about.
 */
const ALLOWED_CUE_TAGS = [
  /^<\/?[biu]>$/i,
  /^<\/?ruby>$/i,
  /^<\/?rt>$/i,
  /^<\/?c(?:\.[\w-]+)*>$/i,
  /^<v(?:\.[\w-]+)*(?:\s+[^<>]{1,80})?>$/i,
  /^<\/v>$/i,
  /^<\d{1,3}:\d{2}(?::\d{2})?\.\d{3}>$/,
];

export function getSubtitleExtension(fileName: string): 'vtt' | 'srt' | null {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'vtt' || ext === 'srt') return ext;
  return null;
}

/**
 * Normalise a language tag for storage. Kept lowercase so the unique index on
 * (version, language) treats `TR` and `tr` as the same track.
 */
export function normalizeSubtitleLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !LANGUAGE_TAG.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function sanitizeSubtitleLabel(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value : '';
  const normalized = raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return fallback;
  return normalized.slice(0, MAX_SUBTITLE_LABEL_LENGTH);
}

/**
 * Subtitle files written by desktop editors are routinely not UTF-8. A Turkish SRT saved
 * out of a Windows tool is usually windows-1254, and rejecting it outright would send the
 * user off to convert a file we can decode ourselves. UTF-8 is tried strictly first so a
 * valid file is never mangled by a legacy codepage.
 */
export function decodeSubtitleBuffer(buffer: Uint8Array): string | null {
  for (const encoding of ['utf-8', 'windows-1254', 'windows-1252']) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: true }).decode(buffer);
      return decoded.replace(/^\uFEFF/, '');
    } catch {
      // Wrong encoding, or one this runtime's ICU build does not carry. Try the next.
    }
  }
  return null;
}

function parseTimestamp(value: string): number | null {
  const match = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]?\d)[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4].padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function formatTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalMillis = Math.round(clamped * 1000);
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const secs = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function parseTimingLine(line: string): { start: number; end: number } | null {
  const separatorIndex = line.indexOf('-->');
  if (separatorIndex === -1) return null;
  const start = parseTimestamp(line.slice(0, separatorIndex));
  // Anything after the end timestamp is a cue setting (position, align, line). They are
  // dropped: the player positions cues itself so its own control bar does not cover them.
  const rest = line.slice(separatorIndex + 3).trim();
  const end = parseTimestamp(rest.split(/\s+/)[0] ?? '');
  if (start === null || end === null) return null;
  return { start, end };
}

function sanitizeCueLine(line: string): string {
  return (
    line
      // ASS/SSA override blocks travel in SRT files ripped from other formats. The VTT
      // parser renders them as literal text, which is never what the author meant.
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/<[^<>]*>/g, (tag) => (ALLOWED_CUE_TAGS.some((re) => re.test(tag)) ? tag : ''))
      // A cue text line containing an arrow would be read back as a timing line and split
      // the cue in two. The entity is what the WebVTT parser expects for a literal `>`.
      .replace(/-->/g, '--&gt;')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trimEnd()
  );
}

/**
 * Parse SRT or WebVTT into cues. Unknown blocks (NOTE, STYLE, REGION, cue identifiers,
 * SRT sequence numbers) are skipped rather than carried over.
 */
export function parseSubtitleCues(input: string): SubtitleCue[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const cues: SubtitleCue[] = [];

  let index = 0;
  // A STYLE or REGION block runs until the next blank line and may itself contain no
  // timing, so it is skipped wholesale rather than line by line.
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^(?:WEBVTT|NOTE|STYLE|REGION)\b/.test(trimmed)) {
      index += 1;
      while (index < lines.length && lines[index].trim()) index += 1;
      continue;
    }

    // A cue may be preceded by an identifier line (an SRT sequence number, or a VTT cue
    // id). The timing is then on the following line.
    let timing = parseTimingLine(trimmed);
    if (!timing) {
      const next = lines[index + 1]?.trim();
      if (!next) {
        index += 1;
        continue;
      }
      timing = parseTimingLine(next);
      if (!timing) {
        index += 1;
        continue;
      }
      index += 1;
    }
    index += 1;

    const textLines: string[] = [];
    while (index < lines.length && lines[index].trim()) {
      const sanitized = sanitizeCueLine(lines[index]);
      if (sanitized.trim()) textLines.push(sanitized);
      index += 1;
    }

    if (timing.end <= timing.start) continue;
    const text = textLines.join('\n').slice(0, MAX_CUE_TEXT_LENGTH).trim();
    if (!text) continue;

    cues.push({ start: timing.start, end: timing.end, text });
    if (cues.length >= MAX_SUBTITLE_CUES) break;
  }

  return cues;
}

export function serializeWebVtt(cues: SubtitleCue[]): string {
  const body = cues
    .map((cue) => `${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

/**
 * The whole pipeline: bytes in, a canonical WebVTT string out, or a message explaining
 * what is wrong with the file in terms the person who uploaded it can act on.
 */
export function normalizeSubtitleFile(buffer: Uint8Array): SubtitleNormalizeResult {
  if (buffer.byteLength === 0) {
    return { ok: false, error: 'Subtitle file is empty' };
  }

  const decoded = decodeSubtitleBuffer(buffer);
  if (decoded === null) {
    return { ok: false, error: 'Could not read the subtitle file. Save it as UTF-8 and retry.' };
  }

  const cues = parseSubtitleCues(decoded);
  if (cues.length === 0) {
    return { ok: false, error: 'No subtitle cues found. Upload a valid .srt or .vtt file.' };
  }

  const vtt = serializeWebVtt(cues);
  if (Buffer.byteLength(vtt, 'utf8') > MAX_NORMALIZED_SUBTITLE_SIZE) {
    return { ok: false, error: 'Subtitle file is too large after conversion' };
  }

  return { ok: true, vtt, cueCount: cues.length };
}

export function subtitleFileNameToProxyUrl(fileName: string): string {
  return `${SUBTITLE_PROXY_PREFIX}${fileName}`;
}

export function extractSubtitleFileNameFromProxyUrl(url: string): string | null {
  if (!SAFE_SUBTITLE_PROXY_PATH.test(url)) return null;
  return url.slice(SUBTITLE_PROXY_PREFIX.length) || null;
}

export function subtitleProxyPathToObjectKey(url: string): string | null {
  const fileName = extractSubtitleFileNameFromProxyUrl(url);
  if (!fileName) return null;
  return `${SUBTITLE_OBJECT_KEY_PREFIX}${fileName}`;
}
