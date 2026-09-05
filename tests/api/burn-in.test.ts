// Starting a burn-in and following it: POST /api/videos/[videoId]/burn-in queues the
// BURN_SUBTITLES media job, GET reports the latest one for a version.
//
// The route hands the worker a payload it will act on without asking anything else, so
// what is asserted here is the row, not the 202. Three things in particular:
//
//  - The source is resolved by the route, never left to the worker. A payload naming the
//    wrong transcript burns another language's words into the picture, and the render is
//    expensive enough that nobody notices until it comes back.
//  - The gate is the editor one, the same `canManageAssets` the subtitle upload uses.
//    Every other write under /api/videos/[videoId] is open to anyone who may comment, so a
//    burn-in that reached for `canUploadAssets` would look right next to its neighbours
//    and would let a share-link viewer re-encode a delivered cut.
//  - One burn at a time per version. A second click while the first is running would race
//    it for the output video's next version number.

import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { GET as getBurnIn, POST as postBurnIn } from '@/app/api/videos/[videoId]/burn-in/route';
import { parseBurnInPayload } from '@/lib/rough-cut/burn-in-job';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createReadyTranscript,
  createUser,
  createVersion,
  createVideo,
  nextSeq,
  seedProject,
  seedVersion,
} from '../factories';

/**
 * Every default in burnInStyleSchema, written out by hand. Reading them off the schema
 * would mean a changed default silently rewrites its own expectation.
 */
const STYLE_DEFAULTS = {
  font: 'dejavu-sans',
  fontSize: 48,
  textColor: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 2,
  backgroundOpacity: 0,
  position: 'bottom',
  marginVertical: 60,
  bold: true,
  uppercase: false,
  maxWordsPerCue: 6,
  maxCueSeconds: 4,
  playbackRate: 1,
} as const;

const SEGMENTS = [
  {
    startSec: 0,
    endSec: 2,
    text: 'ciao a tutti',
    words: [
      { start: 0, end: 0.6, text: 'ciao' },
      { start: 0.6, end: 1.1, text: 'a' },
      { start: 1.1, end: 2, text: 'tutti' },
    ],
  },
];

function burnInUrl(videoId: string): string {
  return `/api/videos/${videoId}/burn-in`;
}

function startRequest(videoId: string, body: Record<string, unknown>) {
  return apiRequest(burnInUrl(videoId), { method: 'POST', body });
}

function jobRequest(videoId: string, versionId?: string) {
  return apiRequest(burnInUrl(videoId), {
    searchParams: versionId === undefined ? {} : { versionId },
  });
}

/** A uuid-shaped, collision-free proxy path, the way the upload route writes them. */
function trackUrl(): string {
  return `/api/upload/subtitle/${String(nextSeq()).padStart(8, '0')}-1111-4111-8111-111111111111.vtt`;
}

async function createTrack(input: { versionId: string; billedUserId: string; language?: string }) {
  return db.videoSubtitle.create({
    data: {
      versionId: input.versionId,
      language: input.language ?? 'it',
      label: (input.language ?? 'it').toUpperCase(),
      sourceUrl: trackUrl(),
      sizeBytes: BigInt(64),
      billedUserId: input.billedUserId,
    },
  });
}

/** An owner's uploaded version with one READY Italian transcript on it. */
async function seedBurnableVersion() {
  const scenario = await seedVersion({ providerId: 'r2' });
  const transcript = await createReadyTranscript({
    versionId: scenario.version.id,
    language: 'it',
    segments: SEGMENTS,
  });
  signedInAs(scenario.owner);
  return { ...scenario, transcript };
}

async function addCommentator(projectId: string) {
  const commentator = await createUser();
  await addProjectMember({ projectId, userId: commentator.id, role: 'COMMENTATOR' });
  return commentator;
}

type JobResponse = { job: { id: string; status: string } };

// ---------------------------------------------------------------------------
// POST /api/videos/[videoId]/burn-in
// ---------------------------------------------------------------------------
describe('POST /api/videos/[videoId]/burn-in', () => {
  it('queues one job for the owner with the style, the transcript and the requester', async () => {
    const scenario = await seedBurnableVersion();

    const response = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, {
        versionId: scenario.version.id,
        style: { font: 'roboto', fontSize: 56 },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(202);
    const data = await readData<JobResponse>(response);
    expect(data.job.status).toBe('PENDING');
    expect(data.job.id).toBeTruthy();

    const jobs = await db.mediaJob.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(data.job.id);
    expect(jobs[0].kind).toBe('BURN_SUBTITLES');
    expect(jobs[0].versionId).toBe(scenario.version.id);
    expect(jobs[0].payload).toEqual({
      style: { ...STYLE_DEFAULTS, font: 'roboto', fontSize: 56 },
      source: { kind: 'transcript', transcriptId: scenario.transcript.id },
      requestedById: scenario.owner.id,
    });

    // The other half of the contract: the worker parses this row with a strict schema and
    // fails the job outright on a payload it does not recognise, so a key renamed on one
    // side only would never reach ffmpeg.
    expect(parseBurnInPayload(jobs[0].payload)?.source).toEqual({
      kind: 'transcript',
      transcriptId: scenario.transcript.id,
    });
  });

  it('refuses an anonymous caller and a COMMENTATOR, queueing nothing', async () => {
    const scenario = await seedBurnableVersion();
    const body = { versionId: scenario.version.id, style: {} };
    signedOut();

    const anonymous = await callRoute(postBurnIn, startRequest(scenario.video.id, body), {
      videoId: scenario.video.id,
    });
    expect(anonymous.status).toBe(403);

    signedInAs(await addCommentator(scenario.project.id));
    const commentator = await callRoute(postBurnIn, startRequest(scenario.video.id, body), {
      videoId: scenario.video.id,
    });
    expect(commentator.status).toBe(403);

    expect(await db.mediaJob.count()).toBe(0);
  });

  it('refuses a version whose only transcript is still running and has no caption track', async () => {
    const scenario = await seedVersion({ providerId: 'r2' });
    await createReadyTranscript({
      versionId: scenario.version.id,
      language: 'it',
      status: 'PENDING',
      segments: SEGMENTS,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, { versionId: scenario.version.id, style: {} }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe(
      'This version has no transcript or caption track to burn in'
    );
    expect(await db.mediaJob.count()).toBe(0);
  });

  it('falls back to a caption track when no transcript is ready', async () => {
    const scenario = await seedVersion({ providerId: 'r2' });
    const track = await createTrack({
      versionId: scenario.version.id,
      billedUserId: scenario.owner.id,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, { versionId: scenario.version.id, style: {} }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(202);
    const job = await db.mediaJob.findFirstOrThrow();
    expect(job.payload).toEqual({
      style: STYLE_DEFAULTS,
      source: { kind: 'subtitle', subtitleId: track.id },
      requestedById: scenario.owner.id,
    });
  });

  it('refuses a style the schema will not accept, and queues nothing', async () => {
    const scenario = await seedBurnableVersion();

    const response = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, {
        versionId: scenario.version.id,
        style: { fontSize: 4 },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toMatch(/^fontSize/);
    expect(await db.mediaJob.count()).toBe(0);
  });

  it('burns a named caption track, and refuses one belonging to another version', async () => {
    const scenario = await seedBurnableVersion();
    const track = await createTrack({
      versionId: scenario.version.id,
      billedUserId: scenario.owner.id,
      language: 'tr',
    });

    const accepted = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, {
        versionId: scenario.version.id,
        style: {},
        subtitleId: track.id,
      }),
      { videoId: scenario.video.id }
    );

    expect(accepted.status).toBe(202);
    const job = await db.mediaJob.findFirstOrThrow();
    // The named track wins over the READY transcript the version also has.
    expect(job.payload).toMatchObject({ source: { kind: 'subtitle', subtitleId: track.id } });

    const otherVersion = await createVersion({
      videoParentId: scenario.video.id,
      versionNumber: 2,
      providerId: 'r2',
    });
    const otherTrack = await createTrack({
      versionId: otherVersion.id,
      billedUserId: scenario.owner.id,
      language: 'tr',
    });

    const refused = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, {
        versionId: scenario.version.id,
        style: {},
        subtitleId: otherTrack.id,
      }),
      { videoId: scenario.video.id }
    );

    expect(refused.status).toBe(404);
    expect(await db.mediaJob.count()).toBe(1);
  });

  it('refuses a second burn while the first is queued, and accepts one after it succeeds', async () => {
    const scenario = await seedBurnableVersion();
    const body = { versionId: scenario.version.id, style: {} };

    const first = await callRoute(postBurnIn, startRequest(scenario.video.id, body), {
      videoId: scenario.video.id,
    });
    expect(first.status).toBe(202);

    const second = await callRoute(postBurnIn, startRequest(scenario.video.id, body), {
      videoId: scenario.video.id,
    });
    expect(second.status).toBe(409);
    expect(await db.mediaJob.count({ where: { kind: 'BURN_SUBTITLES' } })).toBe(1);

    await db.mediaJob.updateMany({
      where: { kind: 'BURN_SUBTITLES' },
      data: { status: 'SUCCEEDED', finishedAt: new Date() },
    });

    const again = await callRoute(postBurnIn, startRequest(scenario.video.id, body), {
      videoId: scenario.video.id,
    });
    expect(again.status).toBe(202);
    expect(await db.mediaJob.count({ where: { kind: 'BURN_SUBTITLES' } })).toBe(2);
  });

  it('ignores a burn-in running on another version of the same video', async () => {
    const scenario = await seedBurnableVersion();
    const otherVersion = await createVersion({
      videoParentId: scenario.video.id,
      versionNumber: 2,
      providerId: 'r2',
    });
    await db.mediaJob.create({
      data: { versionId: otherVersion.id, kind: 'BURN_SUBTITLES', status: 'RUNNING' },
    });

    const response = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, { versionId: scenario.version.id, style: {} }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(202);
    expect(await db.mediaJob.count({ where: { versionId: scenario.version.id } })).toBe(1);
  });

  it('ignores the version\u2019s own probe job, both when refusing and when reporting', async () => {
    // Every uploaded version is given a PROBE_MEDIA job the moment it lands, and it sits
    // at PENDING until the worker picks it up. Without the kind filter on either query,
    // that row alone would refuse every first burn-in on a fresh version with a 409, and
    // the pane would poll it as if it were the render.
    const scenario = await seedBurnableVersion();
    await db.mediaJob.create({
      data: { versionId: scenario.version.id, kind: 'PROBE_MEDIA', status: 'PENDING' },
    });
    const burn = await db.mediaJob.create({
      data: { versionId: scenario.version.id, kind: 'BURN_SUBTITLES', status: 'RUNNING' },
    });
    const body = { versionId: scenario.version.id, style: {} };

    const refused = await callRoute(postBurnIn, startRequest(scenario.video.id, body), {
      videoId: scenario.video.id,
    });
    expect(refused.status).toBe(409);
    expect(await db.mediaJob.count()).toBe(2);

    // The burn is gone and only the probe is left: nothing to report, and nothing in the
    // way of the next one.
    await db.mediaJob.delete({ where: { id: burn.id } });

    const reported = await callRoute(
      getBurnIn,
      jobRequest(scenario.video.id, scenario.version.id),
      { videoId: scenario.video.id }
    );
    expect(reported.status).toBe(200);
    expect(await readData<{ job: unknown }>(reported)).toEqual({ job: null });

    const accepted = await callRoute(postBurnIn, startRequest(scenario.video.id, body), {
      videoId: scenario.video.id,
    });
    expect(accepted.status).toBe(202);
    expect(await db.mediaJob.count({ where: { kind: 'BURN_SUBTITLES' } })).toBe(1);
  });

  // PENDING is covered by 'refuses a second burn while the first is queued': the route
  // enqueues at PENDING, so the second call there runs into one. The PENDING row in the
  // test just above is a probe, and being ignored is the whole point of it. These are the
  // other two statuses a burn-in can sit at while the worker has it, and each has to hold
  // the next one off.
  it.each(['QUEUED', 'RUNNING'] as const)(
    'refuses a burn while an earlier one is %s',
    async (status) => {
      const scenario = await seedBurnableVersion();
      await db.mediaJob.create({
        data: { versionId: scenario.version.id, kind: 'BURN_SUBTITLES', status },
      });

      const response = await callRoute(
        postBurnIn,
        startRequest(scenario.video.id, { versionId: scenario.version.id, style: {} }),
        { videoId: scenario.video.id }
      );

      expect(response.status).toBe(409);
      expect(await db.mediaJob.count()).toBe(1);
    }
  );

  it('refuses an audio review, which is file-backed and can hold a transcript', async () => {
    // The one case the provider check alone does not catch: an uploaded audio review is
    // r2-backed and is transcribed like any other, so only its kind says there is no
    // picture to burn anything into.
    const project = await seedProject();
    const audio = await createVideo({ projectId: project.project.id, kind: 'AUDIO' });
    const version = await createVersion({ videoParentId: audio.id, providerId: 'r2' });
    await createReadyTranscript({ versionId: version.id, language: 'it', segments: SEGMENTS });
    signedInAs(project.owner);

    const response = await callRoute(
      postBurnIn,
      startRequest(audio.id, { versionId: version.id, style: {} }),
      { videoId: audio.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe(
      'Subtitles can only be burned into an uploaded video file'
    );
    expect(await db.mediaJob.count()).toBe(0);
  });

  it('refuses a version that is not an uploaded file', async () => {
    // seedVersion defaults to a youtube version: there is no master to re-encode.
    const scenario = await seedVersion();
    await createReadyTranscript({
      versionId: scenario.version.id,
      language: 'it',
      segments: SEGMENTS,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, { versionId: scenario.version.id, style: {} }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe(
      'Subtitles can only be burned into an uploaded video file'
    );
    expect(await db.mediaJob.count()).toBe(0);
  });

  it('refuses a version that belongs to another video', async () => {
    const scenario = await seedBurnableVersion();
    const other = await seedVersion({ providerId: 'r2', ownerUser: scenario.owner });

    const response = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, { versionId: other.version.id, style: {} }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(404);
    expect(await db.mediaJob.count()).toBe(0);
  });

  it('requires a versionId', async () => {
    const scenario = await seedBurnableVersion();

    const response = await callRoute(postBurnIn, startRequest(scenario.video.id, { style: {} }), {
      videoId: scenario.video.id,
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('versionId is required');
    expect(await db.mediaJob.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST … { language }
// ---------------------------------------------------------------------------
describe('POST /api/videos/[videoId]/burn-in, choosing the transcript', () => {
  /** Two READY transcripts with fixed, distinct creation times. */
  async function seedTwoTranscripts() {
    const scenario = await seedVersion({ providerId: 'r2' });
    const older = await createReadyTranscript({
      versionId: scenario.version.id,
      language: 'it',
      segments: SEGMENTS,
    });
    const newer = await createReadyTranscript({
      versionId: scenario.version.id,
      language: 'en',
      segments: SEGMENTS,
    });
    // Written rather than assumed: two inserts can land in the same millisecond, and
    // "oldest" would then be whichever the planner returned first.
    await db.transcript.update({
      where: { id: older.id },
      data: { createdAt: new Date('2024-01-01T00:00:00.000Z') },
    });
    await db.transcript.update({
      where: { id: newer.id },
      data: { createdAt: new Date('2024-06-01T00:00:00.000Z') },
    });
    signedInAs(scenario.owner);
    return { ...scenario, older, newer };
  }

  it('takes the language it is given, whatever case it arrives in', async () => {
    const scenario = await seedTwoTranscripts();

    const response = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, {
        versionId: scenario.version.id,
        style: {},
        language: 'EN',
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(202);
    const job = await db.mediaJob.findFirstOrThrow();
    expect(job.payload).toMatchObject({
      source: { kind: 'transcript', transcriptId: scenario.newer.id },
    });
  });

  it('takes the oldest transcript when no language is given', async () => {
    const scenario = await seedTwoTranscripts();

    const response = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, { versionId: scenario.version.id, style: {} }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(202);
    const job = await db.mediaJob.findFirstOrThrow();
    expect(job.payload).toMatchObject({
      source: { kind: 'transcript', transcriptId: scenario.older.id },
    });
  });

  it('refuses a language this version has no ready transcript in', async () => {
    const scenario = await seedTwoTranscripts();

    const response = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, {
        versionId: scenario.version.id,
        style: {},
        language: 'fr',
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe(
      'No ready transcript in that language. Pass subtitleId to burn a caption track.'
    );
    expect(await db.mediaJob.count()).toBe(0);
  });

  it('refuses a language that is not a tag', async () => {
    const scenario = await seedTwoTranscripts();

    const response = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, {
        versionId: scenario.version.id,
        style: {},
        language: '<script>',
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('language must be a BCP-47 tag such as "tr" or "en-US"');
    expect(await db.mediaJob.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/videos/[videoId]/burn-in?versionId=…
// ---------------------------------------------------------------------------
describe('GET /api/videos/[videoId]/burn-in', () => {
  it('reports no job before one is queued and the queued one after', async () => {
    const scenario = await seedBurnableVersion();

    const before = await callRoute(getBurnIn, jobRequest(scenario.video.id, scenario.version.id), {
      videoId: scenario.video.id,
    });
    expect(before.status).toBe(200);
    expect(await readData<{ job: unknown }>(before)).toEqual({ job: null });

    const started = await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, { versionId: scenario.version.id, style: {} }),
      { videoId: scenario.video.id }
    );
    const queued = await readData<JobResponse>(started);

    const after = await callRoute(getBurnIn, jobRequest(scenario.video.id, scenario.version.id), {
      videoId: scenario.video.id,
    });
    expect(after.status).toBe(200);
    const data = await readData<{
      job: {
        id: string;
        status: string;
        error: string | null;
        createdAt: string;
        finishedAt: string | null;
      };
    }>(after);
    expect(data.job.id).toBe(queued.job.id);
    expect(data.job.status).toBe('PENDING');
    expect(data.job.error).toBeNull();
    expect(data.job.finishedAt).toBeNull();
    expect(Number.isNaN(Date.parse(data.job.createdAt))).toBe(false);
  });

  it('reports the latest attempt, not the first one', async () => {
    const scenario = await seedBurnableVersion();
    await db.mediaJob.create({
      data: {
        versionId: scenario.version.id,
        kind: 'BURN_SUBTITLES',
        status: 'FAILED',
        error: 'ffmpeg burn-in failed',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        finishedAt: new Date('2024-01-01T00:01:00.000Z'),
      },
    });
    const latest = await db.mediaJob.create({
      data: {
        versionId: scenario.version.id,
        kind: 'BURN_SUBTITLES',
        status: 'RUNNING',
        createdAt: new Date('2024-06-01T00:00:00.000Z'),
      },
    });

    const response = await callRoute(
      getBurnIn,
      jobRequest(scenario.video.id, scenario.version.id),
      { videoId: scenario.video.id }
    );

    const data = await readData<{ job: { id: string; status: string; error: string | null } }>(
      response
    );
    expect(data.job.id).toBe(latest.id);
    expect(data.job.status).toBe('RUNNING');
    expect(data.job.error).toBeNull();
  });

  it('does not report a job belonging to a version of another video', async () => {
    const scenario = await seedBurnableVersion();
    const otherVideo = await createVideo({ projectId: scenario.project.id, title: 'ISO 2' });
    const otherVersion = await createVersion({
      videoParentId: otherVideo.id,
      providerId: 'r2',
    });
    await db.mediaJob.create({
      data: { versionId: otherVersion.id, kind: 'BURN_SUBTITLES', status: 'RUNNING' },
    });

    const response = await callRoute(getBurnIn, jobRequest(scenario.video.id, otherVersion.id), {
      videoId: scenario.video.id,
    });

    expect(response.status).toBe(200);
    expect(await readData<{ job: unknown }>(response)).toEqual({ job: null });
  });

  it('requires a versionId', async () => {
    const scenario = await seedBurnableVersion();

    const response = await callRoute(getBurnIn, jobRequest(scenario.video.id), {
      videoId: scenario.video.id,
    });

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('versionId is required');
  });

  it('refuses an anonymous caller on a private project', async () => {
    const scenario = await seedBurnableVersion();
    await callRoute(
      postBurnIn,
      startRequest(scenario.video.id, { versionId: scenario.version.id, style: {} }),
      { videoId: scenario.video.id }
    );
    signedOut();

    const response = await callRoute(
      getBurnIn,
      jobRequest(scenario.video.id, scenario.version.id),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });

  it('refuses a COMMENTATOR, who may not start a burn-in either', async () => {
    const scenario = await seedBurnableVersion();
    signedInAs(await addCommentator(scenario.project.id));

    const response = await callRoute(
      getBurnIn,
      jobRequest(scenario.video.id, scenario.version.id),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });
});
