import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { ProjectMemberRole, TranscriptStatus } from '@prisma/client';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import { scheduleVersionTranscription } from '@/lib/transcription/schedule';
import {
  GET as getTranscript,
  POST as enqueueTranscript,
} from '@/app/api/versions/[versionId]/transcript/route';
import { POST as uploadTranscript } from '@/app/api/versions/[versionId]/transcript/upload/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createShareLink,
  createUser,
  createVersion,
  createVideo,
  seedVersion,
} from '../factories';

const r2 = vi.hoisted(() => ({
  bucket: 'openframe-transcript-test-bucket',
  puts: [] as Array<{ key: string; body: string; contentType: string }>,
  deletedKeys: [] as string[],
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
          default:
            return {};
        }
      },
    },
  };
});

beforeEach(() => {
  r2.puts.length = 0;
  r2.deletedKeys.length = 0;
});

const SRT_FILE = ['1', '00:00:01,000 --> 00:00:03,000', 'Hello world', '', ''].join('\n');
const TXT_FILE = 'INT. KITCHEN\n\nHello there.\n';

function transcriptUrl(versionId: string): string {
  return `/api/versions/${versionId}/transcript`;
}

function uploadUrl(versionId: string): string {
  return `/api/versions/${versionId}/transcript/upload`;
}

function uploadForm(input: { content?: string; fileName?: string; language?: string }): FormData {
  const form = new FormData();
  form.append(
    'transcript',
    new File([input.content ?? SRT_FILE], input.fileName ?? 'cut.srt', { type: 'text/plain' })
  );
  if (input.language !== undefined) form.append('language', input.language);
  return form;
}

function uploadRequest(versionId: string, form: FormData) {
  return apiRequest(uploadUrl(versionId), {
    rawBody: form,
    headers: { 'content-length': '4096' },
  });
}

async function seedReadyTranscript(versionId: string) {
  return db.transcript.create({
    data: {
      versionId,
      language: 'en',
      provider: 'whisper-local',
      status: TranscriptStatus.READY,
      searchText: 'Hello',
      segments: {
        create: {
          startSec: 1,
          endSec: 2,
          text: 'Hello',
          words: [],
          position: 0,
        },
      },
    },
  });
}

describe('GET /api/versions/[versionId]/transcript', () => {
  it('returns 404 for an unknown version', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(getTranscript, apiRequest(transcriptUrl('nope')), {
      versionId: 'nope',
    });

    expect(response.status).toBe(404);
  });

  it('returns 403 to an anonymous caller with no share session', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await seedReadyTranscript(scenario.version.id);
    signedOut();

    const response = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(scenario.version.id)),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    const row = await db.transcript.findFirst({ where: { versionId: scenario.version.id } });
    expect(row?.searchText).toBe('Hello');
  });

  it('returns the transcript to a project member', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await seedReadyTranscript(scenario.version.id);
    const member = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: member.id });
    signedInAs(member);

    const response = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(scenario.version.id)),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
    const body = await readData<{
      transcript: { provider: string; segments: Array<{ text: string; startSec: number }> };
    }>(response);
    expect(body.transcript.provider).toBe('whisper-local');
    expect(body.transcript.segments).toEqual([
      expect.objectContaining({ text: 'Hello', startSec: 1 }),
    ]);
    expect(body.transcript).toEqual(expect.objectContaining({ error: null, status: 'READY' }));
  });

  it('returns the stored error for a FAILED transcript', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await db.transcript.create({
      data: {
        versionId: scenario.version.id,
        language: 'en',
        provider: 'whisper-local',
        status: TranscriptStatus.FAILED,
        error: 'whisper failed',
        searchText: '',
      },
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(scenario.version.id)),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
    const body = await readData<{
      transcript: { status: string; error: string | null; segments: unknown[] };
    }>(response);
    expect(body.transcript.status).toBe('FAILED');
    expect(body.transcript.error).toBe('whisper failed');
    expect(body.transcript.segments).toEqual([]);
  });

  it('returns null when the version has no transcript', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);

    const response = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(scenario.version.id)),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
    const body = await readData<{ transcript: null }>(response);
    expect(body.transcript).toBeNull();
  });

  it('filters segments by q without changing the stored rows', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await db.transcript.create({
      data: {
        versionId: scenario.version.id,
        language: 'en',
        provider: 'whisper-local',
        status: TranscriptStatus.READY,
        searchText: 'Hello goodbye',
        segments: {
          create: [
            { startSec: 1, endSec: 2, text: 'Hello', words: [], position: 0 },
            { startSec: 3, endSec: 4, text: 'Goodbye', words: [], position: 1 },
          ],
        },
      },
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(scenario.version.id), { searchParams: { q: 'hello' } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
    const body = await readData<{ transcript: { segments: Array<{ text: string }> } }>(response);
    expect(body.transcript.segments.map((segment) => segment.text)).toEqual(['Hello']);
    expect(
      await db.transcriptSegment.count({
        where: { transcript: { versionId: scenario.version.id } },
      })
    ).toBe(2);
  });

  it('returns 403 to a signed-in stranger and leaves the row', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await seedReadyTranscript(scenario.version.id);
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(scenario.version.id)),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(1);
  });

  it('lets a guest with a VIEW share session read the transcript', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await seedReadyTranscript(scenario.version.id);
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: scenario.video.id,
      permission: 'VIEW',
    });
    signedOut();

    const response = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(scenario.version.id), {
        cookies: {
          [getShareSessionCookieName(scenario.video.id)]: createShareSessionValue(
            link.token,
            scenario.video.id,
            false
          ),
        },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
    const body = await readData<{ transcript: { segments: Array<{ text: string }> } }>(response);
    expect(body.transcript.segments[0]?.text).toBe('Hello');
  });

  it('refuses a share session for a different video in the same project', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await seedReadyTranscript(scenario.version.id);
    const otherVideo = await createVideo({
      projectId: scenario.project.id,
    });
    const otherVersion = await createVersion({ videoParentId: otherVideo.id });
    await seedReadyTranscript(otherVersion.id);
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: otherVideo.id,
      permission: 'VIEW',
    });
    signedOut();

    const refused = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(scenario.version.id), {
        cookies: {
          [getShareSessionCookieName(scenario.video.id)]: createShareSessionValue(
            link.token,
            otherVideo.id,
            false
          ),
        },
      }),
      { versionId: scenario.version.id }
    );
    expect(refused.status).toBe(403);

    const allowed = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(otherVersion.id), {
        cookies: {
          [getShareSessionCookieName(otherVideo.id)]: createShareSessionValue(
            link.token,
            otherVideo.id,
            false
          ),
        },
      }),
      { versionId: otherVersion.id }
    );
    expect(allowed.status).toBe(200);
  });
});

describe('POST /api/versions/[versionId]/transcript', () => {
  it('returns 401 to an anonymous caller', async () => {
    const scenario = await seedVersion({ providerId: 'r2' });
    signedOut();

    const response = await callRoute(
      enqueueTranscript,
      apiRequest(transcriptUrl(scenario.version.id), { body: { language: 'en' } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(401);
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(0);
    expect(await db.mediaJob.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('returns 403 to a signed-in commentator', async () => {
    const scenario = await seedVersion({ providerId: 'r2' });
    const member = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: member.id,
      role: ProjectMemberRole.COMMENTATOR,
    });
    signedInAs(member);

    const response = await callRoute(
      enqueueTranscript,
      apiRequest(transcriptUrl(scenario.version.id), { body: { language: 'en' } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(0);
    expect(await db.mediaJob.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('enqueues a PENDING transcript for the project owner of an r2 version', async () => {
    const scenario = await seedVersion({ providerId: 'r2' });
    signedInAs(scenario.owner);

    const response = await callRoute(
      enqueueTranscript,
      apiRequest(transcriptUrl(scenario.version.id), { body: { language: 'en' } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(202);
    const row = await db.transcript.findFirstOrThrow({
      where: { versionId: scenario.version.id, language: 'en' },
    });
    expect(row.status).toBe(TranscriptStatus.PENDING);
    expect(row.provider).toBe('whisper-local');
    const jobs = await db.mediaJob.findMany({
      where: { versionId: scenario.version.id },
      select: { kind: true, payload: true },
    });
    expect(jobs.map((job) => job.kind).sort()).toEqual(['EXTRACT_AUDIO', 'TRANSCRIBE']);
    const transcribe = jobs.find((job) => job.kind === 'TRANSCRIBE');
    expect(transcribe?.payload).toEqual({ language: 'en', transcriptId: row.id });
    expect(scheduleVersionTranscription).toHaveBeenCalledTimes(1);
    expect(scheduleVersionTranscription).toHaveBeenCalledWith(scenario.version.id, 'en');
  });

  it('re-enqueues an existing READY transcript as PENDING', async () => {
    const scenario = await seedVersion({ providerId: 'r2' });
    const existing = await seedReadyTranscript(scenario.version.id);
    await db.transcript.update({
      where: { id: existing.id },
      data: { error: 'whisper failed' },
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      enqueueTranscript,
      apiRequest(transcriptUrl(scenario.version.id), { body: { language: 'en' } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(202);
    const rows = await db.transcript.findMany({ where: { versionId: scenario.version.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(existing.id);
    expect(rows[0]?.status).toBe(TranscriptStatus.PENDING);
    expect(rows[0]?.error).toBeNull();
    const jobs = await db.mediaJob.findMany({
      where: { versionId: scenario.version.id },
      select: { kind: true, payload: true },
    });
    expect(jobs.map((job) => job.kind).sort()).toEqual(['EXTRACT_AUDIO', 'TRANSCRIBE']);
    const transcribe = jobs.find((job) => job.kind === 'TRANSCRIBE');
    expect(transcribe?.payload).toEqual({ language: 'en', transcriptId: existing.id });
    expect(scheduleVersionTranscription).toHaveBeenCalledTimes(1);
    expect(scheduleVersionTranscription).toHaveBeenCalledWith(scenario.version.id, 'en');
  });

  it('imports YouTube captions immediately and does not enqueue a worker job', async () => {
    const scenario = await seedVersion({
      providerId: 'youtube',
    });
    await db.videoVersion.update({
      where: { id: scenario.version.id },
      data: { videoId: 'QMRh3oE5BaU' },
    });
    signedInAs(scenario.owner);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/youtubei/v1/player')) {
        return new Response(
          JSON.stringify({
            playabilityStatus: { status: 'OK' },
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  {
                    languageCode: 'en',
                    kind: 'asr',
                    baseUrl: 'https://www.youtube.com/api/timedtext?v=QMRh3oE5BaU&fmt=srv3',
                  },
                ],
              },
            },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          events: [
            {
              tStartMs: 160,
              dDurationMs: 2000,
              segs: [{ utf8: 'Hello' }, { utf8: ' world', tOffsetMs: 400 }],
            },
          ],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const response = await callRoute(
        enqueueTranscript,
        apiRequest(transcriptUrl(scenario.version.id), { body: { language: 'en' } }),
        { versionId: scenario.version.id }
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalled();
      const row = await db.transcript.findFirstOrThrow({
        where: { versionId: scenario.version.id },
        include: { segments: { orderBy: { position: 'asc' } } },
      });
      expect(row.status).toBe(TranscriptStatus.READY);
      expect(row.provider).toBe('youtube');
      expect(row.segments.map((segment) => segment.text)).toEqual(['Hello world']);
      expect(await db.mediaJob.count({ where: { versionId: scenario.version.id } })).toBe(0);
      expect(scheduleVersionTranscription).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('marks a YouTube transcript FAILED when captions are missing', async () => {
    const scenario = await seedVersion({ providerId: 'youtube' });
    await db.videoVersion.update({
      where: { id: scenario.version.id },
      data: { videoId: 'QMRh3oE5BaU' },
    });
    signedInAs(scenario.owner);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            playabilityStatus: { status: 'OK' },
            captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
          }),
          { status: 200 }
        );
      })
    );

    try {
      const response = await callRoute(
        enqueueTranscript,
        apiRequest(transcriptUrl(scenario.version.id), { body: { language: 'en' } }),
        { versionId: scenario.version.id }
      );

      expect(response.status).toBe(400);
      expect(await readError(response)).toBe('This YouTube video has no captions to import');
      const row = await db.transcript.findFirstOrThrow({
        where: { versionId: scenario.version.id },
      });
      expect(row.status).toBe(TranscriptStatus.FAILED);
      expect(row.error).toBe('This YouTube video has no captions to import');
      expect(await db.mediaJob.count({ where: { versionId: scenario.version.id } })).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('POST /api/versions/[versionId]/transcript/upload', () => {
  it('returns 401 to an anonymous caller and writes nothing', async () => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      uploadTranscript,
      uploadRequest(scenario.version.id, uploadForm({})),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(401);
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('returns 403 to a signed-in commentator and writes nothing', async () => {
    const scenario = await seedVersion();
    const member = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: member.id,
      role: ProjectMemberRole.COMMENTATOR,
    });
    signedInAs(member);

    const response = await callRoute(
      uploadTranscript,
      uploadRequest(scenario.version.id, uploadForm({})),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('stores timed SRT segments and a caption track', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadTranscript,
      uploadRequest(scenario.version.id, uploadForm({ language: 'EN' })),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const body = await readData<{
      transcript: { provider: string; language: string; status: string };
    }>(response);
    expect(body.transcript).toMatchObject({
      provider: 'upload',
      language: 'en',
      status: 'READY',
    });

    const row = await db.transcript.findFirstOrThrow({
      where: { versionId: scenario.version.id, language: 'en' },
      include: { segments: { orderBy: { position: 'asc' } } },
    });
    expect(row.provider).toBe('upload');
    expect(row.status).toBe(TranscriptStatus.READY);
    expect(row.searchText).toBe('Hello world');
    expect(row.segments).toHaveLength(1);
    expect(row.segments[0]?.startSec).toBe(1);
    expect(row.segments[0]?.endSec).toBe(3);
    expect(row.segments[0]?.text).toBe('Hello world');
    expect(row.segments[0]?.words).toEqual([
      { text: 'Hello', start: 1, end: 2 },
      { text: 'world', start: 2, end: 3 },
    ]);

    const subtitle = await db.videoSubtitle.findFirstOrThrow({
      where: { versionId: scenario.version.id, language: 'en' },
    });
    expect(subtitle.label).toBe('Transcript (en)');
    expect(subtitle.billedUserId).toBe(scenario.workspace.ownerId);
    expect(subtitle.uploadedByUserId).toBe(scenario.owner.id);
    expect(subtitle.sourceUrl).toMatch(/^\/api\/upload\/subtitle\/[0-9a-f-]{36}\.vtt$/);
    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0]?.contentType).toBe('text/vtt; charset=utf-8');
    expect(r2.puts[0]?.body).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n');
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('stores a text script without creating a caption track', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadTranscript,
      uploadRequest(
        scenario.version.id,
        uploadForm({ content: TXT_FILE, fileName: 'script.txt', language: 'en' })
      ),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const row = await db.transcript.findFirstOrThrow({
      where: { versionId: scenario.version.id },
      include: { segments: { orderBy: { position: 'asc' } } },
    });
    expect(row.segments.map((segment) => segment.text)).toEqual(['INT. KITCHEN', 'Hello there.']);
    expect(row.segments[0]?.startSec).toBe(0);
    expect(row.segments[0]?.endSec).toBe(0);
    expect(await db.videoSubtitle.count({ where: { versionId: scenario.version.id } })).toBe(0);
    expect(r2.puts).toHaveLength(0);
  });

  it('replaces an existing transcript for the same language', async () => {
    const scenario = await seedVersion();
    const existing = await seedReadyTranscript(scenario.version.id);
    await db.transcript.update({
      where: { id: existing.id },
      data: { status: TranscriptStatus.PENDING, error: 'whisper failed' },
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadTranscript,
      uploadRequest(scenario.version.id, uploadForm({ content: TXT_FILE, fileName: 'script.txt' })),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const rows = await db.transcript.findMany({
      where: { versionId: scenario.version.id },
      include: { segments: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(existing.id);
    expect(rows[0]?.provider).toBe('upload');
    expect(rows[0]?.status).toBe(TranscriptStatus.READY);
    expect(rows[0]?.error).toBeNull();
    expect(rows[0]?.segments).toHaveLength(2);
    expect(rows[0]?.searchText).toBe('INT. KITCHEN Hello there.');
  });

  it('replaces the caption object when a second SRT is uploaded', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const first = await callRoute(
      uploadTranscript,
      uploadRequest(scenario.version.id, uploadForm({})),
      { versionId: scenario.version.id }
    );
    expect(first.status).toBe(201);
    const firstKey = r2.puts[0]?.key;
    expect(firstKey).toBeTruthy();

    const second = await callRoute(
      uploadTranscript,
      uploadRequest(
        scenario.version.id,
        uploadForm({
          content: ['1', '00:00:04,000 --> 00:00:05,000', 'Replaced', '', ''].join('\n'),
        })
      ),
      { versionId: scenario.version.id }
    );
    expect(second.status).toBe(201);
    expect(await db.videoSubtitle.count({ where: { versionId: scenario.version.id } })).toBe(1);
    expect(r2.deletedKeys).toEqual([firstKey]);
  });

  it('keeps a second language alongside the first', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    await callRoute(
      uploadTranscript,
      uploadRequest(scenario.version.id, uploadForm({ language: 'en' })),
      { versionId: scenario.version.id }
    );
    const response = await callRoute(
      uploadTranscript,
      uploadRequest(scenario.version.id, uploadForm({ language: 'tr', fileName: 'cut.tr.srt' })),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const rows = await db.transcript.findMany({
      where: { versionId: scenario.version.id },
      orderBy: { language: 'asc' },
    });
    expect(rows.map((row) => row.language)).toEqual(['en', 'tr']);
  });

  it('rejects an invalid language and writes nothing', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadTranscript,
      uploadRequest(scenario.version.id, uploadForm({ language: 'nope' })),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('language must be a BCP-47 tag');
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('rejects a file it cannot parse and writes nothing', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadTranscript,
      uploadRequest(
        scenario.version.id,
        uploadForm({ content: 'not a subtitle', fileName: 'cut.srt' })
      ),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('No subtitle cues found');
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });
});
