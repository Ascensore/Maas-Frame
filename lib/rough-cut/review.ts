import { MediaJobKind, MediaJobStatus, type Prisma, type RoughCut } from '@prisma/client';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import { db } from '@/lib/db';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';
import {
  applyOverridesWithReport,
  overridesEqual,
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
};

export type RoughCutRenderState = {
  status: 'idle' | 'queued' | 'running' | 'failed';
  error: string | null;
  updatedAt: string | null;
};

export type RoughCutReview = {
  decisions: RoughCutDecisionList;
  effective: RoughCutDecisionList;
  /** What the saved overrides actually did to the program. */
  applied: {
    restoredKeys: string[];
    staleCutKeys: string[];
    skippedIslands: string[];
    extraCutsApplied: number;
  };
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

export async function findActiveMaterializeJob(roughCutId: string) {
  return db.mediaJob.findFirst({
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
    };
  });
}

/** Everything the review pane needs about a READY run, or null when it has no decisions yet. */
export async function loadRoughCutReview(row: RoughCut): Promise<RoughCutReview | null> {
  const decisions = parseRoughCutDecisionList(row.decisions);
  if (!decisions) return null;
  const overrides = parseRoughCutOverrides(row.overrides);
  const renderedOverrides = parseRoughCutOverrides(row.renderedOverrides);
  const applied = applyOverridesWithReport(decisions, overrides);
  const [sources, render] = await Promise.all([loadSources(decisions), renderState(row.id)]);
  return {
    decisions,
    effective: applied.decisions,
    applied: {
      restoredKeys: applied.restoredKeys,
      staleCutKeys: applied.staleCutKeys,
      skippedIslands: applied.skippedIslands,
      extraCutsApplied: applied.extraCutsApplied,
    },
    overrides,
    renderedOverrides,
    renderedDecisions: parseRoughCutDecisionList(row.renderedDecisions),
    needsRender: !overridesEqual(overrides, renderedOverrides),
    script: row.script ?? null,
    sources,
    render,
  };
}
