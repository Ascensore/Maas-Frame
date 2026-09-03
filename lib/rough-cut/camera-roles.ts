export function metadataStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' && raw.trim()) result[key] = raw.trim();
  }
  return result;
}

function lookupMetadata(metadata: Record<string, string>, key: string): string | null {
  const exact = metadata[key]?.trim();
  if (exact) return exact;
  const wanted = key.toLowerCase();
  for (const [entryKey, entryValue] of Object.entries(metadata)) {
    if (entryKey.toLowerCase() === wanted && entryValue.trim()) return entryValue.trim();
  }
  return null;
}

const WIDE_RE = /\b(wide|wideshot|wide-shot|safety|master)\b/i;
const CAMERA_RE = /\bcam(?:era)?[\s._-]*([a-z0-9]+)/i;
const ANGLE_RE = /\bangle[\s._-]*([a-z0-9]+)/i;

export function inferCameraRole(
  title: string,
  metadata: Record<string, string>,
  metadataKey: string
): string {
  const fromMeta = lookupMetadata(metadata, metadataKey);
  if (fromMeta) return fromMeta.toUpperCase();

  if (WIDE_RE.test(title)) return 'WIDE';

  const camera = CAMERA_RE.exec(title);
  if (camera?.[1]) return camera[1].toUpperCase();

  const angle = ANGLE_RE.exec(title);
  if (angle?.[1]) return angle[1].toUpperCase();

  return 'CAM';
}

export function pickWideClip<T extends { role: string; position: number; videoId: string }>(
  clips: T[],
  wideCameraRole: string
): { clip: T; inferred: boolean } | null {
  if (clips.length === 0) return null;
  const wanted = wideCameraRole.trim().toUpperCase();
  const ranked = [...clips].sort(
    (a, b) => a.position - b.position || a.videoId.localeCompare(b.videoId)
  );
  const match = ranked.find((clip) => clip.role.toUpperCase() === wanted);
  if (match) return { clip: match, inferred: false };
  return { clip: ranked[0]!, inferred: true };
}

export function assignStackedTracks<T extends { role: string; versionId: string }>(
  clips: T[]
): Map<string, number> {
  const uniqueRoles = [...new Set(clips.map((clip) => clip.role.toUpperCase()))];
  uniqueRoles.sort((a, b) => {
    if (a === 'WIDE' && b !== 'WIDE') return -1;
    if (b === 'WIDE' && a !== 'WIDE') return 1;
    return a.localeCompare(b);
  });
  const roleToTrack = new Map<string, number>();
  uniqueRoles.forEach((role, index) => {
    roleToTrack.set(role, index + 2);
  });
  const tracks = new Map<string, number>();
  for (const clip of clips) {
    tracks.set(clip.versionId, roleToTrack.get(clip.role.toUpperCase()) ?? 2);
  }
  return tracks;
}
