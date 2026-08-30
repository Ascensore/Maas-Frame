export const VIDEO_METADATA_MAX_FIELDS = 20;
export const VIDEO_METADATA_MAX_VALUE_LENGTH = 200;

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;

export type ParsedVideoMetadata =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string };

export function parseVideoMetadata(input: unknown): ParsedVideoMetadata {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Metadata must be an object of string fields' };
  }

  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > VIDEO_METADATA_MAX_FIELDS) {
    return { ok: false, error: 'Metadata may have at most 20 fields' };
  }

  const value: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    if (typeof rawValue !== 'string') {
      return { ok: false, error: 'Metadata values must be strings' };
    }
    const key = rawKey.trim();
    const trimmedValue = rawValue.trim();
    if (!KEY_PATTERN.test(key)) {
      return {
        ok: false,
        error: 'Metadata field names must be 1-40 letters, numbers, spaces, or _.-',
      };
    }
    if (trimmedValue.length > VIDEO_METADATA_MAX_VALUE_LENGTH) {
      return { ok: false, error: 'Metadata values must be 200 characters or fewer' };
    }
    value[key] = trimmedValue;
  }

  return { ok: true, value };
}
