import { afterAll, describe, it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { db } from '@/lib/db';
import { POST } from '@/app/api/versions/[versionId]/broll-evidence/route';
import { analyzeBroll } from '@/lib/rough-cut/broll-evidence';
import { retainedBrollUrls } from '@/lib/comment-edit/broll-retention';
import { seedVersion, createUser, createComment } from '../factories';
import { signedInAs, signedOut } from '../helpers/session';
import { apiRequest, callRoute } from '../helpers/request';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const call = (versionId: string) =>
  callRoute(
    POST,
    apiRequest('/api/versions/' + versionId + '/broll-evidence', { method: 'POST' }),
    { versionId }
  );
describe('B-roll evidence', () => {
  it('retains previous evidence if a later analysis upload fails', async () => {
    const s = await seedVersion({ providerId: 'r2', duration: 10 });
    const previous = {
      version: 1,
      frames: [0, 1, 2].map((i) => ({
        key: 'videos/broll-evidence/' + s.version.id + '/old/' + i + '.jpg',
        seconds: i + 1,
      })),
    };
    await db.videoVersion.update({
      where: { id: s.version.id },
      data: { visualEvidence: previous },
    });
    const run = vi.fn(async (_command: string, args: string[]) => {
      await writeFile(args.at(-1)!, Buffer.from([255, 216, 255, 217]));
      return { code: 0, stderr: '' };
    });
    const uploadObject = vi
      .fn(async () => {})
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('upload refused'));
    await expect(
      analyzeBroll(
        { pool, run, uploadObject, downloadVersionMedia: vi.fn(async () => {}) },
        s.version.id
      )
    ).rejects.toThrow('upload refused');
    expect(
      (await db.videoVersion.findUnique({ where: { id: s.version.id } }))?.visualEvidence
    ).toEqual(previous);
  });
  it('denies unauthorized callers and deduplicates concurrent analysis requests', async () => {
    const s = await seedVersion({ providerId: 'r2', duration: 10 });
    signedOut();
    expect((await call(s.version.id)).status).toBe(401);
    signedInAs(await createUser());
    expect((await call(s.version.id)).status).toBe(403);
    expect(await db.mediaJob.count()).toBe(0);
    signedInAs(s.owner);
    expect(
      (await Promise.all([call(s.version.id), call(s.version.id)])).map((r) => r.status)
    ).toEqual([202, 202]);
    expect(
      await db.mediaJob.count({ where: { versionId: s.version.id, kind: 'ANALYZE_BROLL' } })
    ).toBe(1);
  });
  it('samples three actual source positions and publishes evidence only after all uploads', async () => {
    const s = await seedVersion({ providerId: 'r2', duration: 10 });
    const run = vi.fn(async (_command: string, args: string[]) => {
      await writeFile(args.at(-1)!, Buffer.from([255, 216, 255, 217]));
      return { code: 0, stderr: '' };
    });
    const uploadObject = vi.fn(async () => {
      expect(
        (await db.videoVersion.findUnique({ where: { id: s.version.id } }))?.visualEvidence
      ).toBeNull();
    });
    const downloadVersionMedia = vi.fn(async () => {});
    await analyzeBroll({ pool, run, uploadObject, downloadVersionMedia }, s.version.id);
    expect(run.mock.calls.map(([, args]) => args[args.indexOf('-ss') + 1])).toEqual([
      '1',
      '5',
      '9',
    ]);
    expect(uploadObject).toHaveBeenCalledTimes(3);
    expect(downloadVersionMedia).toHaveBeenCalledWith(
      expect.objectContaining({ id: s.version.id, providerId: 'r2' }),
      expect.any(String)
    );
    const evidence = (await db.videoVersion.findUniqueOrThrow({ where: { id: s.version.id } }))
      .visualEvidence as { frames: { key: string; seconds: number }[] };
    expect(evidence.frames.map((f) => f.seconds)).toEqual([1, 5, 9]);
    const urls = evidence.frames.map((f) => '/api/upload/video/' + f.key.slice(7));
    expect(
      await retainedBrollUrls([...urls, '/api/upload/video/broll-evidence/missing/x/0.jpg'])
    ).toEqual(urls);
    const comment = await createComment({ versionId: s.version.id, authorId: s.owner.id });
    await db.commentEditTask.create({
      data: { commentId: comment.id, snapshot: { assets: [{ visualEvidence: evidence }] } },
    });
    await db.videoVersion.update({ where: { id: s.version.id }, data: { visualEvidence: {} } });
    expect((await retainedBrollUrls(urls)).sort()).toEqual(urls.sort());
  });
  it('does not publish partial evidence when sampling fails', async () => {
    const s = await seedVersion({ providerId: 'r2', duration: 10 });
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (run.mock.calls.length === 2) return { code: 1, stderr: 'decode failed' };
      await writeFile(args.at(-1)!, Buffer.from([255, 216, 255, 217]));
      return { code: 0, stderr: '' };
    });
    await expect(
      analyzeBroll(
        {
          pool,
          run,
          uploadObject: vi.fn(async () => {}),
          downloadVersionMedia: vi.fn(async () => {}),
        },
        s.version.id
      )
    ).rejects.toThrow('decode failed');
    expect(
      (await db.videoVersion.findUnique({ where: { id: s.version.id } }))?.visualEvidence
    ).toBeNull();
  });
});
