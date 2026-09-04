import type {
  AttributedTurn,
  CameraClip,
  EditDecision,
  EditReason,
  RoughCutOverlapBehaviour,
} from './types';

export type DecisionProfile = {
  minShotSeconds: number;
  safetyPauseSeconds: number;
  maxShotSeconds: number | null;
  overlapBehaviour: RoughCutOverlapBehaviour;
  wideVersionId: string;
};

type Segment = {
  start: number;
  end: number;
  versionId: string;
  reason: EditReason;
  /** How much the reason says: a speaker or a deliberate hold beats a pause filler when segments merge. */
  rank: number;
};

const RANK_FILLER = 0;
const RANK_SAFETY = 1;
const RANK_DELIBERATE = 2;
const RANK_SPEAKER = 3;

const EPSILON = 1e-6;

/** Placeholder the edit step fills with the camera role. */
const SPEAKER_SUMMARY = '';

function clipById(clips: CameraClip[], versionId: string): CameraClip | undefined {
  return clips.find((clip) => clip.versionId === versionId);
}

function mergeAdjacent(segments: Segment[]): Segment[] {
  if (segments.length === 0) return [];
  const merged: Segment[] = [{ ...segments[0]! }];
  for (let index = 1; index < segments.length; index += 1) {
    const next = segments[index]!;
    const last = merged[merged.length - 1]!;
    if (last.versionId === next.versionId && Math.abs(last.end - next.start) < EPSILON) {
      last.end = next.end;
      if (next.rank > last.rank) {
        last.reason = next.reason;
        last.rank = next.rank;
      }
    } else {
      merged.push({ ...next });
    }
  }
  return merged;
}

function enforceMinShot(segments: Segment[], minShot: number): Segment[] {
  if (segments.length <= 1 || minShot <= 0) return mergeAdjacent(segments);
  const out = segments.map((segment) => ({ ...segment }));
  let index = 0;
  while (index < out.length) {
    const current = out[index]!;
    const duration = current.end - current.start;
    if (duration + EPSILON >= minShot) {
      index += 1;
      continue;
    }
    if (index > 0) {
      out[index - 1]!.end = current.end;
      out.splice(index, 1);
      index -= 1;
      continue;
    }
    const next = out[index + 1];
    if (!next) break;
    next.start = current.start;
    out.splice(index, 1);
  }
  return mergeAdjacent(out);
}

function enforceMaxShot(
  segments: Segment[],
  maxShot: number | null,
  wideVersionId: string,
  minShot: number
): Segment[] {
  if (maxShot === null || maxShot <= 0) return segments;
  const out: Segment[] = [];
  for (const segment of segments) {
    let start = segment.start;
    while (segment.end - start > maxShot + EPSILON) {
      const cut = start + maxShot;
      out.push({ ...segment, start, end: cut });
      start = cut;
      if (segment.versionId !== wideVersionId && minShot > 0 && start + minShot < segment.end) {
        out.push({
          start,
          end: start + minShot,
          versionId: wideVersionId,
          reason: { code: 'MAX_SHOT', summary: 'Cutaway after the maximum shot length' },
          rank: RANK_DELIBERATE,
        });
        start += minShot;
      }
    }
    if (segment.end > start + EPSILON) {
      out.push({ ...segment, start, end: segment.end });
    }
  }
  return mergeAdjacent(out);
}

type Choice = { versionId: string; reason: EditReason; rank: number };

function holdWide(summary: string, wideVersionId: string, rank: number): Choice {
  return { versionId: wideVersionId, reason: { code: 'HOLD_WIDE', summary }, rank };
}

function holdPrevious(summary: string, previous: Choice | null, wideVersionId: string): Choice {
  if (!previous) return holdWide('Program start; wide', wideVersionId, RANK_SAFETY);
  return {
    versionId: previous.versionId,
    reason: { code: 'HOLD', summary },
    rank: RANK_FILLER,
  };
}

function chooseCamera(
  active: AttributedTurn[],
  previous: Choice | null,
  wideVersionId: string,
  overlap: RoughCutOverlapBehaviour,
  gapDuration: number,
  safetyPauseSeconds: number
): Choice {
  if (active.length === 0) {
    if (gapDuration + EPSILON >= safetyPauseSeconds) {
      return holdWide(
        `No one is speaking for ${gapDuration.toFixed(1)}s; safety shot`,
        wideVersionId,
        RANK_SAFETY
      );
    }
    return holdPrevious('Short pause; holding the last camera', previous, wideVersionId);
  }
  if (active.length === 1) {
    const turn = active[0]!;
    if (turn.hold === 'chaos') {
      return holdWide('Several people at once; holding wide', turn.versionId, RANK_DELIBERATE);
    }
    if (turn.hold === 'primary') {
      return holdWide('The brief holds the primary camera', turn.versionId, RANK_DELIBERATE);
    }
    return {
      versionId: turn.versionId,
      reason: { code: 'SPEAKER_SWITCH', summary: SPEAKER_SUMMARY },
      rank: RANK_SPEAKER,
    };
  }
  if (overlap === 'WIDE') {
    return holdWide('Overlapping speech; wide', wideVersionId, RANK_DELIBERATE);
  }
  if (overlap === 'HOLD') {
    return holdPrevious('Overlapping speech; holding the last camera', previous, wideVersionId);
  }
  const first = [...active].sort((a, b) => a.versionId.localeCompare(b.versionId))[0]!;
  return {
    versionId: first.versionId,
    reason: { code: 'SPEAKER_SWITCH', summary: SPEAKER_SUMMARY },
    rank: RANK_SPEAKER,
  };
}

function timelineDurationOf(clips: CameraClip[]): number {
  let max = 0;
  for (const clip of clips) {
    const end = clip.offsetSeconds + clip.durationSeconds;
    if (end > max) max = end;
  }
  return max;
}

function buildSegments(
  clips: CameraClip[],
  turns: AttributedTurn[],
  profile: DecisionProfile
): Segment[] {
  const duration = timelineDurationOf(clips);
  if (duration <= 0) return [];

  const events: Array<{ time: number; turn: AttributedTurn; delta: 1 | -1 }> = [];
  for (const turn of turns) {
    const start = Math.max(0, Math.min(duration, turn.start));
    const end = Math.max(0, Math.min(duration, turn.end));
    if (end - start < EPSILON) continue;
    if (!clipById(clips, turn.versionId)) continue;
    events.push({ time: start, turn, delta: 1 });
    events.push({ time: end, turn, delta: -1 });
  }
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);

  const times = [0, ...events.map((event) => event.time), duration];
  const uniqueTimes: number[] = [];
  for (const time of times) {
    const last = uniqueTimes[uniqueTimes.length - 1];
    if (last === undefined || Math.abs(last - time) > EPSILON) uniqueTimes.push(time);
  }

  const active = new Map<AttributedTurn, number>();
  let eventIndex = 0;
  let previous: Choice | null = null;
  const segments: Segment[] = [];

  for (let index = 0; index < uniqueTimes.length - 1; index += 1) {
    const start = uniqueTimes[index]!;
    const end = uniqueTimes[index + 1]!;
    while (eventIndex < events.length && events[eventIndex]!.time <= start + EPSILON) {
      const event = events[eventIndex]!;
      active.set(event.turn, (active.get(event.turn) ?? 0) + event.delta);
      eventIndex += 1;
    }
    const activeTurns = [...active.entries()]
      .filter(([, count]) => count > 0)
      .map(([turn]) => turn)
      .sort((a, b) => a.versionId.localeCompare(b.versionId));
    const choice = chooseCamera(
      activeTurns,
      previous,
      profile.wideVersionId,
      profile.overlapBehaviour,
      end - start,
      profile.safetyPauseSeconds
    );
    segments.push({
      start,
      end,
      versionId: choice.versionId,
      reason: choice.reason,
      rank: choice.rank,
    });
    previous = choice;
  }

  return mergeAdjacent(segments.filter((segment) => segment.end - segment.start > EPSILON));
}

function toEditDecisions(segments: Segment[], clips: CameraClip[]): EditDecision[] {
  const roleByVersion = new Map(clips.map((clip) => [clip.versionId, clip.role]));
  const edits: EditDecision[] = [];
  for (const segment of segments) {
    const clip = clipById(clips, segment.versionId);
    if (!clip) continue;
    const inSeconds = segment.start - clip.offsetSeconds;
    const outSeconds = segment.end - clip.offsetSeconds;
    const clampedIn = Math.max(0, inSeconds);
    const clampedOut = Math.min(clip.durationSeconds, outSeconds);
    if (clampedOut - clampedIn < EPSILON) continue;
    const timelineStart = clampedIn + clip.offsetSeconds;
    const timelineEnd = clampedOut + clip.offsetSeconds;
    const role = roleByVersion.get(clip.versionId) ?? clip.role;
    const reason: EditReason =
      segment.reason.code === 'SPEAKER_SWITCH'
        ? { code: 'SPEAKER_SWITCH', summary: `Speaker on ${role}` }
        : segment.reason;
    edits.push({
      timelineStartSeconds: timelineStart,
      timelineEndSeconds: timelineEnd,
      inSeconds: clampedIn,
      outSeconds: clampedOut,
      sourceVersionId: clip.versionId,
      cameraRole: role,
      targetTrack: 1,
      reason,
    });
  }
  return edits;
}

export function computeRoughCutDecisions(
  clips: CameraClip[],
  turns: AttributedTurn[],
  profile: DecisionProfile
): EditDecision[] {
  if (clips.length === 0) return [];
  const wide = clipById(clips, profile.wideVersionId) ?? clips[0]!;
  const resolved: DecisionProfile = { ...profile, wideVersionId: wide.versionId };
  const raw = buildSegments(clips, turns, resolved);
  const minApplied = enforceMinShot(raw, resolved.minShotSeconds);
  const maxApplied = enforceMaxShot(
    minApplied,
    resolved.maxShotSeconds,
    resolved.wideVersionId,
    resolved.minShotSeconds
  );
  return toEditDecisions(maxApplied, clips);
}

export const KEPT_SPEECH: EditReason = { code: 'KEPT', summary: 'Speech' };

/**
 * Single-track / sequential edit: keep speech, drop silence and takes shorter
 * than minShotSeconds, and concatenate what remains onto a tight program.
 * `turns` are source-local (file time), not timeline time.
 */
export function computeLinearDecisions(
  clips: CameraClip[],
  turns: AttributedTurn[],
  options: { minShotSeconds: number }
): EditDecision[] {
  if (clips.length === 0) return [];

  const islands: Array<{ versionId: string; inSeconds: number; outSeconds: number; role: string }> =
    [];

  for (const clip of clips) {
    const raw = turns
      .filter((turn) => turn.versionId === clip.versionId)
      .map((turn) => ({
        start: Math.max(0, Math.min(clip.durationSeconds, turn.start)),
        end: Math.max(0, Math.min(clip.durationSeconds, turn.end)),
      }))
      .filter((turn) => turn.end - turn.start > EPSILON)
      .sort((a, b) => a.start - b.start);

    const merged: Array<{ start: number; end: number }> = [];
    for (const turn of raw) {
      const last = merged[merged.length - 1];
      if (last && turn.start <= last.end + EPSILON) {
        last.end = Math.max(last.end, turn.end);
      } else {
        merged.push({ start: turn.start, end: turn.end });
      }
    }

    for (const island of merged) {
      if (island.end - island.start + EPSILON < options.minShotSeconds) continue;
      islands.push({
        versionId: clip.versionId,
        inSeconds: island.start,
        outSeconds: island.end,
        role: clip.role,
      });
    }
  }

  const kept =
    islands.length > 0
      ? islands
      : clips
          .filter((clip) => clip.durationSeconds > EPSILON)
          .map((clip) => ({
            versionId: clip.versionId,
            inSeconds: 0,
            outSeconds: clip.durationSeconds,
            role: clip.role,
          }));

  let cursor = 0;
  const edits: EditDecision[] = [];
  for (const island of kept) {
    const duration = island.outSeconds - island.inSeconds;
    if (duration <= EPSILON) continue;
    edits.push({
      timelineStartSeconds: cursor,
      timelineEndSeconds: cursor + duration,
      inSeconds: island.inSeconds,
      outSeconds: island.outSeconds,
      sourceVersionId: island.versionId,
      cameraRole: island.role,
      targetTrack: 1,
      reason: KEPT_SPEECH,
    });
    cursor += duration;
  }
  return edits;
}
