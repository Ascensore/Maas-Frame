import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Locator } from '@playwright/test';
import path from 'node:path';
import { test, expect } from './fixtures';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { db } from '@/lib/db';
import { createComment, createRoughCut, createVideo, createVersion } from '../factories';
import { REPO_ROOT } from '../helpers/env';

async function expectPlayback(video: Locator) {
  await video.evaluate(async (el) => {
    const media = el as HTMLVideoElement;
    media.muted = true;
    await media.play();
  });
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.2);
  await video.evaluate((el) => (el as HTMLVideoElement).pause());
}

// Starts at the worker's completed-draft boundary. The real browser, API, database,
// and authenticated media proxy run here; planning and FFmpeg are covered separately.
// The two-second fixture checks playable previews, not the accuracy of a rendered cut.
test('a draft can be previewed, accepted, reopened, and adjusted while retaining its earlier preview', async ({
  page,
  seed,
  seededUser,
}) => {
  const s = await seed.version(seededUser);
  const filename = `${randomUUID()}.mp4`;
  const previewUrl = `/api/upload/video/${filename}`;
  const storage = new S3Client({
    endpoint: process.env.R2_ENDPOINT ?? 'http://minio-test:9000',
    region: 'auto',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? 'openframe',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? 'openframe-test-secret',
    },
  });
  const object = {
    Bucket: process.env.R2_BUCKET_NAME ?? 'openframe-test',
    Key: `videos/${filename}`,
  };
  try {
    await storage.send(
      new PutObjectCommand({
        ...object,
        Body: await readFile(path.join(REPO_ROOT, 'tests/fixtures/sample.mp4')),
        ContentType: 'video/mp4',
      })
    );
    const outputVideo = await createVideo({ projectId: s.project.id, title: 'AI review draft' });
    const output = await createVersion({
      videoParentId: outputVideo.id,
      providerId: 'r2',
      providerVideoId: filename,
      originalUrl: previewUrl,
      duration: 2,
    });
    const sourceVideo = await createVideo({ projectId: s.project.id });
    const source = await createVersion({
      videoParentId: sourceVideo.id,
      providerId: 'r2',
      duration: 30,
    });
    const decisions = {
      version: 1,
      rate: { num: 25, den: 1, dropFrame: false },
      clips: [
        {
          versionId: source.id,
          videoId: sourceVideo.id,
          role: 'A',
          offsetSeconds: 0,
          durationSeconds: 30,
          track: 1,
          fileName: 'source.mp4',
          targetUrl: 'source.mp4',
        },
      ],
      edits: [
        {
          sourceVersionId: source.id,
          cameraRole: 'A',
          targetTrack: 1,
          inSeconds: 10,
          outSeconds: 20,
          timelineStartSeconds: 0,
          timelineEndSeconds: 10,
        },
      ],
    };
    const cut = await createRoughCut({
      projectId: s.project.id,
      requestedById: seededUser.id,
      status: 'READY',
      decisions,
      outputVideoId: s.videoId,
    });
    await db.videoVersion.update({
      where: { id: s.versionId },
      data: { providerId: 'r2', duration: 10 },
    });
    await db.roughCut.update({
      where: { id: cut.id },
      data: { renderedDecisions: decisions, renderedVersionId: s.versionId },
    });
    const draftCut = await createRoughCut({
      projectId: s.project.id,
      requestedById: seededUser.id,
      status: 'READY',
      decisions,
      outputVideoId: outputVideo.id,
    });
    await db.roughCut.update({
      where: { id: draftCut.id },
      data: { renderedDecisions: decisions, renderedVersionId: output.id },
    });
    const comment = await createComment({
      versionId: s.versionId,
      authorId: seededUser.id,
      content: 'Remove the pause',
      timestamp: 2,
      timestampEnd: 4,
    });
    const plan = { version: 1, operations: [{ op: 'cut', start: 2, end: 3 }] };
    const run = await db.agentRun.create({
      data: {
        versionId: s.versionId,
        kind: 'EDIT',
        agentSlug: 'edit',
        model: 'mock',
        status: 'SUCCEEDED',
        triggeredById: seededUser.id,
        result: { plansByCommentId: { [comment.id]: plan }, removedSeconds: 1 },
      },
    });
    const job = await db.mediaJob.create({
      data: { versionId: s.versionId, kind: 'MATERIALIZE_ROUGH_CUT', status: 'SUCCEEDED' },
    });
    await db.commentEditTask.create({
      data: {
        commentId: comment.id,
        status: 'RENDERING',
        agentRunId: run.id,
        renderJobId: job.id,
        outputVersionId: output.id,
        roughCutId: draftCut.id,
        snapshot: {
          versionId: s.versionId,
          content: 'Remove the pause',
          start: 2,
          end: 4,
          decisions,
        },
      },
    });

    await page.goto(`/projects/${s.project.id}/videos/${s.videoId}`);
    await expect(
      page.getByText('AI draft ready for review', { exact: true }).first()
    ).toBeVisible();
    await page.getByText('What changed', { exact: true }).first().click();
    await expect(
      page.getByText('2.00–3.00s: Remove footage', { exact: true }).first()
    ).toBeVisible();
    await page.getByRole('button', { name: 'Preview draft', exact: true }).first().click();
    const preview = page.getByLabel('AI edited draft', { exact: true }).first();
    await expect(preview).toHaveAttribute('src', previewUrl);
    await expect
      .poll(() => preview.evaluate((el) => (el as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(1);
    expect(await preview.evaluate((el) => (el as HTMLVideoElement).duration)).toBeCloseTo(2, 1);

    await expectPlayback(preview);
    await page.getByRole('button', { name: 'Accept & resolve', exact: true }).first().click();
    await expect
      .poll(
        async () => (await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).isResolved
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Resolved', exact: true }).first().click();
    await expect(page.getByText('AI draft accepted', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Undo acceptance', exact: true }).first().click();
    await expect
      .poll(
        async () => (await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).isResolved
      )
      .toBe(false);
    await expect(
      page.getByText('AI draft ready for review', { exact: true }).first()
    ).toBeVisible();
    expect(
      await db.commentEditTask.findUniqueOrThrow({ where: { commentId: comment.id } })
    ).toMatchObject({
      agentRunId: run.id,
      outputVersionId: output.id,
      status: 'RENDERING',
    });
    await page.getByRole('button', { name: 'Resolved', exact: true }).first().click();
    await expect(page.getByText('Remove the pause', { exact: true }).first()).toBeVisible();
    await page.getByText('Adjust draft', { exact: true }).first().click();
    await page
      .getByLabel('Describe the adjustment')
      .first()
      .fill('Keep a little more of the pause');
    await page
      .getByRole('button', { name: 'Generate adjusted draft', exact: true })
      .first()
      .click();
    await expect(page.getByText('AI is planning the edit…', { exact: true }).first()).toBeVisible();
    const adjusted = await db.commentEditTask.findUniqueOrThrow({
      where: { commentId: comment.id },
    });
    expect(adjusted).toMatchObject({
      status: 'PLANNING',
      outputVersionId: null,
      snapshot: {
        content: 'Remove the pause',
        start: 2,
        end: 4,
        revision: {
          feedback: ['Keep a little more of the pause'],
          previousPlan: plan,
          reusePlan: false,
        },
      },
    });
    expect(adjusted.agentRunId).not.toBe(run.id);
    expect(
      await db.agentRun.findUniqueOrThrow({ where: { id: adjusted.agentRunId! } })
    ).toMatchObject({ status: 'PENDING', model: 'mock' });
    expect(await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).toMatchObject({
      content: 'Remove the pause',
      isResolved: false,
      resolvedAt: null,
    });
    const history = await db.commentEditRevision.findMany({ where: { taskId: adjusted.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      agentRunId: run.id,
      outputVersionId: output.id,
      status: 'READY',
    });

    // A reload proves both the pending revision and the pinned earlier output survive.
    await page.reload();
    await expect(
      page.getByText('Latest adjustment: Keep a little more of the pause', { exact: true }).first()
    ).toBeVisible();
    await page.getByText('Earlier drafts (1)', { exact: true }).first().click();
    const earlier = page.getByLabel(`Earlier AI draft ${history[0].id}`, { exact: true }).first();
    await earlier.locator('..').locator('summary').click();
    await expect(earlier).toBeVisible();
    await expect(earlier).toHaveAttribute('src', previewUrl);
    await earlier.evaluate((el) => (el as HTMLVideoElement).load());
    await expect
      .poll(() => earlier.evaluate((el) => (el as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(1);
    await expectPlayback(earlier);
    await expect(
      page.getByRole('link', { name: 'Open earlier draft', exact: true }).first()
    ).toHaveAttribute('href', `/projects/${s.project.id}/videos/${outputVideo.id}`);
    expect(
      (await db.roughCut.findUniqueOrThrow({ where: { id: cut.id } })).renderedDecisions
    ).toEqual(decisions);
  } finally {
    await storage.send(new DeleteObjectCommand(object));
    storage.destroy();
  }
});
