import { basename } from 'node:path';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleRoughCut, type AssembleDeps } from '@/lib/rough-cut/assemble-job';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';
import { BUILTIN_ROUGH_CUT_PROFILE, snapshotFromProfile } from '@/lib/rough-cut/profile';
import {
  WAITING_FOR_TRANSCRIPT_WARNING,
  WEAK_TRANSCRIPT_WARNING,
} from '@/lib/rough-cut/transcript-source';
import type { RoughCutWarning } from '@/lib/rough-cut/types';

/**
 * The assemble job against a fake pool and fake python helpers. What matters
 * here is which path the job takes: the transcript rows it reads, whether it
 * downloads audio or shells out at all, and what it writes back.
 */

type VideoRow = {
  id: string;
  title: string;
  position: number;
  metadata: Record<string, unknown>;
  video_created_at: Date;
  version_id: string;
  version_number: number;
  version_label: string | null;
  provider_id: string;
  original_url: string;
  duration: number;
  frame_rate_num: number;
  frame_rate_den: number;
  drop_frame: boolean;
  start_timecode: string | null;
  recorded_at: Date | null;
};

type TranscriptRow = {
  id: string;
  version_id: string;
  status: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';
  created_at: Date;
};

type SegmentRow = {
  start_sec: number;
  end_sec: number;
  speaker: string | null;
  text: string;
  words: unknown;
};

type Query = { sql: string; params: unknown[] };

const NOW = Date.now();
const ONE_MINUTE_AGO = new Date(NOW - 60_000);
const TWENTY_MINUTES_AGO = new Date(NOW - 20 * 60_000);

function video(overrides: Partial<VideoRow> & Pick<VideoRow, 'version_id' | 'title'>): VideoRow {
  return {
    id: `video-${overrides.version_id}`,
    position: 0,
    metadata: {},
    video_created_at: new Date('2026-09-01T10:00:00.000Z'),
    version_number: 1,
    version_label: null,
    provider_id: 'r2',
    original_url: `/api/upload/video/${overrides.version_id}.mp4`,
    duration: 30,
    frame_rate_num: 24,
    frame_rate_den: 1,
    drop_frame: false,
    start_timecode: null,
    recorded_at: null,
    ...overrides,
  };
}

function segment(start: number, end: number, text: string): SegmentRow {
  return { start_sec: start, end_sec: end, speaker: null, text, words: [] };
}

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `w${index}`).join(' ');
}

function versionIdFromWav(path: string | undefined): string {
  return basename(path ?? '').replace(/\.wav$/, '');
}

function harness(options: {
  layout: 'LINEAR' | 'SEQUENTIAL' | 'MULTICAM';
  createdAt: Date;
  videos: VideoRow[];
  transcripts: TranscriptRow[];
  segments?: Record<string, SegmentRow[]>;
  vad?: Record<string, Array<{ start: number; end: number }>>;
  rms?: (versionId: string, start: number, end: number) => number;
  syncOffsets?: number[];
  /** Both the stored wav and a fresh extraction fail, as on a worker without ffmpeg. */
  audioUnavailable?: boolean;
  /** The run's stored brief, as the create route writes it. */
  briefSnapshot?: unknown;
}) {
  const queries: Query[] = [];
  const runs: string[][] = [];
  const downloads: string[] = [];

  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('FROM rough_cuts')) {
      return {
        rows: [
          {
            id: 'cut-1',
            project_id: 'proj-1',
            folder_id: null,
            profile_snapshot: snapshotFromProfile(BUILTIN_ROUGH_CUT_PROFILE),
            layout: options.layout,
            brief_snapshot: options.briefSnapshot ?? null,
            created_at: options.createdAt,
          },
        ],
      };
    }
    if (sql.includes('FROM videos v')) return { rows: options.videos };
    if (sql.includes('FROM transcripts')) {
      const ids = params[0] as string[];
      return { rows: options.transcripts.filter((row) => ids.includes(row.version_id)) };
    }
    if (sql.includes('FROM transcript_segments')) {
      return { rows: options.segments?.[params[0] as string] ?? [] };
    }
    return { rows: [] };
  };

  const run = async (_command: string, args: string[]) => {
    runs.push(args);
    const script = args[0] ?? '';
    if (script.endsWith('sync_offsets.py')) {
      const offsets = args.slice(1).map((path, index) => ({
        path,
        offsetSeconds: options.syncOffsets?.[index] ?? 0,
        confidence: 1,
      }));
      return { stdout: JSON.stringify({ offsets }), stderr: '', code: 0 };
    }
    if (args[1] === '--vad-only') {
      const turns = (options.vad?.[versionIdFromWav(args[2])] ?? []).map((turn) => ({
        ...turn,
        speaker: 'SPEAKER_00',
      }));
      return { stdout: JSON.stringify({ turns }), stderr: '', code: 0 };
    }
    if (args[1] === '--rms') {
      const rms = options.rms?.(versionIdFromWav(args[2]), Number(args[3]), Number(args[4])) ?? 0;
      return { stdout: JSON.stringify({ rms }), stderr: '', code: 0 };
    }
    return { stdout: JSON.stringify({ turns: [] }), stderr: '', code: 0 };
  };

  const deps: AssembleDeps = {
    pool: { query } as unknown as Pool,
    run,
    downloadObject: async (key) => {
      downloads.push(key);
      if (options.audioUnavailable) throw new Error(`no such object ${key}`);
    },
    objectKeyFromProvider: () => null,
    extractAudio: async () => {
      if (options.audioUnavailable) throw new Error('ffmpeg is not installed');
    },
    scriptDir: '/scripts',
  };

  const readyQuery = () => queries.find((entry) => entry.sql.includes("status = 'READY'"));
  const persisted = () => {
    const ready = readyQuery();
    if (!ready) return null;
    return {
      decisions: parseRoughCutDecisionList(JSON.parse(ready.params[1] as string)),
      warnings: JSON.parse(ready.params[3] as string) as RoughCutWarning[],
    };
  };
  const mediaJobInserts = () =>
    queries.filter((entry) => entry.sql.includes('INSERT INTO media_jobs'));
  const vadRuns = () => runs.filter((args) => args[1] === '--vad-only');
  const failed = () => queries.find((entry) => entry.sql.includes("status = 'FAILED'"));

  return { deps, queries, runs, downloads, persisted, mediaJobInserts, vadRuns, failed };
}

describe('assembleRoughCut with a transcript', () => {
  // The fallback path shells out to full diarization when this flag is on;
  // pin it so the suite does not depend on the machine running it.
  beforeEach(() => {
    vi.stubEnv('OPENFRAME_ENABLE_DIARIZATION', 'false');
  });

  it('builds a linear cut from transcript segments without touching the audio', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE() }],
      segments: {
        't-a': [
          segment(1, 4, 'first sentence here'),
          segment(4.5, 8, 'second sentence here'),
          segment(12, 15, 'a third one'),
        ],
      },
      vad: { 'ver-a': [{ start: 20, end: 25 }] },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(result?.decisions?.edits).toEqual([
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 7,
        inSeconds: 1,
        outSeconds: 8,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
      },
      {
        timelineStartSeconds: 7,
        timelineEndSeconds: 10,
        inSeconds: 12,
        outSeconds: 15,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
      },
    ]);
    expect(result?.warnings).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(h.downloads).toEqual([]);
    expect(h.mediaJobInserts().map((entry) => entry.sql)).toEqual([
      expect.stringContaining('MATERIALIZE_ROUGH_CUT'),
    ]);
  });

  it('defers a young run whose transcript is still being written', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'PENDING', created_at: NOW_DATE() }],
      vad: { 'ver-a': [{ start: 2, end: 6 }] },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const inserts = h.mediaJobInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toContain("'ASSEMBLE_ROUGH_CUT'");
    // The delay has to reach the column, not just the parameter list.
    expect(inserts[0]!.sql).toMatch(
      /run_after[\s\S]*NOW\(\) \+ \(\$3::int \* INTERVAL '1 second'\)/
    );
    expect(inserts[0]!.params[0]).toBe('ver-a');
    expect(JSON.parse(inserts[0]!.params[1] as string)).toEqual({ roughCutId: 'cut-1' });
    expect(inserts[0]!.params[2]).toBe(60);

    const warningUpdate = h.queries.find((entry) =>
      entry.sql.includes('UPDATE rough_cuts SET warnings')
    );
    expect(JSON.parse(warningUpdate?.params[1] as string)).toEqual([
      { code: WAITING_FOR_TRANSCRIPT_WARNING, message: expect.stringContaining('Cam A') },
    ]);

    expect(h.persisted()).toBeNull();
    expect(h.queries.some((entry) => entry.sql.includes("status = 'FAILED'"))).toBe(false);
    expect(h.runs).toEqual([]);
    expect(h.downloads).toEqual([]);
  });

  it('falls back to voice activity once a run has waited past the limit', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: TWENTY_MINUTES_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'RUNNING', created_at: NOW_DATE() }],
      vad: { 'ver-a': [{ start: 2, end: 6 }] },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(result?.decisions?.edits).toEqual([
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 4,
        inSeconds: 2,
        outSeconds: 6,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
      },
    ]);
    expect(result?.warnings).toEqual([
      {
        code: WEAK_TRANSCRIPT_WARNING,
        message: expect.stringContaining('still running after 15 minutes'),
      },
    ]);
    expect(h.vadRuns()).toHaveLength(1);
    expect(h.downloads).toEqual(['audio/ver-a.wav']);
    expect(h.mediaJobInserts().map((entry) => entry.sql)).toEqual([
      expect.stringContaining('MATERIALIZE_ROUGH_CUT'),
    ]);
  });

  it('falls back when a READY transcript has no segments', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE() }],
      segments: { 't-a': [] },
      vad: { 'ver-a': [{ start: 2, end: 6 }] },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(result?.decisions?.edits.map((edit) => [edit.inSeconds, edit.outSeconds])).toEqual([
      [2, 6],
    ]);
    expect(result?.warnings).toEqual([
      { code: WEAK_TRANSCRIPT_WARNING, message: expect.stringContaining('has no spoken segments') },
    ]);
    expect(h.vadRuns()).toHaveLength(1);
  });

  it('uses a weak transcript but says so', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE() }],
      segments: { 't-a': [segment(0, 10, words(100))] },
      vad: { 'ver-a': [{ start: 20, end: 25 }] },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(result?.decisions?.edits.map((edit) => [edit.inSeconds, edit.outSeconds])).toEqual([
      [0, 10],
    ]);
    expect(result?.warnings).toEqual([
      {
        code: WEAK_TRANSCRIPT_WARNING,
        message: expect.stringContaining('implausible speech rate'),
      },
    ]);
    expect(h.runs).toEqual([]);
  });

  it('decides per clip in a sequential cut and downloads audio only for the fallback', async () => {
    const h = harness({
      layout: 'SEQUENTIAL',
      createdAt: ONE_MINUTE_AGO,
      // Stored in the opposite order to their chronological (title) order, so
      // a slot looked up by position rather than by version would swap them.
      videos: [
        video({ version_id: 'ver-b', title: 'Clip 2', position: 0, duration: 20 }),
        video({ version_id: 'ver-a', title: 'Clip 1', position: 1, duration: 20 }),
      ],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE() }],
      segments: { 't-a': [segment(0, 5, 'the whole first clip is speech')] },
      vad: { 'ver-a': [{ start: 10, end: 15 }], 'ver-b': [{ start: 1, end: 4 }] },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(result?.decisions?.edits).toEqual([
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 5,
        inSeconds: 0,
        outSeconds: 5,
        sourceVersionId: 'ver-a',
        cameraRole: 'CAM',
        targetTrack: 1,
      },
      {
        timelineStartSeconds: 5,
        timelineEndSeconds: 8,
        inSeconds: 1,
        outSeconds: 4,
        sourceVersionId: 'ver-b',
        cameraRole: 'CAM',
        targetTrack: 1,
      },
    ]);
    expect(result?.warnings).toEqual([
      { code: WEAK_TRANSCRIPT_WARNING, message: expect.stringContaining('for Clip 2') },
    ]);
    expect(h.downloads).toEqual(['audio/ver-b.wav']);
    expect(h.vadRuns().map((args) => versionIdFromWav(args[2]))).toEqual(['ver-b']);
  });

  it('reads one session transcript for multicam and shifts it by that clip’s sync offset', async () => {
    const h = harness({
      layout: 'MULTICAM',
      createdAt: ONE_MINUTE_AGO,
      videos: [
        video({ version_id: 'ver-wide', title: 'Wide', position: 0 }),
        video({ version_id: 'ver-a', title: 'Cam A', position: 1 }),
      ],
      transcripts: [
        { id: 't-wide', version_id: 'ver-wide', status: 'PENDING', created_at: NOW_DATE() },
        { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE() },
      ],
      segments: { 't-a': [segment(2, 8, 'hello there everyone and welcome')] },
      syncOffsets: [0, 3],
      rms: (versionId) => (versionId === 'ver-a' ? 1 : 0.2),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    const edits = result?.decisions?.edits ?? [];
    expect(edits).toHaveLength(3);
    expect(edits[1]).toEqual({
      timelineStartSeconds: 5,
      timelineEndSeconds: 11,
      inSeconds: 2,
      outSeconds: 8,
      sourceVersionId: 'ver-a',
      cameraRole: 'A',
      targetTrack: 1,
    });
    expect(edits[0]?.sourceVersionId).toBe('ver-wide');
    expect(edits[2]?.sourceVersionId).toBe('ver-wide');

    const rmsWindows = h.runs
      .filter((args) => args[1] === '--rms')
      .map((args) => [versionIdFromWav(args[2]), args[3], args[4]]);
    expect(rmsWindows).toEqual([
      ['ver-wide', '5', '11'],
      ['ver-a', '2', '8'],
    ]);
    expect(h.vadRuns()).toEqual([]);
    expect(result?.warnings.map((warning) => warning.code)).not.toContain(WEAK_TRANSCRIPT_WARNING);
    expect(h.downloads).toEqual(['audio/ver-wide.wav', 'audio/ver-a.wav']);
  });

  it('prefers the wide camera’s transcript when more than one is ready', async () => {
    const h = harness({
      layout: 'MULTICAM',
      createdAt: ONE_MINUTE_AGO,
      videos: [
        video({ version_id: 'ver-a', title: 'Cam A', position: 0 }),
        video({ version_id: 'ver-wide', title: 'Wide', position: 1 }),
      ],
      transcripts: [
        { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE() },
        { id: 't-wide', version_id: 'ver-wide', status: 'READY', created_at: NOW_DATE() },
      ],
      segments: {
        't-a': [segment(15, 20, 'only in the close-up transcript')],
        't-wide': [segment(2, 8, 'the room mic heard this')],
      },
      rms: (versionId) => (versionId === 'ver-a' ? 1 : 0.2),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const segmentReads = h.queries
      .filter((entry) => entry.sql.includes('FROM transcript_segments'))
      .map((entry) => entry.params[0]);
    expect(segmentReads).toEqual(['t-wide']);
    expect(
      h.persisted()?.decisions?.edits.find((edit) => edit.sourceVersionId === 'ver-a')
    ).toMatchObject({ timelineStartSeconds: 2, timelineEndSeconds: 8 });
  });

  it('keeps the diarization path for multicam when no transcript exists', async () => {
    const h = harness({
      layout: 'MULTICAM',
      createdAt: ONE_MINUTE_AGO,
      videos: [
        video({ version_id: 'ver-wide', title: 'Wide', position: 0 }),
        video({ version_id: 'ver-a', title: 'Cam A', position: 1 }),
      ],
      transcripts: [],
      vad: { 'ver-wide': [{ start: 4, end: 9 }] },
      rms: (versionId) => (versionId === 'ver-a' ? 1 : 0.2),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(result?.decisions?.edits.find((edit) => edit.sourceVersionId === 'ver-a')).toMatchObject(
      { timelineStartSeconds: 4, timelineEndSeconds: 9 }
    );
    expect(result?.warnings).toEqual([
      { code: WEAK_TRANSCRIPT_WARNING, message: expect.stringContaining('No transcript exists') },
    ]);
    expect(h.vadRuns().map((args) => versionIdFromWav(args[2]))).toEqual(['ver-wide']);
  });
  it('names a failed transcription and uses voice activity for multicam', async () => {
    const h = harness({
      layout: 'MULTICAM',
      createdAt: ONE_MINUTE_AGO,
      videos: [
        video({ version_id: 'ver-wide', title: 'Wide', position: 0 }),
        video({ version_id: 'ver-a', title: 'Cam A', position: 1 }),
      ],
      transcripts: [
        { id: 't-wide', version_id: 'ver-wide', status: 'FAILED', created_at: NOW_DATE() },
        { id: 't-a', version_id: 'ver-a', status: 'FAILED', created_at: NOW_DATE() },
      ],
      vad: { 'ver-wide': [{ start: 4, end: 9 }] },
      rms: (versionId) => (versionId === 'ver-a' ? 1 : 0.2),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(result?.warnings).toEqual([
      { code: WEAK_TRANSCRIPT_WARNING, message: expect.stringContaining('Transcription failed') },
    ]);
    expect(h.vadRuns().map((args) => versionIdFromWav(args[2]))).toEqual(['ver-wide']);
    expect(result?.decisions?.edits.find((edit) => edit.sourceVersionId === 'ver-a')).toMatchObject(
      { timelineStartSeconds: 4, timelineEndSeconds: 9 }
    );
  });

  it('falls back when every transcript segment is blank', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE() }],
      segments: { 't-a': [segment(1, 4, '   '), segment(5, 9, '')] },
      vad: { 'ver-a': [{ start: 2, end: 6 }] },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(result?.decisions?.edits.map((edit) => [edit.inSeconds, edit.outSeconds])).toEqual([
      [2, 6],
    ]);
    expect(result?.warnings).toEqual([
      { code: WEAK_TRANSCRIPT_WARNING, message: expect.stringContaining('no spoken segments') },
    ]);
    expect(h.vadRuns()).toHaveLength(1);
  });

  it('keeps each clip in full when neither transcript nor voice activity finds speech', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [],
      vad: { 'ver-a': [] },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(result?.decisions?.edits).toEqual([
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 30,
        inSeconds: 0,
        outSeconds: 30,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
      },
    ]);
    expect(result?.warnings.map((warning) => warning.code)).toEqual([
      WEAK_TRANSCRIPT_WARNING,
      'no-speech-detected',
    ]);
  });

  it('keeps pauses by the brief’s silence policy, not the medium default', async () => {
    const run = async (briefSnapshot: unknown) => {
      const h = harness({
        layout: 'LINEAR',
        createdAt: ONE_MINUTE_AGO,
        videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
        transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE() }],
        segments: { 't-a': [segment(1, 4, 'first sentence here'), segment(4.5, 8, 'and then')] },
        briefSnapshot,
      });
      await assembleRoughCut(h.deps, 'cut-1');
      return h.persisted()?.decisions?.edits.map((edit) => [edit.inSeconds, edit.outSeconds]);
    };

    // No brief: the 0.5 s pause is under the medium 0.8 s and survives.
    expect(await run(null)).toEqual([[1, 8]]);
    // A high-aggressiveness brief keeps only 0.4 s, so the same pause is cut.
    expect(
      await run({
        version: 1,
        briefId: 'brief-1',
        source: 'folder',
        layoutSource: 'guess',
        brief: { projectType: 'TALKING_HEAD', pacing: { silenceAggressiveness: 'high' } },
      })
    ).toEqual([
      [1, 4],
      [4.5, 8],
    ]);
  });

  it('applies the brief’s silence policy to the multicam transcript as well', async () => {
    const run = async (briefSnapshot: unknown) => {
      const h = harness({
        layout: 'MULTICAM',
        createdAt: ONE_MINUTE_AGO,
        videos: [
          video({ version_id: 'ver-wide', title: 'Wide', position: 0 }),
          video({ version_id: 'ver-a', title: 'Cam A', position: 1 }),
        ],
        transcripts: [
          { id: 't-wide', version_id: 'ver-wide', status: 'READY', created_at: NOW_DATE() },
        ],
        segments: { 't-wide': [segment(2, 4.4, 'one thought'), segment(4.9, 8, 'and another')] },
        rms: (versionId) => (versionId === 'ver-a' ? 1 : 0.2),
        briefSnapshot,
      });
      await assembleRoughCut(h.deps, 'cut-1');
      return h.runs
        .filter((args) => args[1] === '--rms' && versionIdFromWav(args[2]) === 'ver-a')
        .map((args) => [args[3], args[4]]);
    };

    // Medium keeps the 0.5 s pause: one turn, one attribution window.
    expect(await run(null)).toEqual([['2', '8']]);
    // High cuts it: two turns, attributed separately.
    expect(
      await run({
        version: 1,
        briefId: null,
        source: 'builtin',
        layoutSource: 'guess',
        brief: { projectType: 'ASCENSORE', pacing: { silenceAggressiveness: 'high' } },
      })
    ).toEqual([
      ['2', '4.4'],
      ['4.9', '8'],
    ]);
  });

  it('marks the run FAILED with the error when the fallback cannot get audio', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [],
      audioUnavailable: true,
    });

    await expect(assembleRoughCut(h.deps, 'cut-1')).rejects.toThrow('ffmpeg is not installed');

    expect(h.failed()?.params).toEqual(['cut-1', 'ffmpeg is not installed']);
    expect(h.persisted()).toBeNull();
  });

  it('marks the run FAILED when the folder has no file-backed video left', async () => {
    const h = harness({ layout: 'LINEAR', createdAt: ONE_MINUTE_AGO, videos: [], transcripts: [] });

    await expect(assembleRoughCut(h.deps, 'cut-1')).rejects.toThrow(
      'at least one file-backed video'
    );

    expect(h.failed()?.params).toEqual([
      'cut-1',
      'A rough cut needs at least one file-backed video in this folder',
    ]);
  });
});

function NOW_DATE(): Date {
  return new Date(NOW);
}
