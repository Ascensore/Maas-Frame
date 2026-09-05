import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { burnInSubtitles, type BurnInDeps, type BurnInPayload } from '@/lib/rough-cut/burn-in-job';
import { parseBurnInStyle } from '@/lib/rough-cut/subtitle-style';
import { createReadyTranscript, createVersion, createVideo, seedProject } from '../factories';

/**
 * The burn-in job against the real schema. Every other test of this job runs
 * on a fake pool, which will happily accept a column name that does not exist;
 * this one is here to make a typo in the SQL fail. ffmpeg and object storage
 * are still stubbed — there is no encoder in CI — so what is asserted is the
 * rows the job leaves behind.
 */

const TRACK_URL = '/api/upload/subtitle/bbbbbbbb-cccc-dddd-eeee-ffffffffffff.vtt';

const TRACK_VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:02.000',
  'ciao a tutti',
  '',
  '00:00:03.000 --> 00:00:05.000',
  'grazie mille',
  '',
].join('\n');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

afterAll(async () => {
  await pool.end();
});

type Uploaded = { key: string; contentType: string; body: string };

function stubbedDeps(uploads: Uploaded[]): BurnInDeps {
  return {
    pool,
    run: async (command) =>
      command === 'ffprobe'
        ? {
            stdout: JSON.stringify({
              streams: [
                { codec_type: 'video', width: 1920, height: 1080 },
                { codec_type: 'audio', channels: 2 },
              ],
            }),
            stderr: '',
            code: 0,
          }
        : { stdout: '', stderr: '', code: 0 },
    downloadObject: async () => undefined,
    uploadObject: async (key, body, contentType) => {
      uploads.push({ key, contentType, body: body.toString('utf8') });
    },
    // Nothing here drives the job into taking an upload back — the unit suite
    // covers that against a fake pool — so this only has to exist.
    deleteObject: async () => undefined,
    downloadVersionMedia: async () => undefined,
    readOutput: async () => Buffer.from('burned mp4'),
    readText: async () => TRACK_VTT,
    writeText: async () => undefined,
  };
}

function payloadOf(style: Record<string, unknown>, source: BurnInPayload['source']): BurnInPayload {
  const parsed = parseBurnInStyle(style);
  if (!parsed.ok) throw new Error(parsed.error);
  return { style: parsed.value, source };
}

/** A ten-second version with a timed English transcript on it. */
async function seedTranscribedVersion() {
  const scenario = await seedProject();
  const video = await createVideo({ projectId: scenario.project.id, title: 'Talk' });
  const version = await createVersion({
    videoParentId: video.id,
    versionNumber: 1,
    providerId: 'r2',
    providerVideoId: 'videos/talk.mp4',
    originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    title: 'Talk v1',
    duration: 10,
    isActive: true,
  });
  await createReadyTranscript({
    versionId: version.id,
    language: 'en',
    segments: [
      {
        startSec: 1,
        endSec: 3.5,
        text: 'one two three',
        words: [
          { start: 1, end: 1.5, text: 'one' },
          { start: 2, end: 2.5, text: 'two' },
          { start: 3, end: 3.5, text: 'three' },
        ],
      },
      {
        startSec: 4,
        endSec: 6.5,
        speaker: 'B',
        text: 'four five six',
        words: [
          { start: 4, end: 4.5, text: 'four' },
          { start: 5, end: 5.5, text: 'five' },
          { start: 6, end: 6.5, text: 'six' },
        ],
      },
    ],
  });
  return { ...scenario, video, version };
}

/**
 * Which transcript the job burns when the payload names none. Two READY ones
 * sit on the version in different languages, and a third belongs to a
 * different version of the same video.
 */
async function seedCompetingTranscripts(
  seeded: Awaited<ReturnType<typeof seedTranscribedVersion>>
) {
  const older = await db.transcript.findFirstOrThrow({
    where: { versionId: seeded.version.id, language: 'en' },
  });
  await db.transcript.update({
    where: { id: older.id },
    data: { createdAt: new Date('2024-01-01T00:00:00.000Z') },
  });
  const newer = await createReadyTranscript({
    versionId: seeded.version.id,
    language: 'fr',
    segments: [{ startSec: 0, endSec: 2, text: 'bonjour tout le monde', words: [] }],
  });
  await db.transcript.update({
    where: { id: newer.id },
    data: { createdAt: new Date('2024-06-01T00:00:00.000Z') },
  });

  const other = await createVersion({
    videoParentId: seeded.video.id,
    versionNumber: 9,
    providerId: 'r2',
    providerVideoId: 'videos/other.mp4',
    originalUrl: '/api/upload/video/dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    isActive: false,
  });
  const stranger = await createReadyTranscript({
    versionId: other.id,
    language: 'de',
    segments: [{ startSec: 0, endSec: 2, text: 'guten tag alle', words: [] }],
  });
  // Newest of the three on purpose: the job takes the newest transcript, so a
  // stranger dated *after* both is the one a missing `version_id` filter would
  // reach for. Dated before them it would prove nothing.
  await db.transcript.update({
    where: { id: stranger.id },
    data: { createdAt: new Date('2025-01-01T00:00:00.000Z') },
  });
  return { older, newer, other, stranger };
}

describe('burnInSubtitles against the real schema', () => {
  it('adds a subtitled version and carries the re-timed transcript and captions onto it', async () => {
    const seeded = await seedTranscribedVersion();
    const uploads: Uploaded[] = [];

    await burnInSubtitles(
      stubbedDeps(uploads),
      seeded.version.id,
      payloadOf(
        { maxWordsPerCue: 2, playbackRate: 1.25 },
        { kind: 'transcript', transcriptId: null }
      )
    );

    const versions = await db.videoVersion.findMany({
      where: { videoParentId: seeded.video.id },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.map((version) => [version.versionNumber, version.isActive])).toEqual([
      [1, false],
      [2, true],
    ]);
    const burned = versions[1]!;
    expect(burned.versionLabel).toBe('Subtitled 1.25x');
    // A quarter faster, so a ten-second talk runs eight.
    expect(burned.duration).toBe(8);
    expect(burned.title).toBe('Talk v1');
    expect(burned.providerId).toBe('r2');
    expect(burned.videoId).toMatch(/^videos\//);
    expect(burned.originalUrl).toMatch(/^\/api\/upload\/video\//);
    expect(burned.sizeBytes).toBe(BigInt('burned mp4'.length));
    expect(burned.proxyStatus).toBe('SKIPPED');
    expect(uploads.filter((upload) => upload.key.startsWith('videos/'))).toHaveLength(1);

    const transcript = await db.transcript.findFirstOrThrow({
      where: { versionId: burned.id },
      include: { segments: { orderBy: { position: 'asc' } } },
    });
    expect(transcript.provider).toBe('burn-in');
    expect(transcript.status).toBe('READY');
    expect(transcript.language).toBe('en');
    expect(transcript.searchText).toBe('one two three four five six');
    // Same words, every time divided by the rate they are now spoken at.
    expect(
      transcript.segments.map((segment) => [
        segment.position,
        segment.startSec,
        segment.endSec,
        segment.speaker,
        segment.text,
      ])
    ).toEqual([
      [0, 0.8, 2.8, null, 'one two three'],
      [1, 3.2, 5.2, 'B', 'four five six'],
    ]);
    expect(transcript.segments[1]!.words).toEqual([
      { start: 3.2, end: 3.6, text: 'four' },
      { start: 4, end: 4.4, text: 'five' },
      { start: 4.8, end: 5.2, text: 'six' },
    ]);

    const subtitle = await db.videoSubtitle.findFirstOrThrow({ where: { versionId: burned.id } });
    expect(subtitle.language).toBe('en');
    expect(subtitle.label).toBe('Transcript (en)');
    expect(subtitle.billedUserId).toBe(seeded.owner.id);
    const vtt = uploads.find((upload) => upload.key.startsWith('subtitles/'));
    expect(vtt?.contentType).toBe('text/vtt');
    expect(vtt?.body).toBe(
      'WEBVTT\n\n00:00:00.800 --> 00:00:02.800\none two three\n\n' +
        '00:00:03.200 --> 00:00:05.200\nfour five six\n'
    );
    // The source version keeps the transcript and track it already had.
    expect(await db.transcript.count({ where: { versionId: seeded.version.id } })).toBe(1);

    const jobs = await db.mediaJob.findMany({ where: { versionId: burned.id } });
    expect(jobs.map((job) => [job.kind, job.status])).toEqual([['PROBE_MEDIA', 'PENDING']]);
  });

  it('burns the newest READY transcript of this version when the payload names none', async () => {
    const seeded = await seedTranscribedVersion();
    await seedCompetingTranscripts(seeded);

    await burnInSubtitles(
      stubbedDeps([]),
      seeded.version.id,
      payloadOf({ maxWordsPerCue: 2 }, { kind: 'transcript', transcriptId: null })
    );

    const burned = await db.videoVersion.findFirstOrThrow({
      where: { videoParentId: seeded.video.id, isActive: true },
    });
    // MAX(versionNumber) + 1, past the version 9 sitting on the same video.
    expect(burned.versionNumber).toBe(10);

    const transcript = await db.transcript.findFirstOrThrow({ where: { versionId: burned.id } });
    // The French one: newer than the English transcript on this same version,
    // while the newer German one belongs to a different version entirely and is
    // the one an unscoped query would have picked.
    expect(transcript.language).toBe('fr');
    expect(transcript.searchText).toBe('bonjour tout le monde');
  });

  it('burns a caption track when the operator picked one, over the transcript on the same version', async () => {
    const seeded = await seedTranscribedVersion();
    const track = await db.videoSubtitle.create({
      data: {
        versionId: seeded.version.id,
        language: 'it',
        label: 'Italiano',
        sourceUrl: TRACK_URL,
        sizeBytes: BigInt(Buffer.byteLength(TRACK_VTT, 'utf8')),
        billedUserId: seeded.owner.id,
      },
    });
    const uploads: Uploaded[] = [];

    await burnInSubtitles(
      stubbedDeps(uploads),
      seeded.version.id,
      payloadOf({ maxWordsPerCue: 3, uppercase: true }, { kind: 'subtitle', subtitleId: track.id })
    );

    const burned = await db.videoVersion.findFirstOrThrow({
      where: { videoParentId: seeded.video.id, versionNumber: 2 },
    });
    expect(burned.versionLabel).toBe('Subtitled');
    expect(burned.duration).toBe(10);

    // The track's cues, not the English transcript sitting on the same version.
    const transcript = await db.transcript.findFirstOrThrow({
      where: { versionId: burned.id },
      include: { segments: { orderBy: { position: 'asc' } } },
    });
    expect(transcript.provider).toBe('burn-in');
    expect(transcript.language).toBe('it');
    // In the operator's own case and cue boundaries: the capitals and the
    // words-per-cue regrouping are for the picture, not for the text people
    // read and search.
    expect(
      transcript.segments.map((segment) => [
        segment.position,
        segment.startSec,
        segment.endSec,
        segment.text,
      ])
    ).toEqual([
      [0, 0, 2, 'ciao a tutti'],
      [1, 3, 5, 'grazie mille'],
    ]);
    expect(transcript.searchText).toBe('ciao a tutti grazie mille');

    const subtitle = await db.videoSubtitle.findFirstOrThrow({ where: { versionId: burned.id } });
    expect(subtitle.language).toBe('it');
    const vtt = uploads.find((upload) => upload.key.startsWith('subtitles/'));
    expect(vtt?.body).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nciao a tutti\n\n' +
        '00:00:03.000 --> 00:00:05.000\ngrazie mille\n'
    );
  });
});
