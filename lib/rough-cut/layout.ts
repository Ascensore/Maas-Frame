import { startTimecodeToSeconds, type FrameRate } from '../timecode';
import { inferCameraRole } from './camera-roles';
import type { CameraClip, RoughCutLayout } from './types';

export const LAYOUT_GUESS_REASONS = [
  'single-clip',
  'overlapping-timecode',
  'overlapping-recorded-at',
  'distinct-camera-metadata',
  'sequential-timecode',
  'sequential-recorded-at',
  'sequential-filenames',
  'distinct-camera-roles',
  'default-multicam',
] as const;

export type LayoutGuessReason = (typeof LAYOUT_GUESS_REASONS)[number];

export type LayoutGuessClip = {
  id: string;
  title: string;
  position: number;
  durationSeconds: number;
  startTimecode: string | null;
  recordedAt: string | null;
  createdAt: string | null;
  metadata: Record<string, string>;
};

export type LayoutGuess = {
  layout: RoughCutLayout;
  reason: LayoutGuessReason;
  orderedIds: string[];
};

const DEFAULT_RATE: FrameRate = { num: 24, den: 1, dropFrame: false };
const EPSILON = 1e-6;
const RECORDED_AT_KEYS = [
  'recorded_at',
  'recordedAt',
  'creation_time',
  'creationTime',
  'created',
  'date',
  'timestamp',
  'datetime',
];

export function parseRoughCutLayout(value: unknown): RoughCutLayout | null {
  if (value === 'MULTICAM' || value === 'SEQUENTIAL' || value === 'LINEAR') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  if (trimmed === 'MULTICAM' || trimmed === 'SEQUENTIAL' || trimmed === 'LINEAR') return trimmed;
  return null;
}

export function minimumClipsForLayout(layout: RoughCutLayout): number {
  return layout === 'MULTICAM' ? 2 : 1;
}

export function parseRecordedAtMs(value: string | null | undefined): number | null {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  const isoish = /T/.test(trimmed) ? trimmed : trimmed.replace(' ', 'T');
  const ms = Date.parse(isoish);
  if (!Number.isFinite(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  if (year < 1990 || year > 2100) return null;
  return ms;
}

export function naturalCompare(left: string, right: string): number {
  const leftParts = left.toLowerCase().match(/(\d+)|(\D+)/g) ?? [];
  const rightParts = right.toLowerCase().match(/(\d+)|(\D+)/g) ?? [];
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? '';
    const b = rightParts[index] ?? '';
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff;
      continue;
    }
    const diff = a.localeCompare(b);
    if (diff !== 0) return diff;
  }
  return 0;
}

function timecodeSeconds(clip: LayoutGuessClip, rate: FrameRate): number | null {
  if (!clip.startTimecode) return null;
  return startTimecodeToSeconds(clip.startTimecode, rate);
}

function recordedAtMs(clip: LayoutGuessClip): number | null {
  const fromField = parseRecordedAtMs(clip.recordedAt);
  if (fromField !== null) return fromField;
  for (const key of RECORDED_AT_KEYS) {
    const raw = clip.metadata[key];
    if (!raw) continue;
    const parsed = parseRecordedAtMs(raw);
    if (parsed !== null) return parsed;
  }
  return null;
}

function rangesOverlap(
  startA: number,
  durationA: number,
  startB: number,
  durationB: number
): boolean {
  const endA = startA + Math.max(0, durationA);
  const endB = startB + Math.max(0, durationB);
  return startA < endB - EPSILON && startB < endA - EPSILON;
}

function lastFilenameNumber(title: string): number | null {
  const matches = title.match(/\d+/g);
  if (!matches || matches.length === 0) return null;
  const value = Number(matches[matches.length - 1]);
  return Number.isFinite(value) ? value : null;
}

function hasIncrementingFilenames(clips: LayoutGuessClip[]): boolean {
  if (clips.length < 2) return false;
  const numbered = clips.map((clip) => ({ id: clip.id, value: lastFilenameNumber(clip.title) }));
  if (numbered.some((entry) => entry.value === null)) return false;
  const values = numbered.map((entry) => entry.value as number);
  const unique = new Set(values);
  if (unique.size !== values.length) return false;
  const sorted = [...values].sort((a, b) => a - b);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]! <= sorted[index - 1]!) return false;
  }
  return true;
}

function metadataCameraRole(clip: LayoutGuessClip, metadataKey: string): string | null {
  const exact = clip.metadata[metadataKey]?.trim();
  if (exact) return exact.toUpperCase();
  const wanted = metadataKey.toLowerCase();
  for (const [key, value] of Object.entries(clip.metadata)) {
    if (key.toLowerCase() === wanted && value.trim()) return value.trim().toUpperCase();
  }
  return null;
}

export function sortClipsChronologically<T extends LayoutGuessClip>(
  clips: T[],
  rate: FrameRate = DEFAULT_RATE
): T[] {
  return [...clips].sort((left, right) => {
    const leftTc = timecodeSeconds(left, rate);
    const rightTc = timecodeSeconds(right, rate);
    if (leftTc !== null && rightTc !== null && leftTc !== rightTc) return leftTc - rightTc;

    const leftRecorded = recordedAtMs(left);
    const rightRecorded = recordedAtMs(right);
    if (leftRecorded !== null && rightRecorded !== null && leftRecorded !== rightRecorded) {
      return leftRecorded - rightRecorded;
    }

    const byName = naturalCompare(left.title, right.title);
    if (byName !== 0) return byName;

    if (left.position !== right.position) return left.position - right.position;

    const leftCreated = parseRecordedAtMs(left.createdAt);
    const rightCreated = parseRecordedAtMs(right.createdAt);
    if (leftCreated !== null && rightCreated !== null && leftCreated !== rightCreated) {
      return leftCreated - rightCreated;
    }

    return left.id.localeCompare(right.id);
  });
}

export function applySequentialOffsets(clips: CameraClip[]): CameraClip[] {
  let offset = 0;
  return clips.map((clip) => {
    const next = { ...clip, offsetSeconds: offset };
    offset += Math.max(0, clip.durationSeconds);
    return next;
  });
}

export function guessRoughCutLayout(
  clips: LayoutGuessClip[],
  options?: { cameraRoleMetadataKey?: string; rate?: FrameRate }
): LayoutGuess {
  const metadataKey = options?.cameraRoleMetadataKey ?? 'camera';
  const rate = options?.rate ?? DEFAULT_RATE;
  const ordered = sortClipsChronologically(clips, rate);
  const orderedIds = ordered.map((clip) => clip.id);

  if (clips.length === 0) {
    return { layout: 'MULTICAM', reason: 'default-multicam', orderedIds };
  }
  if (clips.length === 1) {
    return { layout: 'LINEAR', reason: 'single-clip', orderedIds };
  }

  const withTimecode = ordered.filter((clip) => timecodeSeconds(clip, rate) !== null);
  if (withTimecode.length === ordered.length) {
    let overlapping = false;
    for (let i = 0; i < withTimecode.length; i += 1) {
      for (let j = i + 1; j < withTimecode.length; j += 1) {
        const startA = timecodeSeconds(withTimecode[i]!, rate)!;
        const startB = timecodeSeconds(withTimecode[j]!, rate)!;
        if (
          rangesOverlap(
            startA,
            withTimecode[i]!.durationSeconds,
            startB,
            withTimecode[j]!.durationSeconds
          )
        ) {
          overlapping = true;
        }
      }
    }
    if (overlapping) {
      return { layout: 'MULTICAM', reason: 'overlapping-timecode', orderedIds };
    }
  }

  const withRecorded = ordered.filter((clip) => recordedAtMs(clip) !== null);
  if (withRecorded.length === ordered.length) {
    let overlapping = false;
    for (let i = 0; i < withRecorded.length; i += 1) {
      for (let j = i + 1; j < withRecorded.length; j += 1) {
        const startA = recordedAtMs(withRecorded[i]!)! / 1000;
        const startB = recordedAtMs(withRecorded[j]!)! / 1000;
        if (
          rangesOverlap(
            startA,
            withRecorded[i]!.durationSeconds,
            startB,
            withRecorded[j]!.durationSeconds
          )
        ) {
          overlapping = true;
        }
      }
    }
    if (overlapping) {
      return { layout: 'MULTICAM', reason: 'overlapping-recorded-at', orderedIds };
    }
  }

  const metadataRoles = new Set(
    ordered
      .map((clip) => metadataCameraRole(clip, metadataKey))
      .filter((role): role is string => Boolean(role))
  );
  if (metadataRoles.size >= 2) {
    return { layout: 'MULTICAM', reason: 'distinct-camera-metadata', orderedIds };
  }

  if (withTimecode.length === ordered.length) {
    return { layout: 'SEQUENTIAL', reason: 'sequential-timecode', orderedIds };
  }

  if (withRecorded.length === ordered.length) {
    return { layout: 'SEQUENTIAL', reason: 'sequential-recorded-at', orderedIds };
  }

  const inferredRoles = new Set(
    ordered.map((clip) => inferCameraRole(clip.title, clip.metadata, metadataKey))
  );
  if (hasIncrementingFilenames(ordered) && inferredRoles.size <= 1) {
    return { layout: 'SEQUENTIAL', reason: 'sequential-filenames', orderedIds };
  }

  if (inferredRoles.size >= 2) {
    return { layout: 'MULTICAM', reason: 'distinct-camera-roles', orderedIds };
  }

  return { layout: 'MULTICAM', reason: 'default-multicam', orderedIds };
}

export function cameraClipToLayoutGuess(
  clip: CameraClip,
  metadata: Record<string, string> = {}
): LayoutGuessClip {
  return {
    id: clip.videoId,
    title: clip.title,
    position: clip.position,
    durationSeconds: clip.durationSeconds,
    startTimecode: clip.startTimecode,
    recordedAt: clip.recordedAt ?? null,
    createdAt: clip.createdAt ?? null,
    metadata,
  };
}
