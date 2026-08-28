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
    const commentId = marker.commentId ?? parseSentinel(marker.comments);
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

export function sequenceOffsetSeconds(startTimecode: string, fps: number): number {
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)[:;](\d{1,3})$/.exec(startTimecode.trim());
  if (!match) return 0;
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
