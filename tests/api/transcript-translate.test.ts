import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { ProjectMemberRole, TranscriptStatus } from '@prisma/client';
import { POST as translateTranscript } from '@/app/api/versions/[versionId]/transcript/translate/route';
import { GET as getTranscript } from '@/app/api/versions/[versionId]/transcript/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { addProjectMember, createUser, seedVersion } from '../factories';

const translateTexts = vi.hoisted(() =>
  vi.fn(async (input: { texts: string[] }) => input.texts.map((text) => `EN:${text}`))
);

vi.mock('@/lib/transcription/translate', () => ({
  translateTranscriptTexts: translateTexts,
}));

async function seedItalianTranscript(versionId: string) {
  return db.transcript.create({
    data: {
      versionId,
      language: 'it',
      provider: 'openai',
      status: TranscriptStatus.READY,
      searchText: 'Ciao a tutti',
      segments: {
        create: {
          startSec: 0,
          endSec: 1.5,
          text: 'Ciao a tutti',
          words: [{ text: 'Ciao', start: 0, end: 0.5 }],
          position: 0,
        },
      },
    },
  });
}

describe('POST /api/versions/[versionId]/transcript/translate', () => {
  beforeEach(() => {
    translateTexts.mockClear();
  });

  it('returns 401 to an anonymous caller', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await seedItalianTranscript(scenario.version.id);
    signedOut();

    const response = await callRoute(
      translateTranscript,
      apiRequest(`/api/versions/${scenario.version.id}/transcript/translate`, {
        body: { language: 'en' },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(401);
    expect(translateTexts).not.toHaveBeenCalled();
    const row = await db.transcript.findFirstOrThrow({
      where: { versionId: scenario.version.id },
    });
    expect(row.translationStatus).toBeNull();
    expect(row.translatedTexts).toBeNull();
  });

  it('returns 403 to a commentator and leaves the original lines in place', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await seedItalianTranscript(scenario.version.id);
    const member = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: member.id,
      role: ProjectMemberRole.COMMENTATOR,
    });
    signedInAs(member);

    const response = await callRoute(
      translateTranscript,
      apiRequest(`/api/versions/${scenario.version.id}/transcript/translate`, {
        body: { language: 'en' },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    expect(translateTexts).not.toHaveBeenCalled();
    const row = await db.transcript.findFirstOrThrow({
      where: { versionId: scenario.version.id },
      include: { segments: true },
    });
    expect(row.segments[0]?.text).toBe('Ciao a tutti');
    expect(row.translatedTexts).toBeNull();
    expect(row.translationStatus).toBeNull();
  });

  it('stores English beside the original Italian lines', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await seedItalianTranscript(scenario.version.id);
    signedInAs(scenario.owner);

    const response = await callRoute(
      translateTranscript,
      apiRequest(`/api/versions/${scenario.version.id}/transcript/translate`, {
        body: { language: 'en' },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
    expect(translateTexts).toHaveBeenCalledWith({
      texts: ['Ciao a tutti'],
      sourceLanguage: 'it',
      targetLanguage: 'en',
    });

    const body = await readData<{
      translation: { language: string; status: string; texts: string[] };
    }>(response);
    expect(body.translation).toEqual({
      language: 'en',
      status: 'READY',
      error: null,
      texts: ['EN:Ciao a tutti'],
    });

    const row = await db.transcript.findFirstOrThrow({
      where: { versionId: scenario.version.id },
      include: { segments: true },
    });
    expect(row.segments[0]?.text).toBe('Ciao a tutti');
    expect(row.translationLanguage).toBe('en');
    expect(row.translationStatus).toBe(TranscriptStatus.READY);
    expect(row.translatedTexts).toEqual(['EN:Ciao a tutti']);

    const getResponse = await callRoute(
      getTranscript,
      apiRequest(`/api/versions/${scenario.version.id}/transcript`),
      { versionId: scenario.version.id }
    );
    const loaded = await readData<{
      transcript: {
        language: string;
        segments: Array<{ text: string }>;
        translation: { texts: string[] } | null;
      };
    }>(getResponse);
    expect(loaded.transcript.language).toBe('it');
    expect(loaded.transcript.segments[0]?.text).toBe('Ciao a tutti');
    expect(loaded.transcript.translation?.texts).toEqual(['EN:Ciao a tutti']);
  });

  it('marks translation FAILED and keeps the original Italian lines when OpenAI throws', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    await seedItalianTranscript(scenario.version.id);
    signedInAs(scenario.owner);
    translateTexts.mockRejectedValueOnce(new Error('OpenAI translation returned 500'));

    const response = await callRoute(
      translateTranscript,
      apiRequest(`/api/versions/${scenario.version.id}/transcript/translate`, {
        body: { language: 'en' },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(500);
    const row = await db.transcript.findFirstOrThrow({
      where: { versionId: scenario.version.id },
      include: { segments: true },
    });
    expect(row.segments[0]?.text).toBe('Ciao a tutti');
    expect(row.translationStatus).toBe(TranscriptStatus.FAILED);
    expect(row.translatedTexts).toBeNull();
    expect(row.translationError).toContain('OpenAI translation returned 500');
  });
});
