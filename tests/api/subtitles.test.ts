// The subtitle family: list, upload, delete, and the proxy that serves the stored
// WebVTT back to the player.
//
// Two properties are worth pinning down here rather than in the unit suite.
//
//  - The upload path is editor-only. Every other write under /api/videos/[videoId]
//    is open to anyone who may comment, guests included, so a subtitle route that
//    reached for `canUploadAssets` instead of `canManageAssets` would look correct
//    next to its neighbours and would let a share-link viewer rewrite the captions
//    on a delivered cut.
//
//  - What lands in storage is the normalised file, never the bytes that were
//    uploaded. The assertions below read the PutObject command rather than trusting
//    the 201.
//
// tests/setup/api.ts stubs the named helpers in `@/lib/r2` but leaves `r2Client`
// real, and the real one throws on first use, so it is replaced with a recorder.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  GET as listSubtitles,
  POST as uploadSubtitle,
} from '@/app/api/videos/[videoId]/subtitles/route';
import { DELETE as deleteSubtitle } from '@/app/api/videos/[videoId]/subtitles/[subtitleId]/route';
import { GET as serveSubtitle } from '@/app/api/upload/subtitle/[filename]/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { addProjectMember, createUser, seedVersion } from '../factories';

const r2 = vi.hoisted(() => ({
  bucket: 'openframe-subtitle-test-bucket',
  puts: [] as Array<{ key: string; body: string; contentType: string }>,
  deletedKeys: [] as string[],
  gets: [] as string[],
}));

vi.mock('@/lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  return {
    ...actual,
    R2_BUCKET_NAME: r2.bucket,
    r2Client: {
      send: async (command: {
        constructor: { name: string };
        input?: { Key?: string; Body?: Buffer; ContentType?: string };
      }) => {
        const key = command.input?.Key ?? '';
        switch (command.constructor.name) {
          case 'PutObjectCommand':
            r2.puts.push({
              key,
              body: Buffer.from(command.input?.Body ?? Buffer.alloc(0)).toString('utf8'),
              contentType: command.input?.ContentType ?? '',
            });
            return {};
          case 'DeleteObjectCommand':
            r2.deletedKeys.push(key);
            return {};
          case 'GetObjectCommand': {
            r2.gets.push(key);
            const stored = r2.puts.find((put) => put.key === key);
            if (!stored) {
              const error = new Error('NoSuchKey');
              error.name = 'NoSuchKey';
              throw error;
            }
            return {
              Body: new Response(stored.body).body,
              ContentType: stored.contentType,
              ContentLength: Buffer.byteLength(stored.body),
            };
          }
          default:
            return {};
        }
      },
    },
  };
});

const SRT_FILE = ['1', '00:00:01,000 --> 00:00:02,500', 'Merhaba', '', ''].join('\n');
const NORMALIZED_VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nMerhaba\n';
const SUBTITLE_KEY = /^subtitles\/[0-9a-f-]{36}\.vtt$/;

beforeEach(() => {
  r2.puts.length = 0;
  r2.deletedKeys.length = 0;
  r2.gets.length = 0;
});

function subtitlesUrl(videoId: string): string {
  return `/api/videos/${videoId}/subtitles`;
}

function subtitleForm(input: {
  content?: string;
  fileName?: string;
  versionId: string;
  language?: string;
  label?: string;
}): FormData {
  const form = new FormData();
  form.append(
    'subtitle',
    new File([input.content ?? SRT_FILE], input.fileName ?? 'cut.tr.srt', { type: 'text/plain' })
  );
  form.append('versionId', input.versionId);
  if (input.language !== undefined) form.append('language', input.language);
  if (input.label !== undefined) form.append('label', input.label);
  return form;
}

function uploadRequest(videoId: string, form: FormData) {
  return apiRequest(subtitlesUrl(videoId), {
    rawBody: form,
    // Constructing a Request from a FormData sets no Content-Length, and the route
    // refuses a body it cannot size before it reads one.
    headers: { 'content-length': '4096' },
  });
}

/** An editor-owned bunny version with one Turkish track already uploaded. */
async function seedSubtitledVersion() {
  const scenario = await seedVersion({ providerId: 'bunny' });
  signedInAs(scenario.owner);
  const response = await callRoute(
    uploadSubtitle,
    uploadRequest(
      scenario.video.id,
      subtitleForm({ versionId: scenario.version.id, language: 'tr', label: 'Türkçe' })
    ),
    { videoId: scenario.video.id }
  );
  expect(response.status).toBe(201);
  const subtitle = await readData<{ id: string; url: string }>(response);
  return { ...scenario, subtitle };
}

// ---------------------------------------------------------------------------
// POST /api/videos/[videoId]/subtitles
// ---------------------------------------------------------------------------
describe('POST /api/videos/[videoId]/subtitles', () => {
  it('stores the normalised WebVTT rather than the uploaded SRT', async () => {
    const scenario = await seedVersion({ providerId: 'bunny' });
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadSubtitle,
      uploadRequest(
        scenario.video.id,
        subtitleForm({ versionId: scenario.version.id, language: 'TR', label: ' Türkçe ' })
      ),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(201);
    const created = await readData<{ language: string; label: string; url: string }>(response);
    expect(created.language).toBe('tr');
    expect(created.label).toBe('Türkçe');
    expect(created.url).toMatch(/^\/api\/upload\/subtitle\/[0-9a-f-]{36}\.vtt$/);

    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0].key).toMatch(SUBTITLE_KEY);
    expect(r2.puts[0].body).toBe(NORMALIZED_VTT);
    expect(r2.puts[0].contentType).toBe('text/vtt; charset=utf-8');

    const row = await db.videoSubtitle.findFirstOrThrow({
      where: { versionId: scenario.version.id },
    });
    expect(row.billedUserId).toBe(scenario.owner.id);
    expect(row.uploadedByUserId).toBe(scenario.owner.id);
    expect(Number(row.sizeBytes)).toBe(Buffer.byteLength(NORMALIZED_VTT));
  });

  it('leaves no upload reservation behind once the row is committed', async () => {
    const scenario = await seedVersion({ providerId: 'bunny' });
    signedInAs(scenario.owner);

    await callRoute(
      uploadSubtitle,
      uploadRequest(
        scenario.video.id,
        subtitleForm({ versionId: scenario.version.id, language: 'tr' })
      ),
      { videoId: scenario.video.id }
    );

    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('replaces the track for a language instead of stacking a second one', async () => {
    const scenario = await seedSubtitledVersion();
    const firstKey = r2.puts[0].key;

    const response = await callRoute(
      uploadSubtitle,
      uploadRequest(
        scenario.video.id,
        subtitleForm({
          versionId: scenario.version.id,
          language: 'tr',
          label: 'Türkçe düzeltme',
          content: ['1', '00:00:04,000 --> 00:00:05,000', 'Düzeltildi', '', ''].join('\n'),
        })
      ),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(201);
    const rows = await db.videoSubtitle.findMany({ where: { versionId: scenario.version.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Türkçe düzeltme');
    // The object the replaced row pointed at is gone, so it cannot outlive its row.
    expect(r2.deletedKeys).toEqual([firstKey]);
  });

  it('keeps a second language alongside the first', async () => {
    const scenario = await seedSubtitledVersion();

    await callRoute(
      uploadSubtitle,
      uploadRequest(
        scenario.video.id,
        subtitleForm({ versionId: scenario.version.id, language: 'en', fileName: 'cut.en.srt' })
      ),
      { videoId: scenario.video.id }
    );

    const rows = await db.videoSubtitle.findMany({
      where: { versionId: scenario.version.id },
      orderBy: { language: 'asc' },
    });
    expect(rows.map((row) => row.language)).toEqual(['en', 'tr']);
  });

  it('refuses a file with no cues and stores nothing', async () => {
    const scenario = await seedVersion({ providerId: 'bunny' });
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadSubtitle,
      uploadRequest(
        scenario.video.id,
        subtitleForm({
          versionId: scenario.version.id,
          language: 'tr',
          content: 'just some prose\nand more of it\n',
        })
      ),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(400);
    expect(r2.puts).toHaveLength(0);
    expect(await db.videoSubtitle.count()).toBe(0);
  });

  it('refuses a file that is not a subtitle by extension', async () => {
    const scenario = await seedVersion({ providerId: 'bunny' });
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadSubtitle,
      uploadRequest(
        scenario.video.id,
        subtitleForm({ versionId: scenario.version.id, language: 'tr', fileName: 'payload.html' })
      ),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('Subtitle must be a .srt or .vtt file');
  });

  it('refuses a language that is not a tag', async () => {
    const scenario = await seedVersion({ providerId: 'bunny' });
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadSubtitle,
      uploadRequest(
        scenario.video.id,
        subtitleForm({ versionId: scenario.version.id, language: '<script>' })
      ),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(400);
  });

  it('refuses a version that belongs to another video', async () => {
    const scenario = await seedVersion({ providerId: 'bunny' });
    const other = await seedVersion({ providerId: 'bunny', ownerUser: scenario.owner });
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadSubtitle,
      uploadRequest(
        scenario.video.id,
        subtitleForm({ versionId: other.version.id, language: 'tr' })
      ),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(404);
    expect(r2.puts).toHaveLength(0);
  });

  it('refuses a project COMMENTATOR, who may comment but not edit the cut', async () => {
    const scenario = await seedVersion({ providerId: 'bunny' });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      uploadSubtitle,
      uploadRequest(
        scenario.video.id,
        subtitleForm({ versionId: scenario.version.id, language: 'tr' })
      ),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
    expect(r2.puts).toHaveLength(0);
  });

  it('refuses an anonymous caller', async () => {
    const scenario = await seedVersion({ providerId: 'bunny' });
    signedOut();

    const response = await callRoute(
      uploadSubtitle,
      uploadRequest(
        scenario.video.id,
        subtitleForm({ versionId: scenario.version.id, language: 'tr' })
      ),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/videos/[videoId]/subtitles
// ---------------------------------------------------------------------------
describe('GET /api/videos/[videoId]/subtitles', () => {
  it('lists the tracks of one version and tells an editor they may manage them', async () => {
    const scenario = await seedSubtitledVersion();

    const response = await callRoute(
      listSubtitles,
      apiRequest(subtitlesUrl(scenario.video.id), {
        searchParams: { versionId: scenario.version.id },
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(200);
    const data = await readData<{
      subtitles: Array<{ language: string; canDelete: boolean }>;
      canManageSubtitles: boolean;
    }>(response);
    expect(data.subtitles.map((subtitle) => subtitle.language)).toEqual(['tr']);
    expect(data.canManageSubtitles).toBe(true);
    expect(data.subtitles[0].canDelete).toBe(true);
  });

  it('shows a COMMENTATOR the tracks without the ability to manage them', async () => {
    const scenario = await seedSubtitledVersion();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(listSubtitles, apiRequest(subtitlesUrl(scenario.video.id)), {
      videoId: scenario.video.id,
    });

    expect(response.status).toBe(200);
    const data = await readData<{
      subtitles: Array<{ canDelete: boolean }>;
      canManageSubtitles: boolean;
    }>(response);
    expect(data.subtitles).toHaveLength(1);
    expect(data.canManageSubtitles).toBe(false);
    expect(data.subtitles[0].canDelete).toBe(false);
  });

  it('refuses a signed-in stranger', async () => {
    const scenario = await seedSubtitledVersion();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(listSubtitles, apiRequest(subtitlesUrl(scenario.video.id)), {
      videoId: scenario.video.id,
    });

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/videos/[videoId]/subtitles/[subtitleId]
// ---------------------------------------------------------------------------
describe('DELETE /api/videos/[videoId]/subtitles/[subtitleId]', () => {
  it('removes the row and the stored object', async () => {
    const scenario = await seedSubtitledVersion();
    const storedKey = r2.puts[0].key;

    const response = await callRoute(
      deleteSubtitle,
      apiRequest(`${subtitlesUrl(scenario.video.id)}/${scenario.subtitle.id}`, {
        method: 'DELETE',
      }),
      { videoId: scenario.video.id, subtitleId: scenario.subtitle.id }
    );

    expect(response.status).toBe(200);
    expect(await db.videoSubtitle.count()).toBe(0);
    expect(r2.deletedKeys).toEqual([storedKey]);
  });

  it('refuses a COMMENTATOR and leaves the track in place', async () => {
    const scenario = await seedSubtitledVersion();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      deleteSubtitle,
      apiRequest(`${subtitlesUrl(scenario.video.id)}/${scenario.subtitle.id}`, {
        method: 'DELETE',
      }),
      { videoId: scenario.video.id, subtitleId: scenario.subtitle.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoSubtitle.count()).toBe(1);
    expect(r2.deletedKeys).toHaveLength(0);
  });

  it('answers 404 for a subtitle that belongs to another video', async () => {
    const scenario = await seedSubtitledVersion();
    const other = await seedVersion({ providerId: 'bunny', ownerUser: scenario.owner });
    signedInAs(scenario.owner);

    const response = await callRoute(
      deleteSubtitle,
      apiRequest(`${subtitlesUrl(other.video.id)}/${scenario.subtitle.id}`, { method: 'DELETE' }),
      { videoId: other.video.id, subtitleId: scenario.subtitle.id }
    );

    expect(response.status).toBe(404);
    expect(await db.videoSubtitle.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/upload/subtitle/[filename]
// ---------------------------------------------------------------------------
describe('GET /api/upload/subtitle/[filename]', () => {
  function fileNameOf(url: string): string {
    return url.slice('/api/upload/subtitle/'.length);
  }

  it('serves the stored WebVTT to a viewer', async () => {
    const scenario = await seedSubtitledVersion();
    const filename = fileNameOf(scenario.subtitle.url);

    const response = await callRoute(serveSubtitle, apiRequest(scenario.subtitle.url), {
      filename,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe(NORMALIZED_VTT);
  });

  it('refuses a signed-in stranger without reading the object', async () => {
    const scenario = await seedSubtitledVersion();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(serveSubtitle, apiRequest(scenario.subtitle.url), {
      filename: fileNameOf(scenario.subtitle.url),
    });

    expect(response.status).toBe(403);
    expect(r2.gets).toHaveLength(0);
  });

  it('rejects a filename that is not a stored subtitle', async () => {
    const response = await callRoute(serveSubtitle, apiRequest('/api/upload/subtitle/x'), {
      filename: '../../etc/passwd',
    });

    expect(response.status).toBe(400);
  });
});
