import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { assembleDecisionList } from '@/lib/rough-cut/decision-list';
import { cutIslandKey } from '@/lib/rough-cut/program';
import { PUT as putOverrides } from '@/app/api/rough-cuts/[roughCutId]/overrides/route';
import { POST as postRender } from '@/app/api/rough-cuts/[roughCutId]/render/route';
import { GET as getRoughCut } from '@/app/api/rough-cuts/[roughCutId]/route';
import { GET as downloadRoughCut } from '@/app/api/rough-cuts/[roughCutId]/download/route';
import { GET as getVideoRoughCut } from '@/app/api/videos/[videoId]/rough-cut/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createRoughCut,
  createUser,
  createVersion,
  createVideo,
  seedProject,
} from '../factories';

const RATE = { num: 24, den: 1, dropFrame: false };

async function seedReviewableCut() {
  const scenario = await seedProject();
  const source = await createVideo({ projectId: scenario.project.id, title: 'Cam A' });
  const sourceVersion = await createVersion({
    videoParentId: source.id,
    providerId: 'r2',
    providerVideoId: 'videos/cam-a.mp4',
    originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    duration: 30,
  });
  const output = await createVideo({ projectId: scenario.project.id, title: 'Rough cut' });
  const outputVersion = await createVersion({
    videoParentId: output.id,
    providerId: 'r2',
    providerVideoId: 'videos/out.mp4',
    originalUrl: '/api/upload/video/cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
  });
  const islandKey = cutIslandKey(sourceVersion.id, 4, 6, RATE);
  const decisions = assembleDecisionList({
    edits: [
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 3,
        inSeconds: 1,
        outSeconds: 4,
        sourceVersionId: sourceVersion.id,
        cameraRole: 'A',
        targetTrack: 1,
      },
      {
        timelineStartSeconds: 3,
        timelineEndSeconds: 7,
        inSeconds: 6,
        outSeconds: 10,
        sourceVersionId: sourceVersion.id,
        cameraRole: 'A',
        targetTrack: 1,
      },
    ],
    clips: [
      {
        videoId: source.id,
        versionId: sourceVersion.id,
        title: 'Cam A',
        role: 'A',
        position: 0,
        offsetSeconds: 0,
        durationSeconds: 30,
        frameRateNum: 24,
        frameRateDen: 1,
        dropFrame: false,
        startTimecode: null,
        originalUrl: sourceVersion.originalUrl,
        versionNumber: 1,
        versionLabel: null,
      },
    ],
    fileNames: new Map([[sourceVersion.id, '01-Cam A-v1.mp4']]),
    mediaPathPrefix: './media/',
    rate: RATE,
    cuts: [
      {
        key: islandKey,
        sourceVersionId: sourceVersion.id,
        inSeconds: 4,
        outSeconds: 6,
        reason: { code: 'DEAD_AIR', summary: '2.0s of dead air' },
        transcriptText: null,
      },
    ],
  });
  const cut = await createRoughCut({
    projectId: scenario.project.id,
    requestedById: scenario.owner.id,
    status: 'READY',
    layout: 'LINEAR',
    decisions,
    outputVideoId: output.id,
  });
  return { ...scenario, source, sourceVersion, output, outputVersion, cut, islandKey };
}

/** A member who is signed in and belongs to the project, but may not edit it. */
async function addCommenter(projectId: string) {
  const commenter = await createUser();
  await addProjectMember({ projectId, userId: commenter.id, role: 'COMMENTATOR' });
  return commenter;
}

describe('PUT /api/rough-cuts/[roughCutId]/overrides', () => {
  it('returns 401 to an anonymous caller and stores nothing', async () => {
    const seeded = await seedReviewableCut();
    signedOut();

    const response = await callRoute(
      putOverrides,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/overrides`, {
        method: 'PUT',
        body: { version: 1, cuts: { [seeded.islandKey]: 'restore' } },
      }),
      { roughCutId: seeded.cut.id }
    );

    expect(response.status).toBe(401);
    expect(
      (await db.roughCut.findUniqueOrThrow({ where: { id: seeded.cut.id } })).overrides
    ).toBeNull();
  });

  it('returns 403 to a commenting member and stores nothing', async () => {
    const seeded = await seedReviewableCut();
    signedInAs(await addCommenter(seeded.project.id));

    const response = await callRoute(
      putOverrides,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/overrides`, {
        method: 'PUT',
        body: { version: 1, cuts: { [seeded.islandKey]: 'restore' } },
      }),
      { roughCutId: seeded.cut.id }
    );

    expect(response.status).toBe(403);
    expect(
      (await db.roughCut.findUniqueOrThrow({ where: { id: seeded.cut.id } })).overrides
    ).toBeNull();
  });

  it('stores validated overrides for the owner and reports the effective program', async () => {
    const seeded = await seedReviewableCut();
    signedInAs(seeded.owner);

    const response = await callRoute(
      putOverrides,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/overrides`, {
        method: 'PUT',
        body: {
          version: 1,
          cuts: { [seeded.islandKey]: 'restore' },
          extraCuts: [{ sourceVersionId: seeded.sourceVersion.id, inSeconds: 7, outSeconds: 8 }],
        },
      }),
      { roughCutId: seeded.cut.id }
    );

    expect(response.status).toBe(200);
    const payload = await readData<{
      overrides: { cuts: Record<string, string>; extraCuts: Array<{ key: string }> };
      summary: { restored: number; extraCuts: number; programSeconds: number };
      needsRender: boolean;
    }>(response);
    expect(payload.summary).toMatchObject({ restored: 1, extraCuts: 1, programSeconds: 8 });
    expect(payload.needsRender).toBe(true);
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: seeded.cut.id } });
    expect(stored.overrides).toMatchObject({ version: 1, cuts: { [seeded.islandKey]: 'restore' } });
    expect(payload.overrides.extraCuts[0]?.key).toMatch(/^manual:/);
  });

  it('rejects an unknown island key with 400 and stores nothing', async () => {
    const seeded = await seedReviewableCut();
    signedInAs(seeded.owner);

    const response = await callRoute(
      putOverrides,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/overrides`, {
        method: 'PUT',
        body: { version: 1, cuts: { 'nope:1-2': 'restore' } },
      }),
      { roughCutId: seeded.cut.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Unknown cut keys');
    expect(
      (await db.roughCut.findUniqueOrThrow({ where: { id: seeded.cut.id } })).overrides
    ).toBeNull();
  });

  it('refuses a run that is not READY and leaves the row', async () => {
    const scenario = await seedProject();
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'RUNNING',
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      putOverrides,
      apiRequest(`/api/rough-cuts/${cut.id}/overrides`, {
        method: 'PUT',
        body: { version: 1, cuts: {} },
      }),
      { roughCutId: cut.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('Rough cut is not ready to review');
    expect((await db.roughCut.findUniqueOrThrow({ where: { id: cut.id } })).overrides).toBeNull();
  });
});

describe('POST /api/rough-cuts/[roughCutId]/render', () => {
  it('returns 401 anonymously and 403 to a commenting member, enqueuing nothing', async () => {
    const seeded = await seedReviewableCut();
    signedOut();

    expect(
      (
        await callRoute(
          postRender,
          apiRequest(`/api/rough-cuts/${seeded.cut.id}/render`, { method: 'POST' }),
          { roughCutId: seeded.cut.id }
        )
      ).status
    ).toBe(401);

    signedInAs(await addCommenter(seeded.project.id));

    expect(
      (
        await callRoute(
          postRender,
          apiRequest(`/api/rough-cuts/${seeded.cut.id}/render`, { method: 'POST' }),
          { roughCutId: seeded.cut.id }
        )
      ).status
    ).toBe(403);
    expect(await db.mediaJob.count({ where: { kind: 'MATERIALIZE_ROUGH_CUT' } })).toBe(0);
  });

  it('enqueues one materialize job for the owner and refuses a second while it is pending', async () => {
    const seeded = await seedReviewableCut();
    signedInAs(seeded.owner);

    const first = await callRoute(
      postRender,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/render`, { method: 'POST' }),
      { roughCutId: seeded.cut.id }
    );
    expect(first.status).toBe(202);

    const jobs = await db.mediaJob.findMany({ where: { kind: 'MATERIALIZE_ROUGH_CUT' } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.versionId).toBe(seeded.sourceVersion.id);
    expect(jobs[0]?.payload).toEqual({ roughCutId: seeded.cut.id });

    const second = await callRoute(
      postRender,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/render`, { method: 'POST' }),
      { roughCutId: seeded.cut.id }
    );
    expect(second.status).toBe(409);
    expect(await db.mediaJob.count({ where: { kind: 'MATERIALIZE_ROUGH_CUT' } })).toBe(1);
  });

  it('enqueues again once the previous render has finished', async () => {
    const seeded = await seedReviewableCut();
    signedInAs(seeded.owner);

    await callRoute(
      postRender,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/render`, { method: 'POST' }),
      { roughCutId: seeded.cut.id }
    );
    await db.mediaJob.updateMany({
      where: { kind: 'MATERIALIZE_ROUGH_CUT' },
      data: { status: 'SUCCEEDED' },
    });

    const again = await callRoute(
      postRender,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/render`, { method: 'POST' }),
      { roughCutId: seeded.cut.id }
    );

    expect(again.status).toBe(202);
    expect(await db.mediaJob.count({ where: { kind: 'MATERIALIZE_ROUGH_CUT' } })).toBe(2);
  });

  it('ignores a job queued for another run', async () => {
    const seeded = await seedReviewableCut();
    const other = await createRoughCut({
      projectId: seeded.project.id,
      requestedById: seeded.owner.id,
      status: 'READY',
    });
    await db.mediaJob.create({
      data: {
        versionId: seeded.sourceVersion.id,
        kind: 'MATERIALIZE_ROUGH_CUT',
        payload: { roughCutId: other.id },
      },
    });
    signedInAs(seeded.owner);

    const response = await callRoute(
      postRender,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/render`, { method: 'POST' }),
      { roughCutId: seeded.cut.id }
    );

    expect(response.status).toBe(202);
    expect(await db.mediaJob.count({ where: { kind: 'MATERIALIZE_ROUGH_CUT' } })).toBe(2);
  });
});

describe('GET /api/videos/[videoId]/rough-cut', () => {
  it('returns 403 to an anonymous caller on a private project', async () => {
    const seeded = await seedReviewableCut();
    signedOut();

    const response = await callRoute(
      getVideoRoughCut,
      apiRequest(`/api/videos/${seeded.output.id}/rough-cut`),
      { videoId: seeded.output.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns null for a video that is not a rough-cut output', async () => {
    const seeded = await seedReviewableCut();
    signedInAs(seeded.owner);

    const response = await callRoute(
      getVideoRoughCut,
      apiRequest(`/api/videos/${seeded.source.id}/rough-cut`),
      { videoId: seeded.source.id }
    );

    expect(response.status).toBe(200);
    expect(await readData<{ roughCut: unknown }>(response)).toEqual({ roughCut: null });
  });

  it('returns the review payload with sources, islands, the effective program and render state', async () => {
    const seeded = await seedReviewableCut();
    await db.roughCut.update({
      where: { id: seeded.cut.id },
      data: { overrides: { version: 1, cuts: { [seeded.islandKey]: 'restore' }, extraCuts: [] } },
    });
    signedInAs(seeded.owner);

    const response = await callRoute(
      getVideoRoughCut,
      apiRequest(`/api/videos/${seeded.output.id}/rough-cut`),
      { videoId: seeded.output.id }
    );

    expect(response.status).toBe(200);
    const payload = await readData<{
      roughCut: { id: string };
      canEdit: boolean;
      review: {
        decisions: { cuts: Array<{ key: string }> };
        effective: { edits: Array<{ inSeconds: number; outSeconds: number }> };
        applied: { restoredKeys: string[]; staleCutKeys: string[] };
        overrides: { cuts: Record<string, string> } | null;
        renderedOverrides: unknown;
        needsRender: boolean;
        sources: Array<{
          versionId: string;
          title: string;
          playbackUrl: string | null;
          playbackKind: string | null;
        }>;
        render: { status: string };
      };
    }>(response);
    expect(payload.roughCut.id).toBe(seeded.cut.id);
    expect(payload.canEdit).toBe(true);
    expect(payload.review.decisions.cuts.map((cut) => cut.key)).toEqual([seeded.islandKey]);
    expect(payload.review.effective.edits.map((edit) => [edit.inSeconds, edit.outSeconds])).toEqual(
      [[1, 10]]
    );
    expect(payload.review.applied.restoredKeys).toEqual([seeded.islandKey]);
    expect(payload.review.overrides?.cuts).toEqual({ [seeded.islandKey]: 'restore' });
    expect(payload.review.renderedOverrides).toBeNull();
    expect(payload.review.needsRender).toBe(true);
    expect(payload.review.sources).toEqual([
      expect.objectContaining({
        versionId: seeded.sourceVersion.id,
        title: 'Cam A',
        playbackUrl: seeded.sourceVersion.originalUrl,
        playbackKind: 'file',
      }),
    ]);
    expect(payload.review.render.status).toBe('idle');
  });

  it('reports a queued render and stops asking for one once the saved cuts are the rendered ones', async () => {
    const seeded = await seedReviewableCut();
    const overrides = { version: 1, cuts: { [seeded.islandKey]: 'restore' }, extraCuts: [] };
    await db.roughCut.update({
      where: { id: seeded.cut.id },
      data: { overrides, renderedOverrides: overrides },
    });
    await db.mediaJob.create({
      data: {
        versionId: seeded.sourceVersion.id,
        kind: 'MATERIALIZE_ROUGH_CUT',
        payload: { roughCutId: seeded.cut.id },
      },
    });
    signedInAs(seeded.owner);

    const response = await callRoute(
      getVideoRoughCut,
      apiRequest(`/api/videos/${seeded.output.id}/rough-cut`),
      { videoId: seeded.output.id }
    );

    expect(response.status).toBe(200);
    const payload = await readData<{
      review: { needsRender: boolean; render: { status: string } };
    }>(response);
    expect(payload.review.needsRender).toBe(false);
    expect(payload.review.render.status).toBe('queued');
  });
});

describe('GET /api/rough-cuts/[roughCutId]?include=review', () => {
  it('adds the review payload only when it is asked for', async () => {
    const seeded = await seedReviewableCut();
    signedInAs(seeded.owner);

    const plain = await callRoute(getRoughCut, apiRequest(`/api/rough-cuts/${seeded.cut.id}`), {
      roughCutId: seeded.cut.id,
    });
    expect(plain.status).toBe(200);
    expect(await readData<{ review?: unknown }>(plain)).not.toHaveProperty('review');

    const withReview = await callRoute(
      getRoughCut,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}?include=review`),
      { roughCutId: seeded.cut.id }
    );
    expect(withReview.status).toBe(200);
    const payload = await readData<{
      review: { decisions: { cuts: Array<{ key: string }> }; needsRender: boolean };
    }>(withReview);
    expect(payload.review.decisions.cuts.map((cut) => cut.key)).toEqual([seeded.islandKey]);
    expect(payload.review.needsRender).toBe(false);
  });
});

describe('GET /api/rough-cuts/[roughCutId]/download', () => {
  it('exports the program the reviewer approved, not the one assembly proposed', async () => {
    const seeded = await seedReviewableCut();
    signedInAs(seeded.owner);

    const before = await callRoute(
      downloadRoughCut,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/download?format=otio`),
      { roughCutId: seeded.cut.id }
    );
    expect(before.status).toBe(200);
    expect(programClipRanges(await before.text())).toEqual([
      [24, 72],
      [144, 96],
    ]);

    await db.roughCut.update({
      where: { id: seeded.cut.id },
      data: { overrides: { version: 1, cuts: { [seeded.islandKey]: 'restore' }, extraCuts: [] } },
    });

    const after = await callRoute(
      downloadRoughCut,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/download?format=otio`),
      { roughCutId: seeded.cut.id }
    );
    expect(after.status).toBe(200);
    // One clip covering source 1s-10s: the two edits and the island between them,
    // 24 frames in and 216 frames long at 24fps.
    expect(programClipRanges(await after.text())).toEqual([[24, 216]]);
  });
});

/** [start frame, duration in frames] of every clip on the program track of an OTIO file. */
function programClipRanges(body: string): Array<[number, number]> {
  const timeline = JSON.parse(body) as {
    tracks: {
      children: Array<{
        name: string;
        children: Array<{
          OTIO_SCHEMA: string;
          source_range: { start_time: { value: number }; duration: { value: number } };
        }>;
      }>;
    };
  };
  const program = timeline.tracks.children[0];
  expect(program?.name).toBe('Program');
  return (program?.children ?? [])
    .filter((child) => child.OTIO_SCHEMA === 'Clip.1')
    .map((child) => [child.source_range.start_time.value, child.source_range.duration.value]);
}
