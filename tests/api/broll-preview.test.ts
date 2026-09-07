import { beforeEach, describe, it, expect, vi } from 'vitest';
import { db } from '@/lib/db';
import { GET } from '@/app/api/versions/[versionId]/broll-evidence/route';
import { GET as getTasks } from '@/app/api/versions/[versionId]/edit-tasks/route';
import { readVideoObjectBytes } from '@/lib/r2';
import { seedVersion, createUser, addProjectMember } from '../factories';
import { signedInAs, signedOut } from '../helpers/session';
import { apiRequest, callRoute } from '../helpers/request';

const jpeg = new Uint8Array([255, 216, 1, 2, 255, 217]);
const oversizedJpeg = new Uint8Array(262145);
oversizedJpeg.set([255, 216], 0);
oversizedJpeg.set([255, 217], 262143);
beforeEach(() => {
  vi.mocked(readVideoObjectBytes).mockClear();
});
async function source() {
  const s = await seedVersion({ providerId: 'r2', duration: 10 });
  const evidence = {
    version: 1,
    frames: [
      { key: `videos/broll-evidence/${s.version.id}/sample/0.jpg`, seconds: 1 },
      { key: `videos/broll-evidence/${s.version.id}/sample/1.jpg`, seconds: 5 },
      { key: `videos/broll-evidence/${s.version.id}/sample/2.jpg`, seconds: 9 },
    ],
  };
  await db.videoVersion.update({ where: { id: s.version.id }, data: { visualEvidence: evidence } });
  return { ...s, evidence };
}
const preview = (versionId: string, query = 'frame=1&generation=sample') =>
  callRoute(GET, apiRequest(`/api/versions/${versionId}/broll-evidence?${query}`), { versionId });

describe('B-roll frame previews', () => {
  it('refuses signed-out, unrelated and comment-only callers without reading media or changing evidence', async () => {
    const s = await source();
    signedOut();
    expect((await preview(s.version.id)).status).toBe(401);
    const outsider = await createUser();
    signedInAs(outsider);
    expect((await preview(s.version.id)).status).toBe(403);
    await addProjectMember({ projectId: s.project.id, userId: outsider.id, role: 'COMMENTATOR' });
    expect((await preview(s.version.id)).status).toBe(403);
    expect(readVideoObjectBytes).not.toHaveBeenCalled();
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: s.version.id } })).visualEvidence
    ).toEqual(s.evidence);
    signedInAs(s.owner);
    vi.mocked(readVideoObjectBytes).mockResolvedValueOnce(jpeg);
    expect((await preview(s.version.id)).status).toBe(200);
  });

  it('serves the exact stored frame with private image headers and a bounded read', async () => {
    const s = await source();
    signedInAs(s.owner);
    vi.mocked(readVideoObjectBytes).mockResolvedValueOnce(jpeg);
    const response = await preview(s.version.id);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg);
    expect(readVideoObjectBytes).toHaveBeenCalledExactlyOnceWith(
      `videos/broll-evidence/${s.version.id}/sample/1.jpg`,
      262145
    );
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: s.version.id } })).visualEvidence
    ).toEqual(s.evidence);
  });

  it('publishes version-bound preview URLs and the latest job through the editing library', async () => {
    const s = await source();
    await db.mediaJob.create({
      data: {
        versionId: s.version.id,
        kind: 'ANALYZE_BROLL',
        status: 'FAILED',
        error: 'Previous attempt failed',
        createdAt: new Date('2026-09-01T10:00:00Z'),
      },
    });
    const job = await db.mediaJob.create({
      data: {
        versionId: s.version.id,
        kind: 'ANALYZE_BROLL',
        status: 'SUCCEEDED',
        createdAt: new Date('2026-09-01T11:00:00Z'),
      },
    });
    await db.mediaJob.create({
      data: {
        versionId: s.version.id,
        kind: 'PROBE_MEDIA',
        status: 'FAILED',
        createdAt: new Date('2026-09-01T12:00:00Z'),
      },
    });
    signedInAs(s.owner);
    const response = await callRoute(
      getTasks,
      apiRequest(`/api/versions/${s.version.id}/edit-tasks`),
      { versionId: s.version.id }
    );
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.library.assets[0]).toMatchObject({
      versionId: s.version.id,
      analysisJobId: job.id,
      analysisStatus: 'SUCCEEDED',
    });
    expect(data.library.assets[0].visualEvidence.frames).toEqual([
      {
        key: `videos/broll-evidence/${s.version.id}/sample/0.jpg`,
        seconds: 1,
        previewUrl: `/api/versions/${s.version.id}/broll-evidence?frame=0&generation=sample`,
      },
      {
        key: `videos/broll-evidence/${s.version.id}/sample/1.jpg`,
        seconds: 5,
        previewUrl: `/api/versions/${s.version.id}/broll-evidence?frame=1&generation=sample`,
      },
      {
        key: `videos/broll-evidence/${s.version.id}/sample/2.jpg`,
        seconds: 9,
        previewUrl: `/api/versions/${s.version.id}/broll-evidence?frame=2&generation=sample`,
      },
    ]);
    vi.mocked(readVideoObjectBytes).mockResolvedValueOnce(jpeg);
    const image = await callRoute(
      GET,
      apiRequest(data.library.assets[0].visualEvidence.frames[2].previewUrl),
      { versionId: s.version.id }
    );
    expect(image.status).toBe(200);
    expect(readVideoObjectBytes).toHaveBeenLastCalledWith(
      `videos/broll-evidence/${s.version.id}/sample/2.jpg`,
      262145
    );
  });

  it('rejects malformed indexes, traversal, stale generations and evidence belonging to another source', async () => {
    const s = await source();
    signedInAs(s.owner);
    for (const query of [
      'frame=3&generation=sample',
      'frame=-1&generation=sample',
      'frame=1.0&generation=sample',
      'frame=0&generation=../other',
      'frame=0',
    ])
      expect((await preview(s.version.id, query)).status).toBe(400);
    expect((await preview(s.version.id, 'frame=0&generation=old')).status).toBe(404);
    await db.videoVersion.update({
      where: { id: s.version.id },
      data: {
        visualEvidence: {
          version: 1,
          frames: s.evidence.frames.map((frame) => ({
            ...frame,
            key: frame.key.replace(s.version.id, 'another-source'),
          })),
        },
      },
    });
    expect((await preview(s.version.id)).status).toBe(404);
    expect(readVideoObjectBytes).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['truncated', new Uint8Array([255, 216, 1, 2])],
    ['not JPEG', new Uint8Array([0, 0, 255, 217])],
    ['oversized', oversizedJpeg],
  ])('refuses %s media', async (_label, bytes) => {
    const s = await source();
    signedInAs(s.owner);
    vi.mocked(readVideoObjectBytes).mockResolvedValueOnce(bytes as Uint8Array | null);
    expect((await preview(s.version.id)).status).toBe(404);
  });
});
