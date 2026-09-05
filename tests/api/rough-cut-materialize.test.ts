import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { assembleDecisionList } from '@/lib/rough-cut/decision-list';
import { materializeRoughCut, type MaterializeDeps } from '@/lib/rough-cut/materialize-job';
import { cutIslandKey } from '@/lib/rough-cut/program';
import {
  createReadyTranscript,
  createRoughCut,
  createVersion,
  createVideo,
  seedProject,
} from '../factories';

/**
 * The materialize job against the real schema. Every other test of this job
 * runs on a fake pool, which will happily accept a column name that does not
 * exist; this one is here to make a typo in the SQL fail. ffmpeg and object
 * storage are still stubbed — there is no encoder in CI — so what is asserted
 * is the rows the job leaves behind.
 */

const RATE = { num: 24, den: 1, dropFrame: false };

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

afterAll(async () => {
  await pool.end();
});

type Uploaded = { key: string; contentType: string; body: string };

function stubbedDeps(uploads: Uploaded[]): MaterializeDeps {
  return {
    pool,
    run: async () => ({ stdout: '', stderr: '', code: 0 }),
    downloadObject: async () => undefined,
    uploadObject: async (key, body, contentType) => {
      uploads.push({ key, contentType, body: body.toString('utf8') });
    },
    objectKeyFromProvider: (version) => version.videoId,
    readOutput: async () => Buffer.from('rendered mp4'),
  };
}

/**
 * A run whose reviewer restored the one island, delivered on an output video
 * that already carries a first render. The source transcript is timed, so the
 * derived words are a shift of real word timings rather than a spread.
 */
async function seedRenderedCut() {
  const scenario = await seedProject();
  const source = await createVideo({ projectId: scenario.project.id, title: 'Cam A' });
  const sourceVersion = await createVersion({
    videoParentId: source.id,
    providerId: 'r2',
    providerVideoId: 'videos/cam-a.mp4',
    originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    duration: 30,
  });
  await createReadyTranscript({
    versionId: sourceVersion.id,
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

  const output = await createVideo({ projectId: scenario.project.id, title: 'Rough cut' });
  const firstRender = await createVersion({
    videoParentId: output.id,
    versionNumber: 1,
    providerId: 'r2',
    providerVideoId: 'videos/out-v1.mp4',
    originalUrl: '/api/upload/video/cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    isActive: true,
  });

  const islandKey = cutIslandKey(sourceVersion.id, 4, 6, RATE);
  const decisions = assembleDecisionList({
    edits: [
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 3,
        inSeconds: 1,
        outSeconds: 4,
        sourceVersionId: sourceVersion.id,
        cameraRole: 'A',
        targetTrack: 1,
      },
      {
        timelineStartSeconds: 3,
        timelineEndSeconds: 7,
        inSeconds: 6,
        outSeconds: 10,
        sourceVersionId: sourceVersion.id,
        cameraRole: 'A',
        targetTrack: 1,
      },
    ],
    clips: [
      {
        videoId: source.id,
        versionId: sourceVersion.id,
        title: 'Cam A',
        role: 'A',
        position: 0,
        offsetSeconds: 0,
        durationSeconds: 30,
        frameRateNum: 24,
        frameRateDen: 1,
        dropFrame: false,
        startTimecode: null,
        originalUrl: sourceVersion.originalUrl,
        versionNumber: 1,
        versionLabel: null,
      },
    ],
    fileNames: new Map([[sourceVersion.id, '01-Cam A-v1.mp4']]),
    mediaPathPrefix: './media/',
    rate: RATE,
    cuts: [
      {
        key: islandKey,
        sourceVersionId: sourceVersion.id,
        inSeconds: 4,
        outSeconds: 6,
        reason: { code: 'DEAD_AIR', summary: '2.0s of dead air' },
        transcriptText: null,
      },
    ],
  });
  const overrides = { version: 1, cuts: { [islandKey]: 'restore' }, extraCuts: [] };
  const cut = await createRoughCut({
    projectId: scenario.project.id,
    requestedById: scenario.owner.id,
    status: 'READY',
    layout: 'LINEAR',
    decisions,
    outputVideoId: output.id,
    overrides,
  });

  return { ...scenario, sourceVersion, output, firstRender, cut, islandKey, overrides };
}

describe('materializeRoughCut against the real schema', () => {
  it('adds a version, stores the effective program and derives the transcript and captions', async () => {
    const seeded = await seedRenderedCut();
    const uploads: Uploaded[] = [];

    await materializeRoughCut(stubbedDeps(uploads), seeded.cut.id);

    const versions = await db.videoVersion.findMany({
      where: { videoParentId: seeded.output.id },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.map((version) => [version.versionNumber, version.isActive])).toEqual([
      [1, false],
      [2, true],
    ]);
    const rendered = versions[1]!;
    expect(rendered.versionLabel).toBe('Re-render 1');
    expect(rendered.providerId).toBe('r2');
    expect(rendered.videoId).toMatch(/^videos\//);
    expect(rendered.originalUrl).toMatch(/^\/api\/upload\/video\//);
    expect(rendered.sizeBytes).toBe(BigInt('rendered mp4'.length));
    expect(rendered.proxyStatus).toBe('SKIPPED');

    const cut = await db.roughCut.findUniqueOrThrow({ where: { id: seeded.cut.id } });
    expect(cut.outputVideoId).toBe(seeded.output.id);
    expect(cut.renderedOverrides).toEqual(seeded.overrides);
    const storedProgram = cut.renderedDecisions as {
      edits: Array<{ inSeconds: number; outSeconds: number }>;
      cuts?: unknown;
    };
    // The restore joined the two edits, and the island it put back is no
    // longer listed as a cut.
    expect(storedProgram.edits.map((edit) => [edit.inSeconds, edit.outSeconds])).toEqual([[1, 10]]);
    expect(storedProgram.cuts).toBeUndefined();

    const transcript = await db.transcript.findFirstOrThrow({
      where: { versionId: rendered.id },
      include: { segments: { orderBy: { position: 'asc' } } },
    });
    expect(transcript.provider).toBe('rough-cut');
    expect(transcript.status).toBe('READY');
    expect(transcript.language).toBe('en');
    expect(transcript.searchText).toBe('one two three four five six');
    // Every word moves one second earlier with the program, in the two lines
    // the source transcript was written in.
    expect(
      transcript.segments.map((segment) => [
        segment.position,
        segment.startSec,
        segment.endSec,
        segment.speaker,
        segment.text,
      ])
    ).toEqual([
      [0, 0, 2.5, null, 'one two three'],
      [1, 3, 5.5, 'B', 'four five six'],
    ]);
    expect(transcript.segments[1]!.words).toEqual([
      { start: 3, end: 3.5, text: 'four' },
      { start: 4, end: 4.5, text: 'five' },
      { start: 5, end: 5.5, text: 'six' },
    ]);

    const subtitle = await db.videoSubtitle.findFirstOrThrow({ where: { versionId: rendered.id } });
    expect(subtitle.language).toBe('en');
    expect(subtitle.label).toBe('Transcript (en)');
    expect(subtitle.billedUserId).toBe(seeded.owner.id);
    expect(subtitle.sourceUrl).toMatch(/^\/api\/upload\/subtitle\/[0-9a-f-]{36}\.vtt$/);
    const vtt = uploads.find((upload) => upload.key.startsWith('subtitles/'));
    expect(vtt?.contentType).toBe('text/vtt');
    expect(vtt?.body).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.500\none two three\n\n' +
        '00:00:03.000 --> 00:00:05.500\nfour five six\n'
    );
    expect(subtitle.sizeBytes).toBe(BigInt(Buffer.byteLength(vtt?.body ?? '', 'utf8')));

    const jobs = await db.mediaJob.findMany({ where: { versionId: rendered.id } });
    expect(jobs.map((job) => [job.kind, job.status])).toEqual([['PROBE_MEDIA', 'PENDING']]);
  });

  it('replaces the derived transcript on a second render instead of stacking segments', async () => {
    const seeded = await seedRenderedCut();

    await materializeRoughCut(stubbedDeps([]), seeded.cut.id);
    await materializeRoughCut(stubbedDeps([]), seeded.cut.id);

    const versions = await db.videoVersion.findMany({
      where: { videoParentId: seeded.output.id },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.map((version) => [version.versionNumber, version.isActive])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    // Each render writes its own version's transcript; nothing is appended to
    // the one before it.
    const transcripts = await db.transcript.findMany({
      where: { version: { videoParentId: seeded.output.id } },
      include: { _count: { select: { segments: true } } },
    });
    expect(transcripts).toHaveLength(2);
    expect(transcripts.map((transcript) => transcript._count.segments)).toEqual([2, 2]);
  });
});
