import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { materializeRoughCut, type MaterializeDeps } from '@/lib/rough-cut/materialize-job';
import type { RoughCutOverrides } from '@/lib/rough-cut/overrides';
import type { RoughCutDecisionList } from '@/lib/rough-cut/types';

/**
 * The materialize job against a fake pool and a fake ffmpeg. What matters here
 * is the program it renders (the reviewer's decisions applied), where the
 * output lands (a new video, or a new version of the one already rendered),
 * and the transcript and captions it derives for that version.
 */

type Query = { sql: string; params: unknown[] };
type Upload = { key: string; contentType: string; body: string };

const ISLAND_KEY = 'ver-a:100-150';
const OUTPUT_BYTES = 'mp4 bytes';

/** Two edits either side of a two-second dead-air island the reviewer can put back. */
function decisionList(): RoughCutDecisionList {
  return {
    version: 1,
    edits: [
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 3,
        inSeconds: 1,
        outSeconds: 4,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
      },
      {
        timelineStartSeconds: 3,
        timelineEndSeconds: 7,
        inSeconds: 6,
        outSeconds: 10,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
      },
    ],
    clips: [
      {
        versionId: 'ver-a',
        videoId: 'vid-a',
        role: 'A',
        offsetSeconds: 0,
        durationSeconds: 12,
        track: 1,
        fileName: 'A.mp4',
        targetUrl: 'media/A.mp4',
      },
    ],
    rate: { num: 25, den: 1, dropFrame: false },
    cuts: [
      {
        key: ISLAND_KEY,
        sourceVersionId: 'ver-a',
        inSeconds: 4,
        outSeconds: 6,
        reason: { code: 'DEAD_AIR', summary: 'Two seconds of silence' },
        transcriptText: null,
      },
    ],
  };
}

/** One word a second, half a second long, spanning the island the reviewer restores. */
function transcriptSegmentRow() {
  const words = ['one', 'two', 'three', 'four', 'five', 'six'].map((text, index) => ({
    start: index + 1,
    end: index + 1.5,
    text,
  }));
  return {
    start_sec: 1,
    end_sec: 6.5,
    speaker: null,
    text: 'one two three four five six',
    words,
  };
}

function harness(options: {
  overrides?: unknown;
  outputVideoId?: string | null;
  /** `[]` stands for the upsert coming back without an id, as a conflict on a locked row would. */
  transcriptRows?: Array<{ id: string }>;
}) {
  const queries: Query[] = [];
  const runs: string[][] = [];
  const downloads: string[] = [];
  const uploads: Upload[] = [];

  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('FROM rough_cuts')) {
      return {
        rows: [
          {
            id: 'cut-1',
            project_id: 'proj-1',
            folder_id: null,
            decisions: decisionList(),
            overrides: options.overrides ?? null,
            output_video_id: options.outputVideoId ?? null,
          },
        ],
      };
    }
    if (sql.includes('FROM video_versions WHERE id = ANY')) {
      return {
        rows: [
          {
            id: 'ver-a',
            providerId: 'r2',
            videoId: 'videos/ver-a.mp4',
            originalUrl: '/api/upload/video/ver-a.mp4',
          },
        ],
      };
    }
    if (sql.includes('SELECT id FROM videos')) return { rows: [{ id: 'out-1' }] };
    if (sql.includes('COALESCE(MAX("versionNumber")')) return { rows: [{ max: 1 }] };
    if (sql.includes('SELECT position FROM videos')) return { rows: [] };
    if (sql.includes('INSERT INTO transcripts')) {
      return { rows: options.transcriptRows ?? [{ id: 't-out' }] };
    }
    if (sql.includes('FROM transcripts')) {
      return { rows: [{ id: 't-a', version_id: 'ver-a', language: 'en' }] };
    }
    if (sql.includes('SELECT start_sec')) return { rows: [transcriptSegmentRow()] };
    if (sql.includes('SELECT p."ownerId"')) return { rows: [{ owner_id: 'owner-1' }] };
    return { rows: [] };
  };

  const deps: MaterializeDeps = {
    pool: { query } as unknown as Pool,
    run: async (_command, args) => {
      runs.push(args);
      return { stdout: '', stderr: '', code: 0 };
    },
    downloadObject: async (key) => {
      downloads.push(key);
    },
    uploadObject: async (key, body, contentType) => {
      uploads.push({ key, contentType, body: body.toString('utf8') });
    },
    objectKeyFromProvider: (version) => version.videoId,
    readOutput: async () => Buffer.from(OUTPUT_BYTES),
  };

  const find = (needle: string) => queries.find((entry) => entry.sql.includes(needle));
  const all = (needle: string) => queries.filter((entry) => entry.sql.includes(needle));

  return { deps, queries, runs, downloads, uploads, find, all };
}

describe('materializeRoughCut', () => {
  it('renders the effective program and writes a derived transcript and caption track for the new version', async () => {
    const overrides: RoughCutOverrides = {
      version: 1,
      cuts: { [ISLAND_KEY]: 'restore' },
      extraCuts: [],
    };
    const h = harness({ overrides, outputVideoId: 'out-1' });

    await materializeRoughCut(h.deps, 'cut-1');

    // Restoring the island joins the two edits into one 1s–10s range.
    expect(h.downloads).toEqual(['videos/ver-a.mp4']);
    expect(h.runs).toHaveLength(1);
    const args = h.runs[0]!;
    expect([args[args.indexOf('-ss') + 1], args[args.indexOf('-t') + 1]]).toEqual([
      '1.000',
      '9.000',
    ]);

    expect(h.find('UPDATE video_versions')?.params).toEqual(['out-1']);
    const versionInsert = h.find('INSERT INTO video_versions');
    const newVersionId = String(versionInsert?.params[0]);
    expect(versionInsert?.params[1]).toBe(2);
    expect(versionInsert?.params[2]).toBe('Re-render 1');
    expect(versionInsert?.params[7]).toBe('out-1');
    expect(h.all('INSERT INTO videos')).toHaveLength(0);

    const update = h.find('UPDATE rough_cuts');
    expect(update?.params[1]).toBe('out-1');
    expect(JSON.parse(String(update?.params[2]))).toEqual(overrides);
    expect(JSON.parse(String(update?.params[3])).edits).toEqual([
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 9,
        inSeconds: 1,
        outSeconds: 10,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
        reason: { code: 'KEPT', summary: 'Restored by the reviewer' },
      },
    ]);

    // Every word of the source lands in the program, one second earlier.
    expect(h.find('INSERT INTO transcripts')?.params).toEqual([
      newVersionId,
      'en',
      'rough-cut',
      'one two three four five six',
    ]);
    const segmentInserts = h.all('INSERT INTO transcript_segments');
    expect(segmentInserts).toHaveLength(1);
    expect(segmentInserts[0]!.params.slice(1, 5)).toEqual([
      0,
      5.5,
      null,
      'one two three four five six',
    ]);
    expect(JSON.parse(String(segmentInserts[0]!.params[5]))).toEqual([
      { start: 0, end: 0.5, text: 'one' },
      { start: 1, end: 1.5, text: 'two' },
      { start: 2, end: 2.5, text: 'three' },
      { start: 3, end: 3.5, text: 'four' },
      { start: 4, end: 4.5, text: 'five' },
      { start: 5, end: 5.5, text: 'six' },
    ]);

    const subtitle = h.uploads.find((upload) => upload.key.startsWith('subtitles/'));
    expect(subtitle?.contentType).toBe('text/vtt');
    expect(subtitle?.body).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:05.500\none two three four five six\n'
    );
    expect(h.find('INSERT INTO video_subtitles')?.params.slice(0, 3)).toEqual([
      newVersionId,
      'en',
      'Transcript (en)',
    ]);
    const video = h.uploads.find((upload) => upload.key.startsWith('videos/'));
    expect(video?.contentType).toBe('video/mp4');

    const probe = h.find('INSERT INTO media_jobs');
    expect(probe?.sql).toContain('PROBE_MEDIA');
    expect(probe?.params).toEqual([newVersionId]);
  });

  it('creates the output video on a first render', async () => {
    const h = harness({ outputVideoId: null });

    await materializeRoughCut(h.deps, 'cut-1');

    // Two edits, so the untouched program: nothing merged them.
    expect(h.runs[0]!.filter((arg) => arg === '-ss')).toHaveLength(2);

    const videoInserts = h.all('INSERT INTO videos');
    expect(videoInserts).toHaveLength(1);
    expect(videoInserts[0]!.params.slice(1, 5)).toEqual(['Rough cut', 0, null, 'proj-1']);
    const videoId = String(videoInserts[0]!.params[0]);

    const versionInsert = h.find('INSERT INTO video_versions');
    expect(versionInsert?.sql).toContain("VALUES ($1, 1, 'r2'");
    expect(versionInsert?.params).toEqual([
      expect.any(String),
      expect.stringMatching(/^videos\//),
      expect.stringMatching(/^\/api\/upload\/video\//),
      'Rough cut',
      OUTPUT_BYTES.length,
      videoId,
    ]);
    expect(h.all('UPDATE video_versions')).toHaveLength(0);

    const update = h.find('UPDATE rough_cuts');
    expect(update?.params[1]).toBe(videoId);
    expect(update?.params[2]).toBeNull();
    expect(h.find('INSERT INTO media_jobs')?.params).toEqual([versionInsert?.params[0]]);
  });

  it('refuses a program that the reviewer cut to nothing', async () => {
    const h = harness({
      overrides: {
        version: 1,
        cuts: {},
        extraCuts: [{ sourceVersionId: 'ver-a', inSeconds: 0, outSeconds: 12, note: null }],
      },
    });

    await expect(materializeRoughCut(h.deps, 'cut-1')).rejects.toThrow(/Nothing is left/);
    expect(h.runs).toEqual([]);
    expect(h.uploads).toEqual([]);
    expect(h.all('UPDATE rough_cuts')).toHaveLength(0);
  });

  it('does not fail the render when the derived transcript cannot be written', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ outputVideoId: 'out-1', transcriptRows: [] });

    try {
      await materializeRoughCut(h.deps, 'cut-1');

      expect(h.all('INSERT INTO transcript_segments')).toHaveLength(0);
      expect(h.uploads.some((upload) => upload.key.startsWith('subtitles/'))).toBe(false);
      expect(h.find('UPDATE rough_cuts')?.params[1]).toBe('out-1');
      expect(h.find('INSERT INTO media_jobs')?.sql).toContain('PROBE_MEDIA');
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('cut-1'),
        expect.objectContaining({ message: expect.stringContaining('derived transcript') })
      );
    } finally {
      logged.mockRestore();
    }
  });
});
