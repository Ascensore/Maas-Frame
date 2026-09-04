import { snapshotFromProfile } from './profile';
import type { ResolvedRoughCutProfile } from './types';

export const ASSEMBLY_ROLE_MAX = 40;
export const ASSEMBLY_CLIP_ORDER_MAX = 200;

export type RoughCutAssemblyOverrides = {
  clipOrder: string[] | null;
  cameraRoles: Record<string, string> | null;
  wideCameraRole: string | null;
};

function roleValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > ASSEMBLY_ROLE_MAX) return null;
  return trimmed.toUpperCase();
}

export function parseClipOrder(
  value: unknown,
  allowedIds: ReadonlySet<string>
): { ok: true; value: string[] | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  if (!Array.isArray(value)) {
    return { ok: false, error: 'clipOrder must be an array of video ids' };
  }
  if (value.length === 0) return { ok: true, value: null };
  if (value.length > ASSEMBLY_CLIP_ORDER_MAX) {
    return { ok: false, error: `clipOrder may have at most ${ASSEMBLY_CLIP_ORDER_MAX} ids` };
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) {
      return { ok: false, error: 'clipOrder must be an array of video ids' };
    }
    const id = entry.trim();
    if (!allowedIds.has(id)) {
      return { ok: false, error: 'clipOrder includes a video that is not in this folder' };
    }
    if (seen.has(id)) {
      return { ok: false, error: 'clipOrder must not repeat a video id' };
    }
    seen.add(id);
    ordered.push(id);
  }

  for (const id of allowedIds) {
    if (!seen.has(id)) ordered.push(id);
  }
  return { ok: true, value: ordered };
}

export function parseCameraRoles(
  value: unknown,
  allowedIds: ReadonlySet<string>
): { ok: true; value: Record<string, string> | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'cameraRoles must be an object of video id to camera name' };
  }

  const roles: Record<string, string> = {};
  for (const [rawId, rawRole] of Object.entries(value as Record<string, unknown>)) {
    const id = rawId.trim();
    if (!allowedIds.has(id)) {
      return { ok: false, error: 'cameraRoles includes a video that is not in this folder' };
    }
    if (typeof rawRole !== 'string') {
      return { ok: false, error: 'cameraRoles values must be strings' };
    }
    const role = roleValue(rawRole);
    if (!role) {
      return {
        ok: false,
        error: `cameraRoles values must be 1-${ASSEMBLY_ROLE_MAX} characters`,
      };
    }
    roles[id] = role;
  }

  return { ok: true, value: Object.keys(roles).length > 0 ? roles : null };
}

export function parseWideCameraRole(
  value: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== 'string') {
    return { ok: false, error: 'wideCameraRole must be a string' };
  }
  const role = roleValue(value);
  if (!role) {
    return { ok: false, error: `wideCameraRole must be 1-${ASSEMBLY_ROLE_MAX} characters` };
  }
  return { ok: true, value: role };
}

export function applyClipOrder<T extends { id: string }>(clips: T[], orderedIds: string[]): T[] {
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const ordered: T[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const clip = byId.get(id);
    if (!clip || seen.has(id)) continue;
    ordered.push(clip);
    seen.add(id);
  }
  for (const clip of clips) {
    if (!seen.has(clip.id)) ordered.push(clip);
  }
  return ordered;
}

export function applyCameraRole(
  videoId: string,
  inferred: string,
  overrides: Record<string, string> | null
): string {
  const fromOverride = overrides?.[videoId];
  if (fromOverride && fromOverride.trim()) return fromOverride.trim().toUpperCase();
  return inferred;
}

export function assemblyFromSnapshot(value: unknown): {
  clipOrder: string[] | null;
  cameraRoles: Record<string, string> | null;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { clipOrder: null, cameraRoles: null };
  }
  const raw = value as Record<string, unknown>;
  let clipOrder: string[] | null = null;
  if (Array.isArray(raw.clipOrder)) {
    const ids = raw.clipOrder.filter(
      (entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())
    );
    clipOrder = ids.length > 0 ? ids.map((id) => id.trim()) : null;
  }
  let cameraRoles: Record<string, string> | null = null;
  if (raw.cameraRoles && typeof raw.cameraRoles === 'object' && !Array.isArray(raw.cameraRoles)) {
    const roles: Record<string, string> = {};
    for (const [id, role] of Object.entries(raw.cameraRoles as Record<string, unknown>)) {
      if (typeof role !== 'string') continue;
      const cleaned = roleValue(role);
      if (cleaned) roles[id] = cleaned;
    }
    cameraRoles = Object.keys(roles).length > 0 ? roles : null;
  }
  return { clipOrder, cameraRoles };
}

export function snapshotWithAssembly(
  profile: ResolvedRoughCutProfile,
  overrides: RoughCutAssemblyOverrides
): ResolvedRoughCutProfile & {
  clipOrder?: string[];
  cameraRoles?: Record<string, string>;
} {
  const snapshot: ResolvedRoughCutProfile & {
    clipOrder?: string[];
    cameraRoles?: Record<string, string>;
  } = {
    ...snapshotFromProfile({
      ...profile,
      wideCameraRole: overrides.wideCameraRole ?? profile.wideCameraRole,
    }),
  };
  if (overrides.clipOrder && overrides.clipOrder.length > 0) {
    snapshot.clipOrder = overrides.clipOrder;
  }
  if (overrides.cameraRoles && Object.keys(overrides.cameraRoles).length > 0) {
    snapshot.cameraRoles = overrides.cameraRoles;
  }
  return snapshot;
}
