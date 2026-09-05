import { MediaJobKind, MediaJobStatus, type Prisma, type RoughCut } from '@prisma/client';
import type { NextResponse } from 'next/server';
import { apiErrors } from '@/lib/api-response';
import { checkProjectAccess } from '@/lib/auth';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import { db } from '@/lib/db';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';
import {
  applyOverridesWithReport,
  needsRender,
  parseRoughCutOverrides,
  type RoughCutOverrides,
} from '@/lib/rough-cut/overrides';
import type { RoughCutDecisionList } from '@/lib/rough-cut/types';
import { resolveR2PlaybackUrl } from '@/lib/video-upload-validation';

/**
 * Everything the review pane needs about one run, assembled server-side: the
 * islands assembly cut with their reasons, the reviewer's saved decisions, the
 * program those decisions produce, the clips to scrub, and whether a render is
 * already on its way.
 */

export type RoughCutReviewSource = {
  versionId: string;
  videoId: string;
  title: string;
  role: string;
  offsetSeconds: number;
  durationSeconds: number;
  playbackUrl: string | null;
  playbackKind: 'file' | 'hls' | null;
  /** The version this clip was cut from is gone, so there is nothing to scrub. */
  missing: boolean;
};

export type RoughCutRenderState = {
  status: 'idle' | 'queued' | 'running' | 'failed';
  error: string | null;
  updatedAt: string | null;
};

/** What the saved overrides actually did to the program. Editors only. */
export type AppliedOverridesReport = {
  restoredKeys: string[];
  staleCutKeys: string[];
  skippedIslands: string[];
  extraCutsApplied: number;
};

export type RoughCutReview = {
  decisions: RoughCutDecisionList;
  effective: RoughCutDecisionList;
  applied: AppliedOverridesReport | null;
  overrides: RoughCutOverrides | null;
  renderedOverrides: RoughCutOverrides | null;
  renderedDecisions: RoughCutDecisionList | null;
  needsRender: boolean;
  script: string | null;
  sources: RoughCutReviewSource[];
  render: RoughCutRenderState;
};

const ACTIVE_JOB: MediaJobStatus[] = [
  MediaJobStatus.PENDING,
  MediaJobStatus.QUEUED,
  MediaJobStatus.RUNNING,
];

/**
 * The materialize jobs of one run. The rough cut id lives in the job payload
 * rather than in a column, so the filter is a JSON path: `versionId` only says
 * which clip the worker leases, and several runs share a clip.
 */
export function materializeJobWhere(roughCutId: string): Prisma.MediaJobWhereInput {
  return {
    kind: MediaJobKind.MATERIALIZE_ROUGH_CUT,
    payload: { path: ['roughCutId'], equals: roughCutId },
  };
}

/**
 * Takes the client so the render route can ask inside the transaction that
 * holds its advisory lock; outside one, two callers a millisecond apart both
 * see no active job.
 */
export async function findActiveMaterializeJob(
  roughCutId: string,
  client: Pick<typeof db, 'mediaJob'> = db
) {
  return client.mediaJob.findFirst({
    where: { ...materializeJobWhere(roughCutId), status: { in: ACTIVE_JOB } },
    select: { id: true, status: true },
  });
}

/**
 * The latest render attempt, as the pane reports it. A succeeded job is `idle`:
 * the render it describes is the one already on the output video, so there is
 * nothing in flight to wait for.
 */
async function renderState(roughCutId: string): Promise<RoughCutRenderState> {
  const job = await db.mediaJob.findFirst({
    where: materializeJobWhere(roughCutId),
    orderBy: { createdAt: 'desc' },
    select: { status: true, error: true, updatedAt: true },
  });
  if (!job) return { status: 'idle', error: null, updatedAt: null };
  const status =
    job.status === MediaJobStatus.RUNNING
      ? 'running'
      : job.status === MediaJobStatus.FAILED
        ? 'failed'
        : job.status === MediaJobStatus.SUCCEEDED
          ? 'idle'
          : 'queued';
  return { status, error: job.error, updatedAt: job.updatedAt.toISOString() };
}

/**
 * The clips behind the program, with a URL the browser can scrub. The decision
 * list carries the paths the NLE export uses, which point at files that only
 * exist next to a project file, so playback is resolved from the version rows.
 */
async function loadSources(decisions: RoughCutDecisionList): Promise<RoughCutReviewSource[]> {
  const versionIds = decisions.clips.map((clip) => clip.versionId);
  const versions = await db.videoVersion.findMany({
    where: { id: { in: versionIds } },
    select: {
      id: true,
      videoId: true,
      providerId: true,
      originalUrl: true,
      proxyUrl: true,
      proxyStatus: true,
      duration: true,
      video: { select: { id: true, title: true } },
    },
  });
  const byId = new Map(versions.map((version) => [version.id, version]));
  const bunnyHost = resolvePublicBunnyCdnHostname();
  return decisions.clips.map((clip) => {
    const version = byId.get(clip.versionId);
    let playbackUrl: string | null = null;
    let playbackKind: RoughCutReviewSource['playbackKind'] = null;
    if (version?.providerId === 'r2') {
      playbackUrl = resolveR2PlaybackUrl(version);
      playbackKind = 'file';
    } else if (version?.providerId === 'bunny' && bunnyHost) {
      playbackUrl = `https://${bunnyHost}/${version.videoId}/playlist.m3u8`;
      playbackKind = 'hls';
    }
    return {
      versionId: clip.versionId,
      videoId: clip.videoId,
      title: version?.video.title ?? clip.role,
      role: clip.role,
      offsetSeconds: clip.offsetSeconds,
      // A clip whose duration never got probed is stored as 0; the version row
      // is the better answer then, and 0 is the honest one when neither knows.
      durationSeconds: clip.durationSeconds || version?.duration || 0,
      playbackUrl,
      playbackKind,
      // A deleted source is a decision list the run can no longer be re-rendered
      // from. The pane says so rather than showing a player that cannot load.
      missing: !version,
    };
  });
}

/**
 * Everything the review pane needs about a READY run, or null when it has no
 * decisions yet.
 *
 * `canEdit` is what the caller may see, not only what they may do: the script,
 * the reviewer's own decisions and the report of what those decisions did are
 * an editor's working notes, so a commenter gets the program, the clips and the
 * render state without them.
 */
export async function loadRoughCutReview(
  row: RoughCut,
  options: { canEdit: boolean }
): Promise<RoughCutReview | null> {
  const decisions = parseRoughCutDecisionList(row.decisions);
  if (!decisions) return null;
  const overrides = parseRoughCutOverrides(row.overrides);
  const renderedOverrides = parseRoughCutOverrides(row.renderedOverrides);
  const applied = applyOverridesWithReport(decisions, overrides);
  const [sources, render] = await Promise.all([loadSources(decisions), renderState(row.id)]);
  return {
    decisions,
    effective: applied.decisions,
    applied: options.canEdit
      ? {
          restoredKeys: applied.restoredKeys,
          staleCutKeys: applied.staleCutKeys,
          skippedIslands: applied.skippedIslands,
          extraCutsApplied: applied.extraCutsApplied,
        }
      : null,
    overrides: options.canEdit ? overrides : null,
    renderedOverrides: options.canEdit ? renderedOverrides : null,
    renderedDecisions: parseRoughCutDecisionList(row.renderedDecisions),
    needsRender: needsRender(decisions, overrides, renderedOverrides),
    script: options.canEdit ? (row.script ?? null) : null,
    sources,
    render,
  };
}

type RoughCutForEditor = RoughCut & {
  project: { id: string; ownerId: string; workspaceId: string; visibility: string };
};

type ProjectAccess = Awaited<ReturnType<typeof checkProjectAccess>>;

export type EditorLoad =
  | { row: RoughCutForEditor; access: ProjectAccess; decisions: RoughCutDecisionList }
  | { error: NextResponse };

/**
 * The run behind a review mutation, refused the same way for both of them:
 * missing, not yours to edit, not finished, or finished with nothing to act on.
 * `action` only names the verb in those refusals.
 */
export async function loadRoughCutForEditor(
  roughCutId: string,
  userId: string,
  action: 'review' | 'render'
): Promise<EditorLoad> {
  const row = await db.roughCut.findUnique({
    where: { id: roughCutId },
    include: {
      project: {
        select: { id: true, ownerId: true, workspaceId: true, visibility: true },
      },
    },
  });
  if (!row) return { error: apiErrors.notFound('Rough cut') };

  const access = await checkProjectAccess(row.project, userId);
  if (!access.canEdit) return { error: apiErrors.forbidden('Access denied') };

  if (row.status !== 'READY') {
    return { error: apiErrors.badRequest(`Rough cut is not ready to ${action}`) };
  }

  const decisions = parseRoughCutDecisionList(row.decisions);
  if (!decisions) {
    return { error: apiErrors.badRequest(`Rough cut has no decisions to ${action}`) };
  }

  return { row, access, decisions };
}
