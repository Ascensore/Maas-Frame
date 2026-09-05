import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  GET as listBatches,
  POST as createBatch,
} from '@/app/api/rough-cuts/[roughCutId]/shorts/route';
import { GET as getBatch } from '@/app/api/short-form-batches/[batchId]/route';
import { POST as renderBatch } from '@/app/api/short-form-batches/[batchId]/render/route';
import { PATCH as patchShort } from '@/app/api/shorts/[shortId]/route';
import { DEFAULT_SHORT_CAPTION_STYLE } from '@/lib/short-form';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createReadyTranscript,
  createRoughCut,
  createUser,
  createVersion,
  createVideo,
  seedProject,
} from '../factories';

beforeEach(() => {
  vi.stubEnv('OPENFRAME_ENABLE_SHORTS', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'false');
});

async function seedRenderedCut() {
  const scenario = await seedProject();
  const outputVideo = await createVideo({ projectId: scenario.project.id, title: 'Rendered cut' });
  const version = await createVersion({
    videoParentId: outputVideo.id,
    providerId: 'r2',
    providerVideoId: 'videos/rendered-cut.mp4',
    originalUrl: '/api/upload/video/rendered-cut.mp4',
    duration: 120,
  });
  const roughCut = await createRoughCut({
    projectId: scenario.project.id,
    requestedById: scenario.owner.id,
    status: 'READY',
    outputVideoId: outputVideo.id,
  });
  const lines = Array.from({ length: 24 }, (_, index) => ({
    startSec: index * 5,
    endSec: index * 5 + 4,
    text: `Useful sentence number ${index} explains the complete idea.`,
    words: [
      { start: index * 5, end: index * 5 + 1, text: 'Useful' },
      { start: index * 5 + 1, end: index * 5 + 2, text: `sentence ${index}` },
      { start: index * 5 + 2, end: index * 5 + 4, text: 'explains the complete idea.' },
    ],
  }));
  await createReadyTranscript({ versionId: version.id, segments: lines });
  return { ...scenario, outputVideo, version, roughCut };
}

async function readyBatch(scenario: Awaited<ReturnType<typeof seedRenderedCut>>) {
  const batch = await db.shortFormBatch.create({
    data: {
      roughCutId: scenario.roughCut.id,
      sourceVersionId: scenario.version.id,
      requestedById: scenario.owner.id,
      status: 'READY',
      config: {
        count: 8,
        minDurationSeconds: 15,
        maxDurationSeconds: 45,
        useAi: false,
        captionStyle: DEFAULT_SHORT_CAPTION_STYLE,
      },
    },
  });
  const candidate = await db.shortFormCandidate.create({
    data: {
      batchId: batch.id,
      rank: 1,
      sourceStartSec: 0,
      sourceEndSec: 19,
      score: 0.8,
      scores: { hook: 0.8 },
      title: 'Useful sentence',
      socialCaption: 'Useful sentence',
      captionStyle: DEFAULT_SHORT_CAPTION_STYLE,
    },
  });
  return { batch, candidate };
}

describe('POST/GET /api/rough-cuts/[roughCutId]/shorts', () => {
  it('requires authentication and edit access', async () => {
    const scenario = await seedRenderedCut();
    signedOut();
    const anonymous = await callRoute(
      createBatch,
      apiRequest(`/api/rough-cuts/${scenario.roughCut.id}/shorts`, { method: 'POST', body: {} }),
      { roughCutId: scenario.roughCut.id }
    );
    expect(anonymous.status).toBe(401);

    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);
    const refused = await callRoute(
      createBatch,
      apiRequest(`/api/rough-cuts/${scenario.roughCut.id}/shorts`, { method: 'POST', body: {} }),
      { roughCutId: scenario.roughCut.id }
    );
    expect(refused.status).toBe(403);
    expect(await db.shortFormBatch.count()).toBe(0);

    const outsider = await createUser();
    signedInAs(outsider);
    const refusedList = await callRoute(
      listBatches,
      apiRequest(`/api/rough-cuts/${scenario.roughCut.id}/shorts`),
      { roughCutId: scenario.roughCut.id }
    );
    expect(refusedList.status).toBe(403);
  });

  it('snapshots the active output version and transactionally queues analysis', async () => {
    const scenario = await seedRenderedCut();
    signedInAs(scenario.owner);
    const response = await callRoute(
      createBatch,
      apiRequest(`/api/rough-cuts/${scenario.roughCut.id}/shorts`, {
        method: 'POST',
        body: { count: 6, minDurationSeconds: 18, maxDurationSeconds: 35, useAi: true },
      }),
      { roughCutId: scenario.roughCut.id }
    );
    expect(response.status).toBe(202);
    const data = await readData<{
      batch: { id: string; sourceVersionId: string; warnings: string[] };
    }>(response);
    expect(data.batch.sourceVersionId).toBe(scenario.version.id);
    expect(data.batch.warnings).toEqual([
      'AI reranking is unavailable; deterministic ranking will be used.',
    ]);
    const job = await db.mediaJob.findFirstOrThrow({
      where: { payload: { path: ['batchId'], equals: data.batch.id } },
    });
    expect(job).toMatchObject({
      kind: 'ANALYZE_SHORT_FORM',
      versionId: scenario.version.id,
      status: 'PENDING',
    });

    const list = await callRoute(
      listBatches,
      apiRequest(`/api/rough-cuts/${scenario.roughCut.id}/shorts`),
      { roughCutId: scenario.roughCut.id }
    );
    expect(list.status).toBe(200);
    expect((await readData<{ batches: Array<{ id: string }> }>(list)).batches[0]?.id).toBe(
      data.batch.id
    );
  });

  it('rejects invalid configuration and a concurrent active batch without extra rows', async () => {
    const scenario = await seedRenderedCut();
    signedInAs(scenario.owner);
    const invalid = await callRoute(
      createBatch,
      apiRequest('http://localhost', { method: 'POST', body: { count: 4 } }),
      { roughCutId: scenario.roughCut.id }
    );
    expect(invalid.status).toBe(422);
    const first = await callRoute(
      createBatch,
      apiRequest('http://localhost', { method: 'POST', body: {} }),
      { roughCutId: scenario.roughCut.id }
    );
    expect(first.status).toBe(202);
    const second = await callRoute(
      createBatch,
      apiRequest('http://localhost', { method: 'POST', body: {} }),
      { roughCutId: scenario.roughCut.id }
    );
    expect(second.status).toBe(409);
    expect(await db.shortFormBatch.count()).toBe(1);
    expect(await db.mediaJob.count({ where: { kind: 'ANALYZE_SHORT_FORM' } })).toBe(1);
  });

  it('rolls batch creation back when analysis job creation fails', async () => {
    const scenario = await seedRenderedCut();
    signedInAs(scenario.owner);
    await db.$executeRawUnsafe(
      `ALTER TABLE media_jobs ADD CONSTRAINT reject_short_analysis_for_test
       CHECK (kind <> 'ANALYZE_SHORT_FORM') NOT VALID`
    );
    try {
      const response = await callRoute(
        createBatch,
        apiRequest('http://localhost', { method: 'POST', body: {} }),
        { roughCutId: scenario.roughCut.id }
      );
      expect(response.status).toBe(500);
      expect(await db.shortFormBatch.count()).toBe(0);
      expect(await db.mediaJob.count({ where: { kind: 'ANALYZE_SHORT_FORM' } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe(
        `ALTER TABLE media_jobs DROP CONSTRAINT IF EXISTS reject_short_analysis_for_test`
      );
    }
  });
});

describe('short-form batch review and rendering routes', () => {
  it('loads candidates for an authorized editor and refuses an outsider', async () => {
    const scenario = await seedRenderedCut();
    const { batch, candidate } = await readyBatch(scenario);
    const outsider = await createUser();
    signedInAs(outsider);
    const refused = await callRoute(getBatch, apiRequest(`/api/short-form-batches/${batch.id}`), {
      batchId: batch.id,
    });
    expect(refused.status).toBe(403);
    signedInAs(scenario.owner);
    const response = await callRoute(getBatch, apiRequest(`/api/short-form-batches/${batch.id}`), {
      batchId: batch.id,
    });
    expect(response.status).toBe(200);
    const data = await readData<{
      batch: { candidates: CandidateShape[] };
      sentenceBoundaries: number[];
    }>(response);
    expect(data.batch.candidates[0]?.id).toBe(candidate.id);
    expect(data.sentenceBoundaries).toContain(19);
  });

  it('patches sentence-snapped ranges, crop, caption style, and publication metadata', async () => {
    const scenario = await seedRenderedCut();
    const { candidate } = await readyBatch(scenario);
    const outsider = await createUser();
    signedInAs(outsider);
    const refused = await callRoute(
      patchShort,
      apiRequest(`/api/shorts/${candidate.id}`, {
        method: 'PATCH',
        body: { title: 'Unauthorized edit' },
      }),
      { shortId: candidate.id }
    );
    expect(refused.status).toBe(403);
    expect(
      await db.shortFormCandidate.findUniqueOrThrow({ where: { id: candidate.id } })
    ).toMatchObject({ title: 'Useful sentence' });

    signedInAs(scenario.owner);
    const response = await callRoute(
      patchShort,
      apiRequest(`/api/shorts/${candidate.id}`, {
        method: 'PATCH',
        body: {
          start: 5,
          end: 24,
          cropMode: 'MANUAL',
          focusX: 0.65,
          focusY: 0.35,
          title: 'A sharper title',
          socialCaption: 'Ready for social',
          hashtags: ['#OpenFrame'],
          captionStyle: { ...DEFAULT_SHORT_CAPTION_STYLE, maxWordsPerCue: 3 },
        },
      }),
      { shortId: candidate.id }
    );
    expect(response.status).toBe(200);
    const stored = await db.shortFormCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(stored).toMatchObject({
      sourceStartSec: 5,
      sourceEndSec: 24,
      cropMode: 'MANUAL',
      focusX: 0.65,
      focusY: 0.35,
      title: 'A sharper title',
      socialCaption: 'Ready for social',
    });
    expect(stored.hashtags).toEqual(['#OpenFrame']);
    expect(stored.captionStyle).toMatchObject({ maxWordsPerCue: 3, marginVertical: 280 });
  });

  it('rejects non-sentence ranges, invalid focus, and invalid caption styles without changing the row', async () => {
    const scenario = await seedRenderedCut();
    const { candidate } = await readyBatch(scenario);
    signedInAs(scenario.owner);
    const range = await callRoute(
      patchShort,
      apiRequest('http://localhost', { method: 'PATCH', body: { start: 1 } }),
      { shortId: candidate.id }
    );
    expect(range.status).toBe(400);
    const focus = await callRoute(
      patchShort,
      apiRequest('http://localhost', { method: 'PATCH', body: { cropMode: 'MANUAL' } }),
      { shortId: candidate.id }
    );
    expect(focus.status).toBe(400);
    const style = await callRoute(
      patchShort,
      apiRequest('http://localhost', {
        method: 'PATCH',
        body: { captionStyle: { ...DEFAULT_SHORT_CAPTION_STYLE, font: 'comic-sans' } },
      }),
      { shortId: candidate.id }
    );
    expect(style.status).toBe(422);
    const playbackStyle = await callRoute(
      patchShort,
      apiRequest('http://localhost', {
        method: 'PATCH',
        body: { captionStyle: { ...DEFAULT_SHORT_CAPTION_STYLE, playbackRate: 1.25 } },
      }),
      { shortId: candidate.id }
    );
    expect(playbackStyle.status).toBe(422);
    expect(
      await db.shortFormCandidate.findUniqueOrThrow({ where: { id: candidate.id } })
    ).toMatchObject({ sourceStartSec: 0, cropMode: 'AUTO', status: 'PROPOSED' });
  });

  it('transactionally approves selected candidates and queues independent renders', async () => {
    const scenario = await seedRenderedCut();
    const { batch, candidate } = await readyBatch(scenario);
    const outsider = await createUser();
    signedInAs(outsider);
    const refused = await callRoute(
      renderBatch,
      apiRequest('http://localhost', {
        method: 'POST',
        body: { candidateIds: [candidate.id] },
      }),
      { batchId: batch.id }
    );
    expect(refused.status).toBe(403);
    expect(
      await db.shortFormCandidate.findUniqueOrThrow({ where: { id: candidate.id } })
    ).toMatchObject({ status: 'PROPOSED' });

    signedInAs(scenario.owner);
    const response = await callRoute(
      renderBatch,
      apiRequest('http://localhost', { method: 'POST', body: { candidateIds: [candidate.id] } }),
      { batchId: batch.id }
    );
    expect(response.status).toBe(202);
    expect(
      await db.shortFormCandidate.findUniqueOrThrow({ where: { id: candidate.id } })
    ).toMatchObject({ status: 'APPROVED', error: null });
    expect(await db.mediaJob.findFirst({ where: { kind: 'RENDER_SHORT_FORM' } })).toMatchObject({
      versionId: scenario.version.id,
      payload: { batchId: batch.id, candidateId: candidate.id },
    });
  });

  it('rolls approval back when render job creation fails', async () => {
    const scenario = await seedRenderedCut();
    const { batch, candidate } = await readyBatch(scenario);
    signedInAs(scenario.owner);
    await db.$executeRawUnsafe(
      `ALTER TABLE media_jobs ADD CONSTRAINT reject_short_render_for_test
       CHECK (kind <> 'RENDER_SHORT_FORM') NOT VALID`
    );
    try {
      const response = await callRoute(
        renderBatch,
        apiRequest('http://localhost', {
          method: 'POST',
          body: { candidateIds: [candidate.id] },
        }),
        { batchId: batch.id }
      );
      expect(response.status).toBe(500);
      expect(
        await db.shortFormCandidate.findUniqueOrThrow({ where: { id: candidate.id } })
      ).toMatchObject({ status: 'PROPOSED', error: null });
      expect(await db.mediaJob.count({ where: { kind: 'RENDER_SHORT_FORM' } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe(
        `ALTER TABLE media_jobs DROP CONSTRAINT IF EXISTS reject_short_render_for_test`
      );
    }
  });

  it('refuses cross-batch IDs and leaves every candidate unchanged', async () => {
    const scenario = await seedRenderedCut();
    const first = await readyBatch(scenario);
    const other = await db.shortFormBatch.create({
      data: {
        roughCutId: scenario.roughCut.id,
        sourceVersionId: scenario.version.id,
        requestedById: scenario.owner.id,
        status: 'READY',
        config: first.batch.config as Prisma.InputJsonValue,
      },
    });
    const foreign = await db.shortFormCandidate.create({
      data: {
        batchId: other.id,
        rank: 1,
        sourceStartSec: 25,
        sourceEndSec: 44,
        score: 0.7,
        scores: {},
        title: 'Foreign',
        captionStyle: DEFAULT_SHORT_CAPTION_STYLE,
      },
    });
    signedInAs(scenario.owner);
    const response = await callRoute(
      renderBatch,
      apiRequest('http://localhost', {
        method: 'POST',
        body: { candidateIds: [first.candidate.id, foreign.id] },
      }),
      { batchId: first.batch.id }
    );
    expect(response.status).toBe(400);
    const unchanged = await db.shortFormCandidate.findMany({
      where: { id: { in: [first.candidate.id, foreign.id] } },
      orderBy: { id: 'asc' },
    });
    expect(unchanged.map((row) => row.status)).toEqual(['PROPOSED', 'PROPOSED']);
    expect(await db.mediaJob.count({ where: { kind: 'RENDER_SHORT_FORM' } })).toBe(0);
  });
});

type CandidateShape = { id: string };
