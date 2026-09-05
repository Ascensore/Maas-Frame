export type FrameRate = {
  num: number;
  den: number;
  dropFrame: boolean;
};

export type RemoteComment = {
  id: string;
  content: string | null;
  timestamp: number;
  timestampEnd: number | null;
  timestampFrame: number | null;
  isResolved: boolean;
  parentId: string | null;
  author: { name: string | null } | null;
  guestName: string | null;
  tag: { name: string; color: string } | null;
  updatedAt: string;
};

export type LocalMarker = {
  id: string;
  commentId: string | null;
  startSeconds: number;
  durationSeconds: number;
  name: string;
  comments: string;
  color?: string;
};

export type SyncPlan = {
  add: RemoteComment[];
  move: Array<{ comment: RemoteComment; marker: LocalMarker }>;
  remove: LocalMarker[];
};

/**
 * A write-back decision. Resolving a comment on the web because its marker left
 * the timeline is not reversible, so the unsafe cases are refused rather than
 * guessed at, and the panel tells the editor what it declined to do.
 */
export type TimelineResolveDecision =
  | { ok: true; ids: string[] }
  | {
      ok: false;
      reason: 'timeline-not-bound' | 'over-cap';
      refusedIds: string[];
      cap: number;
    };

/** Above this many resolves in one pass, ask a human instead. */
export const DEFAULT_AUTO_RESOLVE_CAP = 5;

/** Poll cadence for auto-sync. Matches the web client's comment poll. */
export const AUTO_SYNC_BASE_MS = 10000;
export const AUTO_SYNC_MAX_BACKOFF_MS = 300000;

export const SENTINEL_RE = /\[of:([a-z0-9]+)\]/i;

export function commentSentinel(commentId: string): string {
  return `[of:${commentId}]`;
}

export function parseSentinel(text: string): string | null {
  const match = SENTINEL_RE.exec(text);
  return match ? match[1] : null;
}

export function commentLabel(comment: RemoteComment): string {
  const author = comment.author?.name || comment.guestName || 'Note';
  const body = (comment.content || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return body ? `${author}: ${body}` : author;
}

export function markerCommentBody(comment: RemoteComment): string {
  const lines = [comment.content || '', commentSentinel(comment.id)];
  return lines.filter(Boolean).join('\n');
}

export function markerCommentId(marker: LocalMarker): string | null {
  return marker.commentId ?? parseSentinel(marker.comments);
}

export function collectSyncedMarkerIds(local: LocalMarker[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const marker of local) {
    const id = markerCommentId(marker);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function commentsRemovedFromTimeline(
  remote: RemoteComment[],
  local: LocalMarker[],
  previouslySyncedIds: readonly string[]
): string[] {
  const openIds = new Set(
    remote
      .filter((comment) => comment.parentId === null && !comment.isResolved)
      .map((comment) => comment.id)
  );
  const present = new Set(collectSyncedMarkerIds(local));
  const removed: string[] = [];
  for (const id of previouslySyncedIds) {
    if (openIds.has(id) && !present.has(id)) removed.push(id);
  }
  return removed;
}

/**
 * What the host and the server each believe the sequence is.
 *
 * `hostSequenceId` is what the NLE reports for the sequence in front of the
 * editor right now (Premiere sequence GUID, Resolve timeline unique id).
 * `linkedSequenceId` is what an earlier sync stored for this version.
 */
export type SequenceIdentity = {
  hostSequenceId?: string | null;
  linkedSequenceId?: string | null;
};

/**
 * Whether the sequence in front of us is the one this version is synced to.
 *
 * When both sides can name the sequence, that answer is exact and settles it.
 * Otherwise this falls back to the marker heuristic, which cannot tell an
 * original from a duplicate: duplicating a sequence copies its markers but gets
 * a fresh id, so a stale duplicate looks bound by markers alone.
 */
export function sequenceIsBound(
  local: LocalMarker[],
  previouslySyncedIds: readonly string[],
  identity: SequenceIdentity = {}
): boolean {
  const host = identity.hostSequenceId ?? null;
  const linked = identity.linkedSequenceId ?? null;
  if (host && linked) return host === linked;
  return timelineLooksBound(local, previouslySyncedIds);
}

/**
 * Whether the markers in front of us plausibly belong to the version being
 * synced: at least one marker this version placed is still on the timeline.
 *
 * "Does the timeline hold any review marker at all" is too weak — a timeline
 * carrying another version's markers passes that. A first sync (nothing synced
 * yet) has nothing to contradict, so it counts as bound.
 */
export function timelineLooksBound(
  local: LocalMarker[],
  previouslySyncedIds: readonly string[]
): boolean {
  if (previouslySyncedIds.length === 0) return true;
  const present = new Set(collectSyncedMarkerIds(local));
  return previouslySyncedIds.some((id) => present.has(id));
}

/** True when a sync would change nothing, so the host never opens a transaction. */
export function planIsEmpty(plan: SyncPlan): boolean {
  return plan.add.length === 0 && plan.move.length === 0 && plan.remove.length === 0;
}

/**
 * Decides which comments a sync may resolve on the web because their markers
 * left the timeline.
 *
 * `commentsRemovedFromTimeline` cannot tell "the editor deleted this marker"
 * apart from "these markers were never on the timeline I am looking at". When
 * the front sequence is not the bound one, every previously synced comment reads
 * as deleted and would be resolved in a single pass. Two refusals close that:
 *
 * - `timeline-not-bound`: we previously synced markers and the timeline now
 *   carries none at all. Deleting the genuinely last review marker also lands
 *   here; refusing is recoverable, resolving wrongly is not.
 * - `over-cap`: more resolves in one pass than a person plausibly performed.
 */
export function planTimelineResolves(
  remote: RemoteComment[],
  local: LocalMarker[],
  previouslySyncedIds: readonly string[],
  options: { cap?: number; identity?: SequenceIdentity } = {}
): TimelineResolveDecision {
  const cap = options.cap ?? DEFAULT_AUTO_RESOLVE_CAP;
  const ids = commentsRemovedFromTimeline(remote, local, previouslySyncedIds);
  // ids is a subset of previouslySyncedIds, so reaching here means both are
  // non-empty and the binding check below is the only thing left to decide.
  if (ids.length === 0) return { ok: true, ids: [] };
  if (!sequenceIsBound(local, previouslySyncedIds, options.identity)) {
    return { ok: false, reason: 'timeline-not-bound', refusedIds: ids, cap };
  }
  if (ids.length > cap) return { ok: false, reason: 'over-cap', refusedIds: ids, cap };
  return { ok: true, ids };
}

/**
 * The ids a caller may actually resolve. Read a decision through this rather
 * than reaching for a field: a refusal's ids are the set that was refused, and
 * iterating them is the exact bug this whole guard exists to prevent.
 */
export function resolvableIds(decision: TimelineResolveDecision): string[] {
  return decision.ok ? decision.ids : [];
}

/** Explains a refusal in the panel status line. */
export function describeResolveRefusal(decision: TimelineResolveDecision): string | null {
  if (decision.ok) return null;
  const count = decision.refusedIds.length;
  if (decision.reason === 'timeline-not-bound') {
    return `Did not resolve ${count} comment(s): this timeline has no review markers, so the open sequence may not be the one being synced. Resolve them in the web app if that was intended.`;
  }
  return `Did not resolve ${count} comment(s): more than the ${decision.cap} allowed in one sync. Resolve them in the web app if that was intended.`;
}

export type SseEvent = { event: string; data: string };

/**
 * Pulls whole SSE frames out of a growing buffer, returning the trailing
 * partial frame for the next read.
 *
 * A panel reads the live stream with `fetch` rather than `EventSource` because
 * the endpoint authenticates a Bearer header, and EventSource cannot send one —
 * the alternative is a token in the query string, which ends up in server and
 * proxy logs.
 */
export function parseSseFrames(buffer: string): { events: SseEvent[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: SseEvent[] = [];
  for (const frame of parts) {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // keep-alive comment
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trim());
    }
    if (data.length > 0 || event !== 'message') events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

/** Exponential backoff for the auto-sync poll, so a down server is not hammered. */
export function nextPollDelayMs(
  consecutiveFailures: number,
  baseMs: number = AUTO_SYNC_BASE_MS,
  maxMs: number = AUTO_SYNC_MAX_BACKOFF_MS
): number {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 0) return baseMs;
  const exponent = Math.min(consecutiveFailures, 10);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

export function parseSyncedMarkerIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

export function syncedMarkerStorageKey(versionId: string): string {
  return `of-synced-markers:${versionId}`;
}

export function remainingCommentsAfterTimelineResolves(
  remote: RemoteComment[],
  toResolve: readonly string[]
): RemoteComment[] {
  const resolved = new Set(toResolve);
  return remote.map((comment) =>
    resolved.has(comment.id) ? { ...comment, isResolved: true } : comment
  );
}

export function reconcile(
  remote: RemoteComment[],
  local: LocalMarker[],
  offsetSeconds = 0
): SyncPlan {
  const tops = remote.filter((comment) => comment.parentId === null && !comment.isResolved);
  const byId = new Map(tops.map((comment) => [comment.id, comment]));
  const localByComment = new Map<string, LocalMarker>();
  const orphans: LocalMarker[] = [];

  for (const marker of local) {
    const commentId = markerCommentId(marker);
    if (!commentId) continue;
    if (!byId.has(commentId)) {
      orphans.push(marker);
      continue;
    }
    localByComment.set(commentId, marker);
  }

  const add: RemoteComment[] = [];
  const move: SyncPlan['move'] = [];

  for (const comment of tops) {
    const existing = localByComment.get(comment.id);
    if (!existing) {
      add.push(comment);
      continue;
    }
    const expected = comment.timestamp + offsetSeconds;
    const drift = Math.abs(existing.startSeconds - expected);
    if (drift > 0.02) {
      move.push({ comment, marker: existing });
    }
  }

  return { add, move, remove: orphans };
}

export function nearestResolveColor(hex: string | null | undefined): string {
  const palette: Array<{ name: string; r: number; g: number; b: number }> = [
    { name: 'Blue', r: 59, g: 130, b: 246 },
    { name: 'Red', r: 239, g: 68, b: 68 },
    { name: 'Green', r: 34, g: 197, b: 94 },
    { name: 'Yellow', r: 234, g: 179, b: 8 },
    { name: 'Cyan', r: 6, g: 182, b: 212 },
    { name: 'Pink', r: 236, g: 72, b: 153 },
    { name: 'Purple', r: 168, g: 85, b: 247 },
    { name: 'Orange', r: 249, g: 115, b: 22 },
  ];
  if (!hex || !/^#?[0-9a-f]{6}$/i.test(hex)) return 'Blue';
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  let best = palette[0];
  let bestDist = Infinity;
  for (const color of palette) {
    const dist = (color.r - r) ** 2 + (color.g - g) ** 2 + (color.b - b) ** 2;
    if (dist < bestDist) {
      best = color;
      bestDist = dist;
    }
  }
  return best.name;
}

/**
 * Returns null when the start timecode cannot be parsed. A sequence starting at
 * 01:00:00:00 whose timecode failed to parse used to yield 0, which silently put
 * every marker an hour away from its comment. Callers must decide what to do
 * with null; auto-sync refuses to write.
 */
export function sequenceOffsetSeconds(startTimecode: string, fps: number): number | null {
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)[:;](\d{1,3})$/.exec(String(startTimecode ?? '').trim());
  if (!match) return null;
  const rate = Math.max(1, fps);
  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / rate
  );
}

const KNOWN_RATES: ReadonlyArray<readonly [number, number, number]> = [
  [24000 / 1001, 24000, 1001],
  [24, 24, 1],
  [25, 25, 1],
  [30000 / 1001, 30000, 1001],
  [30, 30, 1],
  [50, 50, 1],
  [60000 / 1001, 60000, 1001],
  [60, 60, 1],
];

export function fpsToRational(fps: number): { num: number; den: number } {
  if (!Number.isFinite(fps) || fps <= 0) return { num: 24, den: 1 };
  for (const [value, num, den] of KNOWN_RATES) {
    if (Math.abs(fps - value) < 0.02) return { num, den };
  }
  const rounded = Math.round(fps);
  if (Math.abs(fps - rounded) < 0.02) return { num: rounded, den: 1 };
  return { num: Math.round(fps * 1000), den: 1000 };
}

export function secondsToSmpte(seconds: number, fps: number, dropFrame = false): string {
  const rate = Math.max(1, Math.round(fps));
  const totalFrames = Math.max(0, Math.round(seconds * (Number.isFinite(fps) && fps > 0 ? fps : rate)));
  const hours = Math.floor(totalFrames / (rate * 3600));
  const minutes = Math.floor((totalFrames % (rate * 3600)) / (rate * 60));
  const secs = Math.floor((totalFrames % (rate * 60)) / rate);
  const frames = totalFrames % rate;
  const sep = dropFrame ? ';' : ':';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${sep}${pad(frames)}`;
}

export function resolveCustomData(commentId: string, versionId: string): string {
  return JSON.stringify({ ofId: commentId, versionId });
}

export class OpenFrameClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message = body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
      throw new Error(message);
    }
    const json = (await response.json()) as { data: T };
    return json.data;
  }

  listProjects() {
    return this.request<{ projects: Array<{ id: string; name: string }> }>('/api/v1/projects');
  }

  listVideos(projectId: string) {
    return this.request<{
      videos: Array<{
        id: string;
        title: string;
        versions: Array<{
          id: string;
          versionNumber: number;
          isActive: boolean;
          frameRateNum: number | null;
          frameRateDen: number | null;
          dropFrame: boolean;
          startTimecode: string | null;
        }>;
      }>;
    }>(`/api/v1/projects/${projectId}/videos`);
  }

  getVersion(versionId: string) {
    return this.request<{
      version: {
        id: string;
        frameRateNum: number | null;
        frameRateDen: number | null;
        dropFrame: boolean;
        startTimecode: string | null;
        duration: number | null;
        video: { title: string };
      };
    }>(`/api/v1/versions/${versionId}`);
  }

  listComments(versionId: string, updatedSince?: string) {
    const query = updatedSince ? `?updatedSince=${encodeURIComponent(updatedSince)}` : '';
    return this.request<{ comments: RemoteComment[] }>(
      `/api/v1/versions/${versionId}/comments${query}`
    );
  }

  resolveComment(commentId: string, isResolved: boolean) {
    return this.request(`/api/v1/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ isResolved }),
    });
  }

  getSequenceLink(versionId: string, nle: string) {
    return this.request<{
      sequenceLink: {
        nle: string;
        sequenceName: string;
        startTimecode: string;
        frameRateNum: number;
        frameRateDen: number;
        dropFrame: boolean;
        offsetSeconds: number | null;
      } | null;
    }>(`/api/v1/versions/${versionId}/sequence-link?nle=${encodeURIComponent(nle)}`);
  }

  putSequenceLink(
    versionId: string,
    body: {
      nle: string;
      sequenceName: string;
      startTimecode: string;
      frameRateNum: number;
      frameRateDen: number;
      dropFrame: boolean;
    }
  ) {
    return this.request(`/api/v1/versions/${versionId}/sequence-link`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }
}
