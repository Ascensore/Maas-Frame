import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { ProjectMemberRole, TranscriptStatus } from '@prisma/client';
import { PATCH as patchSegment } from '@/app/api/versions/[versionId]/transcript/segments/[segmentId]/route';
import { POST as buildCaptions } from '@/app/api/versions/[versionId]/transcript/captions/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createReadyTranscript,
  createUser,
  createVersion,
  createVideo,
  seedVersion,
} from '../factories';

// The same R2 recorder tests/api/transcript.test.ts uses: the caption rebuild
// puts a real object, and asserting on it is what separates "the row moved" from
// "the subtitles the player fetches actually changed".
const r2 = vi.hoisted(() => ({
  bucket: 'openframe-transcript-edit-test-bucket',
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

const MISHEARD_WORDS = [
  { start: 1, end: 1.4, text: 'we' },
  { start: 1.5, end: 1.9, text: 'held' },
  { start: 2, end: 2.6, text: 'founders' },
];

function segmentUrl(versionId: string, segmentId: string): string {
  return `/api/versions/${versionId}/transcript/segments/${segmentId}`;
}

function captionsUrl(versionId: string): string {
  return `/api/versions/${versionId}/transcript/captions`;
}

function patchRequest(versionId: string, segmentId: string, body: unknown) {
  return apiRequest(segmentUrl(versionId, segmentId), { method: 'PATCH', body });
}

/**
 * Two lines, not one: the route rebuilds `searchText` and the whole caption file
 * from every segment in position order, and a single-line transcript cannot tell
 * a correct join from a reversed one.
 */
async function seedMisheardLine(versionId: string, speaker?: string) {
  const transcript = await createReadyTranscript({
    versionId,
    segments: [
      { startSec: 1, endSec: 3, text: 'we held founders', words: MISHEARD_WORDS, speaker },
      {
        startSec: 4,
        endSec: 5,
        text: 'every week',
        words: [
          { start: 4, end: 4.5, text: 'every' },
          { start: 4.5, end: 5, text: 'week' },
        ],
      },
    ],
  });
  const segment = await db.transcriptSegment.findFirstOrThrow({
    where: { transcriptId: transcript.id, position: 0 },
  });
  return { transcript, segment };
}

describe('PATCH /api/versions/[versionId]/transcript/segments/[segmentId]', () => {
  it('returns 401 to an anonymous caller and leaves the line alone', async () => {
    const scenario = await seedVersion();
    const { segment } = await seedMisheardLine(scenario.version.id);
    signedOut();

    const response = await callRoute(
      patchSegment,
      patchRequest(scenario.version.id, segment.id, { text: 'we help founders' }),
      { versionId: scenario.version.id, segmentId: segment.id }
    );

    expect(response.status).toBe(401);
    const row = await db.transcriptSegment.findUniqueOrThrow({ where: { id: segment.id } });
    expect(row.text).toBe('we held founders');
    expect(await db.videoSubtitle.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('returns 403 to a commentator and leaves the line alone', async () => {
    const scenario = await seedVersion();
    const { segment } = await seedMisheardLine(scenario.version.id);
    const member = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: member.id,
      role: ProjectMemberRole.COMMENTATOR,
    });
    signedInAs(member);

    const response = await callRoute(
      patchSegment,
      patchRequest(scenario.version.id, segment.id, { text: 'we help founders' }),
      { versionId: scenario.version.id, segmentId: segment.id }
    );

    expect(response.status).toBe(403);
    const row = await db.transcriptSegment.findUniqueOrThrow({ where: { id: segment.id } });
    expect(row.text).toBe('we held founders');
    expect(await db.videoSubtitle.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('returns 404 for a segment that belongs to another version', async () => {
    const scenario = await seedVersion();
    const otherVideo = await createVideo({ projectId: scenario.project.id });
    const otherVersion = await createVersion({ videoParentId: otherVideo.id });
    const { segment } = await seedMisheardLine(otherVersion.id);
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchSegment,
      patchRequest(scenario.version.id, segment.id, { text: 'we help founders' }),
      { versionId: scenario.version.id, segmentId: segment.id }
    );

    expect(response.status).toBe(404);
    const row = await db.transcriptSegment.findUniqueOrThrow({ where: { id: segment.id } });
    expect(row.text).toBe('we held founders');
  });

  it('returns 400 for blank text and leaves the line alone', async () => {
    const scenario = await seedVersion();
    const { segment } = await seedMisheardLine(scenario.version.id);
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchSegment,
      patchRequest(scenario.version.id, segment.id, { text: '   ' }),
      { versionId: scenario.version.id, segmentId: segment.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('text');
    const row = await db.transcriptSegment.findUniqueOrThrow({ where: { id: segment.id } });
    expect(row.text).toBe('we held founders');
    expect(r2.puts).toHaveLength(0);
  });

  it('fixes the word in place and rebuilds the caption track', async () => {
    const scenario = await seedVersion();
    const { transcript, segment } = await seedMisheardLine(scenario.version.id);
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchSegment,
      patchRequest(scenario.version.id, segment.id, {
        text: 'we help founders',
        speaker: 'Tom',
      }),
      { versionId: scenario.version.id, segmentId: segment.id }
    );

    expect(response.status).toBe(200);
    const body = await readData<{
      segment: { id: string; text: string; speaker: string | null; words: unknown };
      captions: string;
    }>(response);
    expect(body.captions).toBe('updated');
    expect(body.segment.text).toBe('we help founders');

    const row = await db.transcriptSegment.findUniqueOrThrow({ where: { id: segment.id } });
    expect(row.text).toBe('we help founders');
    expect(row.speaker).toBe('Tom');
    // The count is unchanged, so every word keeps the timing it was heard at.
    expect(row.words).toEqual([
      { start: 1, end: 1.4, text: 'we' },
      { start: 1.5, end: 1.9, text: 'help' },
      { start: 2, end: 2.6, text: 'founders' },
    ]);

    const updatedTranscript = await db.transcript.findUniqueOrThrow({
      where: { id: transcript.id },
    });
    expect(updatedTranscript.searchText).toBe('we help founders every week');

    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0]?.key.startsWith('subtitles/')).toBe(true);
    expect(r2.puts[0]?.body).toBe(
      'WEBVTT\n\n' +
        '00:00:01.000 --> 00:00:03.000\nwe help founders\n\n' +
        '00:00:04.000 --> 00:00:05.000\nevery week\n'
    );

    const subtitle = await db.videoSubtitle.findFirstOrThrow({
      where: { versionId: scenario.version.id, language: 'en' },
    });
    expect(subtitle.sourceUrl).toBe(
      `/api/upload/subtitle/${r2.puts[0]?.key.slice('subtitles/'.length)}`
    );
    expect(subtitle.billedUserId).toBe(scenario.workspace.ownerId);
  });

  it('leaves the speaker alone when the patch does not name it', async () => {
    const scenario = await seedVersion();
    const { segment } = await seedMisheardLine(scenario.version.id, 'Ada');
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchSegment,
      patchRequest(scenario.version.id, segment.id, { text: 'we help founders' }),
      { versionId: scenario.version.id, segmentId: segment.id }
    );

    expect(response.status).toBe(200);
    const row = await db.transcriptSegment.findUniqueOrThrow({ where: { id: segment.id } });
    expect(row.text).toBe('we help founders');
    expect(row.speaker).toBe('Ada');
  });

  it('clears the speaker when the patch names it as null', async () => {
    const scenario = await seedVersion();
    const { segment } = await seedMisheardLine(scenario.version.id, 'Ada');
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchSegment,
      patchRequest(scenario.version.id, segment.id, {
        text: 'we help founders',
        speaker: null,
      }),
      { versionId: scenario.version.id, segmentId: segment.id }
    );

    expect(response.status).toBe(200);
    const row = await db.transcriptSegment.findUniqueOrThrow({ where: { id: segment.id } });
    expect(row.speaker).toBeNull();
  });
});

describe('POST /api/versions/[versionId]/transcript/captions', () => {
  it('returns 401 to an anonymous caller and builds nothing', async () => {
    const scenario = await seedVersion();
    await seedMisheardLine(scenario.version.id);
    signedOut();

    const response = await callRoute(
      buildCaptions,
      apiRequest(captionsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(401);
    expect(await db.videoSubtitle.count({ where: { versionId: scenario.version.id } })).toBe(0);
    expect(r2.puts).toHaveLength(0);
  });

  it('returns 403 to a commentator and builds nothing', async () => {
    const scenario = await seedVersion();
    await seedMisheardLine(scenario.version.id);
    const member = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: member.id,
      role: ProjectMemberRole.COMMENTATOR,
    });
    signedInAs(member);

    const response = await callRoute(
      buildCaptions,
      apiRequest(captionsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoSubtitle.count({ where: { versionId: scenario.version.id } })).toBe(0);
    expect(r2.puts).toHaveLength(0);
  });

  it('returns 400 when the version has no READY transcript', async () => {
    const scenario = await seedVersion();
    await createReadyTranscript({
      versionId: scenario.version.id,
      status: TranscriptStatus.PENDING,
      segments: [{ startSec: 1, endSec: 3, text: 'we held founders', words: MISHEARD_WORDS }],
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      buildCaptions,
      apiRequest(captionsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('This version has no transcript yet');
    expect(await db.videoSubtitle.count({ where: { versionId: scenario.version.id } })).toBe(0);
    expect(r2.puts).toHaveLength(0);
  });

  it('builds a caption track from the transcript without transcribing again', async () => {
    const scenario = await seedVersion();
    await seedMisheardLine(scenario.version.id);
    signedInAs(scenario.owner);

    const response = await callRoute(
      buildCaptions,
      apiRequest(captionsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const body = await readData<{ subtitle: { language: string; url: string } }>(response);
    expect(body.subtitle.language).toBe('en');
    expect(body.subtitle.url).toMatch(/^\/api\/upload\/subtitle\/[0-9a-f-]{36}\.vtt$/);

    const subtitle = await db.videoSubtitle.findFirstOrThrow({
      where: { versionId: scenario.version.id, language: 'en' },
    });
    expect(subtitle.sourceUrl).toBe(body.subtitle.url);
    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0]?.body).toBe(
      'WEBVTT\n\n' +
        '00:00:01.000 --> 00:00:03.000\nwe held founders\n\n' +
        '00:00:04.000 --> 00:00:05.000\nevery week\n'
    );

    // The whole point of the route: the audio is never sent off to be
    // transcribed a second time.
    expect(
      await db.mediaJob.count({ where: { versionId: scenario.version.id, kind: 'TRANSCRIBE' } })
    ).toBe(0);
  });

  it('returns 400 when the transcript has no timed line', async () => {
    const scenario = await seedVersion();
    await createReadyTranscript({
      versionId: scenario.version.id,
      segments: [{ startSec: 0, endSec: 0, text: 'INT. KITCHEN', words: [] }],
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      buildCaptions,
      apiRequest(captionsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('The transcript has no timed lines to caption');
    expect(await db.videoSubtitle.count({ where: { versionId: scenario.version.id } })).toBe(0);
    expect(r2.puts).toHaveLength(0);
  });
});
