import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { downloadVideoObject, headVideoObject } from '@/lib/r2';
import { MediaJobKind, MediaJobStatus, TranscriptStatus } from '@prisma/client';
import { runTranscriptionForVersion } from '@/lib/transcription/run-version';
import { createVideo, createVersion, seedProject, seedVersion } from '../factories';

const transcribe = vi.hoisted(() =>
  vi.fn(async () => ({
    language: 'en',
    segments: [
      {
        start: 0,
        end: 1.5,
        text: 'Hello from the mock',
        words: [{ start: 0, end: 1.5, text: 'Hello' }],
      },
    ],
  }))
);

vi.mock('@/lib/transcription', () => ({
  getTranscriptionProvider: () => ({
    name: 'mock-stt',
    transcribe,
  }),
}));

const OBJECT_KEY = 'videos/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.wav';
const VIDEO_OBJECT_KEY = 'videos/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4';

async function seedR2Version(kind: 'AUDIO' | 'VIDEO' = 'AUDIO') {
  const scenario = await seedProject();
  const video = await createVideo({ projectId: scenario.project.id, kind });
  const objectKey = kind === 'AUDIO' ? OBJECT_KEY : VIDEO_OBJECT_KEY;
  const version = await createVersion({
    videoParentId: video.id,
    providerId: 'r2',
    providerVideoId: objectKey,
    originalUrl: `/api/upload/video/${objectKey.slice('videos/'.length)}`,
  });
  const transcript = await db.transcript.create({
    data: {
      versionId: version.id,
      language: 'en',
      provider: 'whisper-local',
      status: TranscriptStatus.PENDING,
    },
  });
  await db.mediaJob.createMany({
    data: [
      { versionId: version.id, kind: MediaJobKind.PROBE_MEDIA },
      { versionId: version.id, kind: MediaJobKind.EXTRACT_AUDIO },
      {
        versionId: version.id,
        kind: MediaJobKind.TRANSCRIBE,
        payload: { language: 'en', transcriptId: transcript.id },
      },
    ],
  });
  return { ...scenario, video, version, transcript };
}

describe('runTranscriptionForVersion', () => {
  beforeEach(() => {
    transcribe.mockClear();
    vi.mocked(downloadVideoObject).mockClear();
    vi.mocked(headVideoObject).mockClear();
  });

  it('writes READY segments and succeeds the transcribe jobs', async () => {
    const { version, transcript } = await seedR2Version();

    await runTranscriptionForVersion({ versionId: version.id, language: 'en' });

    const row = await db.transcript.findUniqueOrThrow({
      where: { id: transcript.id },
      include: { segments: { orderBy: { position: 'asc' } } },
    });
    expect(row.status).toBe(TranscriptStatus.READY);
    expect(row.provider).toBe('mock-stt');
    expect(row.error).toBeNull();
    expect(row.searchText).toBe('Hello from the mock');
    expect(row.segments).toHaveLength(1);
    expect(row.segments[0]?.text).toBe('Hello from the mock');
    expect(row.segments[0]?.startSec).toBe(0);
    expect(row.segments[0]?.endSec).toBe(1.5);
    expect(row.segments[0]?.words).toEqual([{ start: 0, end: 1.5, text: 'Hello' }]);
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        audioPath: expect.stringMatching(/source\.wav$/),
        language: 'en',
      })
    );

    const jobs = await db.mediaJob.findMany({
      where: { versionId: version.id },
      select: { kind: true, status: true, error: true },
    });
    expect(jobs.find((job) => job.kind === MediaJobKind.PROBE_MEDIA)?.status).toBe(
      MediaJobStatus.PENDING
    );
    expect(jobs.find((job) => job.kind === MediaJobKind.EXTRACT_AUDIO)?.status).toBe(
      MediaJobStatus.SUCCEEDED
    );
    expect(jobs.find((job) => job.kind === MediaJobKind.TRANSCRIBE)?.status).toBe(
      MediaJobStatus.SUCCEEDED
    );
    expect(jobs.find((job) => job.kind === MediaJobKind.TRANSCRIBE)?.error).toBeNull();
  });

  it('stores the detected language and does not tell the provider the audio is English', async () => {
    const { version, transcript } = await seedR2Version();
    await db.transcript.update({
      where: { id: transcript.id },
      data: { language: 'und' },
    });
    transcribe.mockResolvedValueOnce({
      language: 'it',
      segments: [
        {
          start: 0,
          end: 1,
          text: 'Ciao dal mock',
          words: [{ start: 0, end: 1, text: 'Ciao' }],
        },
      ],
    });

    await runTranscriptionForVersion({
      versionId: version.id,
      language: 'und',
      transcriptId: transcript.id,
    });

    const row = await db.transcript.findUniqueOrThrow({ where: { id: transcript.id } });
    expect(row.status).toBe(TranscriptStatus.READY);
    expect(row.language).toBe('it');
    expect(row.searchText).toBe('Ciao dal mock');
    expect(row.translationLanguage).toBeNull();
    expect(row.translationStatus).toBeNull();
    expect(row.translatedTexts).toBeNull();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith({
      audioPath: expect.stringMatching(/source\.wav$/),
    });
  });

  it('marks the transcript and transcribe jobs FAILED when download throws', async () => {
    const { version, transcript } = await seedR2Version();
    vi.mocked(downloadVideoObject).mockRejectedValueOnce(new Error('R2 exploded'));

    await runTranscriptionForVersion({ versionId: version.id, language: 'en' });

    const row = await db.transcript.findUniqueOrThrow({
      where: { id: transcript.id },
      include: { segments: true },
    });
    expect(row.status).toBe(TranscriptStatus.FAILED);
    expect(row.error).toBe('R2 exploded');
    expect(row.segments).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();

    const jobs = await db.mediaJob.findMany({
      where: { versionId: version.id },
      select: { kind: true, status: true, error: true },
    });
    expect(jobs.find((job) => job.kind === MediaJobKind.PROBE_MEDIA)?.status).toBe(
      MediaJobStatus.PENDING
    );
    expect(jobs.find((job) => job.kind === MediaJobKind.EXTRACT_AUDIO)?.status).toBe(
      MediaJobStatus.FAILED
    );
    expect(jobs.find((job) => job.kind === MediaJobKind.EXTRACT_AUDIO)?.error).toBe('R2 exploded');
    expect(jobs.find((job) => job.kind === MediaJobKind.TRANSCRIBE)?.status).toBe(
      MediaJobStatus.FAILED
    );
    expect(jobs.find((job) => job.kind === MediaJobKind.TRANSCRIBE)?.error).toBe('R2 exploded');
  });

  it('fails a YouTube version without calling the STT provider', async () => {
    const scenario = await seedVersion();
    const transcript = await db.transcript.create({
      data: {
        versionId: scenario.version.id,
        language: 'en',
        provider: 'whisper-local',
        status: TranscriptStatus.PENDING,
      },
    });

    await runTranscriptionForVersion({ versionId: scenario.version.id, language: 'en' });

    const row = await db.transcript.findUniqueOrThrow({ where: { id: transcript.id } });
    expect(row.status).toBe(TranscriptStatus.FAILED);
    expect(row.error).toBe(
      'This version cannot be transcribed automatically. Upload a transcript file instead.'
    );
    expect(transcribe).not.toHaveBeenCalled();
    expect(downloadVideoObject).not.toHaveBeenCalled();
  });

  it('leaves VIDEO pending for the worker without downloading', async () => {
    const { version, transcript } = await seedR2Version('VIDEO');

    await runTranscriptionForVersion({ versionId: version.id, language: 'en' });

    const row = await db.transcript.findUniqueOrThrow({ where: { id: transcript.id } });
    expect(row.status).toBe(TranscriptStatus.PENDING);
    expect(row.error).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
    expect(downloadVideoObject).not.toHaveBeenCalled();
    expect(headVideoObject).not.toHaveBeenCalled();

    const jobs = await db.mediaJob.findMany({
      where: { versionId: version.id },
      select: { kind: true, status: true },
    });
    expect(jobs.every((job) => job.status === MediaJobStatus.PENDING)).toBe(true);
  });

  it('leaves oversized AUDIO pending without downloading it', async () => {
    const { version, transcript } = await seedR2Version('AUDIO');
    vi.mocked(headVideoObject).mockResolvedValueOnce({
      contentLength: BigInt(25165825),
      contentType: 'audio/wav',
    });

    await runTranscriptionForVersion({ versionId: version.id, language: 'en' });

    const row = await db.transcript.findUniqueOrThrow({ where: { id: transcript.id } });
    expect(row.status).toBe(TranscriptStatus.PENDING);
    expect(row.error).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
    expect(downloadVideoObject).not.toHaveBeenCalled();

    const jobs = await db.mediaJob.findMany({
      where: { versionId: version.id },
      select: { status: true },
    });
    expect(jobs.every((job) => job.status === MediaJobStatus.PENDING)).toBe(true);
  });

  it('resets to PENDING when the download later exceeds the inline cap', async () => {
    const { version, transcript } = await seedR2Version('AUDIO');
    vi.mocked(headVideoObject)
      .mockResolvedValueOnce({
        contentLength: BigInt(1024),
        contentType: 'audio/wav',
      })
      .mockResolvedValueOnce({
        contentLength: BigInt(25165825),
        contentType: 'audio/wav',
      });

    await runTranscriptionForVersion({ versionId: version.id, language: 'en' });

    const row = await db.transcript.findUniqueOrThrow({ where: { id: transcript.id } });
    expect(row.status).toBe(TranscriptStatus.PENDING);
    expect(row.error).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
    expect(downloadVideoObject).not.toHaveBeenCalled();
  });
});
