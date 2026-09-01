import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  GET as getTranscript,
  PUT as uploadTranscript,
} from '@/app/api/versions/[versionId]/transcript/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { addProjectMember, createReadyTranscript, createUser, seedVersion } from '../factories';

const SRT_FILE = ['1', '00:00:01,000 --> 00:00:02,500', 'Hello there', '', ''].join('\n');

function transcriptUrl(versionId: string) {
  return `/api/versions/${versionId}/transcript`;
}

function uploadForm(content = SRT_FILE, fileName = 'cut.en.srt', language = 'en') {
  const form = new FormData();
  form.append('file', new File([content], fileName, { type: 'text/plain' }));
  form.append('language', language);
  return form;
}

describe('GET /api/versions/[versionId]/transcript', () => {
  it('returns 401 to an anonymous caller', async () => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(scenario.version.id)),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(401);
  });

  it('returns 404 to a signed-in stranger', async () => {
    const scenario = await seedVersion();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(scenario.version.id)),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(404);
  });

  it('returns the ready transcript for the owner', async () => {
    const scenario = await seedVersion();
    await createReadyTranscript({
      versionId: scenario.version.id,
      segments: [{ startSec: 1, endSec: 2, text: 'Hello there' }],
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(scenario.version.id)),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
    const data = await readData<{
      transcript: { status: string; segments: Array<{ text: string }> } | null;
    }>(response);
    expect(data.transcript?.status).toBe('READY');
    expect(data.transcript?.segments.map((segment) => segment.text)).toEqual(['Hello there']);
  });

  it('returns the transcript to a COMMENTATOR who cannot edit the cut', async () => {
    const scenario = await seedVersion();
    await createReadyTranscript({
      versionId: scenario.version.id,
      segments: [{ startSec: 1, endSec: 2, text: 'Hello there' }],
    });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      getTranscript,
      apiRequest(transcriptUrl(scenario.version.id)),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
    const data = await readData<{ transcript: { segments: Array<{ text: string }> } | null }>(
      response
    );
    expect(data.transcript?.segments.map((segment) => segment.text)).toEqual(['Hello there']);
  });
});

describe('PUT /api/versions/[versionId]/transcript', () => {
  it('returns 401 to an anonymous caller and writes no row', async () => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      uploadTranscript,
      apiRequest(transcriptUrl(scenario.version.id), {
        method: 'PUT',
        rawBody: uploadForm(),
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(401);
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('returns 404 to a signed-in stranger and writes no row', async () => {
    const scenario = await seedVersion();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      uploadTranscript,
      apiRequest(transcriptUrl(scenario.version.id), {
        method: 'PUT',
        rawBody: uploadForm(),
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(404);
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('returns 403 to a COMMENTATOR and writes no row', async () => {
    const scenario = await seedVersion();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      uploadTranscript,
      apiRequest(transcriptUrl(scenario.version.id), {
        method: 'PUT',
        rawBody: uploadForm(),
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('stores an uploaded SRT for a project ADMIN who is not the owner', async () => {
    const scenario = await seedVersion();
    const admin = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: admin.id,
      role: 'ADMIN',
    });
    signedInAs(admin);

    const response = await callRoute(
      uploadTranscript,
      apiRequest(transcriptUrl(scenario.version.id), {
        method: 'PUT',
        rawBody: uploadForm(),
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(1);
  });

  it('stores timed segments from an uploaded SRT', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadTranscript,
      apiRequest(transcriptUrl(scenario.version.id), {
        method: 'PUT',
        rawBody: uploadForm(),
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
    const data = await readData<{
      transcript: {
        provider: string;
        status: string;
        segments: Array<{
          startSec: number;
          endSec: number;
          text: string;
          words: Array<{ text: string; start: number; end: number }>;
        }>;
      };
    }>(response);
    expect(data.transcript.provider).toBe('upload');
    expect(data.transcript.status).toBe('READY');
    expect(data.transcript.segments).toHaveLength(1);
    expect(data.transcript.segments[0]?.startSec).toBe(1);
    expect(data.transcript.segments[0]?.endSec).toBe(2.5);
    expect(data.transcript.segments[0]?.text).toBe('Hello there');
    expect(data.transcript.segments[0]?.words).toEqual([
      { text: 'Hello', start: 1, end: 1.75 },
      { text: 'there', start: 1.75, end: 2.5 },
    ]);

    const row = await db.transcript.findFirst({
      where: { versionId: scenario.version.id },
      include: { segments: true },
    });
    expect(row?.provider).toBe('upload');
    expect(row?.searchText).toBe('Hello there');
    expect(row?.segments).toHaveLength(1);
    expect(row?.segments[0]?.text).toBe('Hello there');
    expect(row?.segments[0]?.words).toEqual([
      { text: 'Hello', start: 1, end: 1.75 },
      { text: 'there', start: 1.75, end: 2.5 },
    ]);
  });

  it('replaces a previous transcript for the same language and leaves another language', async () => {
    const scenario = await seedVersion();
    await createReadyTranscript({
      versionId: scenario.version.id,
      language: 'en',
      segments: [{ startSec: 0, endSec: 1, text: 'Old line' }],
    });
    await createReadyTranscript({
      versionId: scenario.version.id,
      language: 'tr',
      segments: [{ startSec: 0, endSec: 1, text: 'Keep me' }],
    });
    signedInAs(scenario.owner);

    const replacement = ['1', '00:00:03,000 --> 00:00:04,000', 'New line', '', ''].join('\n');
    const response = await callRoute(
      uploadTranscript,
      apiRequest(transcriptUrl(scenario.version.id), {
        method: 'PUT',
        rawBody: uploadForm(replacement, 'cut.en.srt', 'en'),
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(2);
    const english = await db.transcript.findFirst({
      where: { versionId: scenario.version.id, language: 'en' },
      include: { segments: true },
    });
    const turkish = await db.transcript.findFirst({
      where: { versionId: scenario.version.id, language: 'tr' },
      include: { segments: true },
    });
    expect(english?.segments.map((segment) => segment.text)).toEqual(['New line']);
    expect(turkish?.segments.map((segment) => segment.text)).toEqual(['Keep me']);
  });

  it('rejects a file that is not SRT or VTT', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadTranscript,
      apiRequest(transcriptUrl(scenario.version.id), {
        method: 'PUT',
        rawBody: uploadForm('not a subtitle', 'notes.txt'),
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe('Transcript must be a .srt or .vtt file');
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('rejects an SRT with no timed lines and writes no row', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      uploadTranscript,
      apiRequest(transcriptUrl(scenario.version.id), {
        method: 'PUT',
        rawBody: uploadForm('this is not timed', 'cut.en.srt'),
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toBe(
      'No timed lines found. Upload a valid .srt or .vtt file.'
    );
    expect(await db.transcript.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });
});
