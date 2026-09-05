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
  /** Picks the filler list; the job reads it off the row. */
  language?: string | null;
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
  /** The copy the speaker read, stored on the run. */
  script?: string | null;
  /** Rows the dedupe guard sees, i.e. a transcription already on its way. */
  queuedTranscribeJobs?: Array<{ id: string }>;
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
            script: options.script ?? null,
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
    // The upsert the job runs when it starts a transcription itself; the
    // TRANSCRIBE job it queues next carries the id this returns.
    if (sql.includes('INSERT INTO transcripts')) {
      return { rows: [{ id: `t-${params[0] as string}` }] };
    }
    // Nothing is already queued unless a test says so, so the enqueue is not
    // skipped by its own dedupe guard.
    if (sql.includes('FROM media_jobs')) {
      return { rows: options.queuedTranscribeJobs ?? [] };
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
    // The transcription enqueue runs in a transaction on its own client. It
    // shares this `query`, so BEGIN/COMMIT and its inserts land in `queries`
    // alongside everything else.
    pool: {
      query,
      connect: async () => ({ query, release: () => {} }),
    } as unknown as Pool,
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
  const transcriptInserts = () =>
    queries.filter((entry) => entry.sql.includes('INSERT INTO transcripts'));
  const vadRuns = () => runs.filter((args) => args[1] === '--vad-only');
  const failed = () => queries.find((entry) => entry.sql.includes("status = 'FAILED'"));

  return {
    deps,
    queries,
    runs,
    downloads,
    persisted,
    mediaJobInserts,
    transcriptInserts,
    vadRuns,
    failed,
  };
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
        reason: { code: 'KEPT', summary: 'Speech' },
      },
      {
        timelineStartSeconds: 7,
        timelineEndSeconds: 10,
        inSeconds: 12,
        outSeconds: 15,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
        reason: { code: 'KEPT', summary: 'Speech' },
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
    // The VAD fallback only exists on a host with transcription switched off.
    vi.stubEnv('OPENFRAME_ENABLE_TRANSCRIPTION', 'false');
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
        reason: { code: 'KEPT', summary: 'Speech' },
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
    // The VAD fallback only exists on a host with transcription switched off.
    vi.stubEnv('OPENFRAME_ENABLE_TRANSCRIPTION', 'false');
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
    // The VAD fallback only exists on a host with transcription switched off.
    vi.stubEnv('OPENFRAME_ENABLE_TRANSCRIPTION', 'false');
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
        reason: { code: 'KEPT', summary: 'Speech' },
      },
      {
        timelineStartSeconds: 5,
        timelineEndSeconds: 8,
        inSeconds: 1,
        outSeconds: 4,
        sourceVersionId: 'ver-b',
        cameraRole: 'CAM',
        targetTrack: 1,
        reason: { code: 'KEPT', summary: 'Speech' },
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
    // Cam A's transcript covers source 2–8 (timeline 5–11). The 2 s before its
    // first word and everything after its last are dead air on that clip, so
    // timeline 3–5 and 11–33 are removed and the rest packs tight: the wide
    // camera's uncovered opening 0–3 stays, then the line.
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({
      sourceVersionId: 'ver-wide',
      timelineStartSeconds: 0,
      timelineEndSeconds: 3,
      inSeconds: 0,
      outSeconds: 3,
      reason: { code: 'HOLD_WIDE' },
    });
    expect(edits[1]).toEqual({
      timelineStartSeconds: 3,
      timelineEndSeconds: 9,
      inSeconds: 2,
      outSeconds: 8,
      sourceVersionId: 'ver-a',
      cameraRole: 'A',
      targetTrack: 1,
      reason: { code: 'SPEAKER_SWITCH', summary: 'Speaker on A' },
    });
    expect(result?.decisions?.cuts?.map((cut) => [cut.key, cut.reason.code])).toEqual([
      ['ver-a:0-48', 'DEAD_AIR'],
      ['ver-a:192-720', 'DEAD_AIR'],
    ]);

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
    // Only the wide transcript's line survives its own dead air, packed from zero.
    expect(
      h.persisted()?.decisions?.edits.find((edit) => edit.sourceVersionId === 'ver-a')
    ).toMatchObject({
      timelineStartSeconds: 0,
      timelineEndSeconds: 6,
      inSeconds: 2,
      outSeconds: 8,
    });
  });

  it('keeps the diarization path for multicam when no transcript exists', async () => {
    // The VAD fallback only exists on a host with transcription switched off.
    vi.stubEnv('OPENFRAME_ENABLE_TRANSCRIPTION', 'false');
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
    // The VAD fallback only exists on a host with transcription switched off.
    vi.stubEnv('OPENFRAME_ENABLE_TRANSCRIPTION', 'false');
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
    // The VAD fallback only exists on a host with transcription switched off.
    vi.stubEnv('OPENFRAME_ENABLE_TRANSCRIPTION', 'false');
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
    // The VAD fallback only exists on a host with transcription switched off.
    vi.stubEnv('OPENFRAME_ENABLE_TRANSCRIPTION', 'false');
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
        reason: { code: 'KEPT', summary: 'Speech' },
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
      const decisions = h.persisted()?.decisions;
      return {
        edits: decisions?.edits.map((edit) => [edit.inSeconds, edit.outSeconds]),
        cuts: decisions?.cuts?.map((cut) => [cut.key, cut.reason.summary]) ?? [],
      };
    };

    // No brief: the 0.5 s pause is under the medium 0.8 s and survives.
    expect(await run(null)).toEqual({
      edits: [[1, 8]],
      cuts: [['ver-a:192-720', '22.0s of dead air after the last word']],
    });
    // A high-aggressiveness brief keeps only 0.4 s, so the same pause is cut
    // as a stall inside the beat, and the island says so.
    expect(
      await run({
        version: 1,
        briefId: 'brief-1',
        source: 'folder',
        layoutSource: 'guess',
        brief: { projectType: 'TALKING_HEAD', pacing: { silenceAggressiveness: 'high' } },
      })
    ).toEqual({
      edits: [
        [1, 4],
        [4.5, 8],
      ],
      cuts: [
        ['ver-a:0-24', '1.0s of dead air before the first word'],
        ['ver-a:96-108', '0.5s of dead air mid-sentence'],
        ['ver-a:192-720', '22.0s of dead air after the last word'],
      ],
    });
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
    // The VAD fallback only exists on a host with transcription switched off.
    vi.stubEnv('OPENFRAME_ENABLE_TRANSCRIPTION', 'false');
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

describe('assembleRoughCut requires the transcript when transcription is on', () => {
  beforeEach(() => {
    vi.stubEnv('OPENFRAME_ENABLE_DIARIZATION', 'false');
  });

  it('fails the run instead of falling back when transcription failed', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'FAILED', created_at: NOW_DATE() }],
      vad: { 'ver-a': [{ start: 1, end: 5 }] },
    });

    await expect(assembleRoughCut(h.deps, 'cut-1')).rejects.toThrow(
      /Transcription failed for Cam A/
    );

    expect(h.failed()?.params[1]).toBe(
      'Transcription failed for Cam A; re-run or upload its transcript, then generate the cut again'
    );
    expect(h.persisted()).toBeNull();
    expect(h.vadRuns()).toHaveLength(0);
    expect(h.downloads).toHaveLength(0);
  });

  it('starts a transcription and parks the run when a clip has none', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [],
    });

    await assembleRoughCut(h.deps, 'cut-1');

    expect(h.transcriptInserts()).toHaveLength(1);
    expect(h.transcriptInserts()[0]!.params[0]).toBe('ver-a');
    const kinds = h.mediaJobInserts().map((entry) => /'(\w+)'/.exec(entry.sql)?.[1]);
    expect(kinds).toEqual(['EXTRACT_AUDIO', 'TRANSCRIBE', 'ASSEMBLE_ROUGH_CUT']);
    const transcribe = h.mediaJobInserts()[1]!;
    expect(JSON.parse(transcribe.params[1] as string)).toEqual({
      language: 'und',
      transcriptId: 't-ver-a',
    });
    expect(h.persisted()).toBeNull();
    expect(h.failed()).toBeUndefined();
    expect(h.downloads).toHaveLength(0);
  });

  it('keeps waiting for a transcript that is still running after fifteen minutes', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: TWENTY_MINUTES_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'RUNNING', created_at: NOW_DATE() }],
      vad: { 'ver-a': [{ start: 1, end: 5 }] },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    expect(h.mediaJobInserts()).toHaveLength(1);
    expect(h.mediaJobInserts()[0]!.sql).toContain("'ASSEMBLE_ROUGH_CUT'");
    expect(h.vadRuns()).toHaveLength(0);
    expect(h.persisted()).toBeNull();
  });

  it('fails a run that waited two hours for a transcript that never came', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: new Date(NOW - 3 * 60 * 60_000),
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'PENDING', created_at: NOW_DATE() }],
    });

    await expect(assembleRoughCut(h.deps, 'cut-1')).rejects.toThrow(/2 hours/);
    expect(h.failed()?.params[1]).toContain('was still not ready after 2 hours');
    expect(h.transcriptInserts()).toHaveLength(0);
  });

  it('fails a run whose only transcript has no spoken words', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE() }],
      segments: { 't-a': [segment(1, 2, '   ')] },
      vad: { 'ver-a': [{ start: 1, end: 5 }] },
    });

    await expect(assembleRoughCut(h.deps, 'cut-1')).rejects.toThrow(/no spoken words/);
    expect(h.vadRuns()).toHaveLength(0);
  });

  it('enqueues the wide camera\u2019s transcript for a multicam run with none', async () => {
    const h = harness({
      layout: 'MULTICAM',
      createdAt: ONE_MINUTE_AGO,
      // Stored with the wide camera second, so picking the first clip rather
      // than the one whose role is WIDE would transcribe Cam A instead.
      videos: [
        video({ version_id: 'ver-a', title: 'Cam A', position: 0 }),
        video({ version_id: 'ver-wide', title: 'WIDE', position: 1 }),
      ],
      transcripts: [],
    });

    await assembleRoughCut(h.deps, 'cut-1');

    expect(h.transcriptInserts().map((entry) => entry.params[0])).toEqual(['ver-wide']);
    expect(h.downloads).toHaveLength(0);
  });

  it('names the camera whose transcription failed, not the wide one', async () => {
    const h = harness({
      layout: 'MULTICAM',
      createdAt: ONE_MINUTE_AGO,
      videos: [
        video({ version_id: 'ver-wide', title: 'WIDE', position: 0 }),
        video({ version_id: 'ver-a', title: 'Cam A', position: 1 }),
      ],
      // The wide camera has no row at all; Cam A's transcription is the one
      // that failed, so the wide camera's name would send the operator to the
      // wrong clip.
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'FAILED', created_at: NOW_DATE() }],
    });

    await expect(assembleRoughCut(h.deps, 'cut-1')).rejects.toThrow(
      /Transcription failed for Cam A/
    );

    expect(h.failed()?.params[1]).toBe(
      'Transcription failed for Cam A; re-run or upload its transcript, then generate the cut again'
    );
    expect(h.transcriptInserts()).toHaveLength(0);
  });

  it('does not queue a second transcription when one is already on its way', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [],
      queuedTranscribeJobs: [{ id: 'job-1' }],
    });

    await assembleRoughCut(h.deps, 'cut-1');

    // The row is still upserted, since the parked run has to have something
    // to wait on; only the duplicate jobs are skipped.
    expect(h.transcriptInserts()).toHaveLength(1);
    const kinds = h.mediaJobInserts().map((entry) => /'(\w+)'/.exec(entry.sql)?.[1]);
    expect(kinds).toEqual(['ASSEMBLE_ROUGH_CUT']);
  });
});

/** A segment with word timings: 0.3 s words at a 0.4 s pitch, so `n` words end at n×0.4−0.1. */
function spokenSegment(at: number, text: string, speaker: string | null = null): SegmentRow {
  const words = text.split(' ').map((word, index) => ({
    start: at + index * 0.4,
    end: at + index * 0.4 + 0.3,
    text: word,
  }));
  return {
    start_sec: words[0]!.start,
    end_sec: words[words.length - 1]!.end,
    speaker,
    text,
    words,
  };
}

function briefSnapshotFor(
  projectType: 'ASCENSORE' | 'TALKING_HEAD' | 'INTERVIEW',
  config: Record<string, unknown> = {}
) {
  return {
    version: 1,
    briefId: 'brief-1',
    source: 'folder',
    layoutSource: 'guess',
    brief: { projectType, ...config },
  };
}

function timing(
  edits: Array<{
    timelineStartSeconds: number;
    timelineEndSeconds: number;
    inSeconds: number;
    outSeconds: number;
    sourceVersionId: string;
  }>
) {
  return edits.map((edit) => [
    edit.sourceVersionId,
    Number(edit.timelineStartSeconds.toFixed(3)),
    Number(edit.timelineEndSeconds.toFixed(3)),
    Number(edit.inSeconds.toFixed(3)),
    Number(edit.outSeconds.toFixed(3)),
  ]);
}

describe('assembleRoughCut editorial pass', () => {
  beforeEach(() => {
    vi.stubEnv('OPENFRAME_ENABLE_DIARIZATION', 'false');
  });

  it('records dead air and a false start as cut islands and keeps the rest', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A', duration: 20 })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE() }],
      segments: {
        't-a': [
          spokenSegment(0, 'so the market'),
          spokenSegment(3, 'so the market for this is enormous.'),
          spokenSegment(9, 'and that is why we are here.'),
        ],
      },
      briefSnapshot: briefSnapshotFor('TALKING_HEAD'),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(timing(result?.decisions?.edits ?? [])).toEqual([
      ['ver-a', 0, 2.7, 3, 5.7],
      ['ver-a', 2.7, 5.4, 9, 11.7],
    ]);
    expect(result?.decisions?.edits.map((edit) => edit.reason)).toEqual([
      { code: 'KEPT', summary: 'Speech' },
      { code: 'KEPT', summary: 'Speech' },
    ]);
    expect(
      result?.decisions?.cuts?.map((cut) => [cut.key, cut.reason.code, cut.transcriptText])
    ).toEqual([
      ['ver-a:26-72', 'DEAD_AIR', null],
      ['ver-a:136-216', 'DEAD_AIR', null],
      ['ver-a:280-480', 'DEAD_AIR', null],
      ['ver-a:0-26', 'FALSE_START', 'so the market'],
    ]);
    expect(result?.decisions?.cuts?.[3]?.reason.summary).toBe(
      'False start of “so the market for this is enormous.”'
    );
    // Nothing needed the audio: no take group asked for loudness.
    expect(h.downloads).toEqual([]);
    expect(h.runs).toEqual([]);
  });

  it('keeps the cleaner of two takes across a sequential cut and measures loudness only for the group', async () => {
    const line = 'our revenue this year doubled to four million dollars';
    // The later take is the dirtier one, so recency alone would pick wrong:
    // only the English filler list makes cleanliness decide.
    const h = harness({
      layout: 'SEQUENTIAL',
      createdAt: ONE_MINUTE_AGO,
      videos: [
        video({ version_id: 'ver-a', title: 'Clip 1', position: 0, duration: 20 }),
        video({ version_id: 'ver-b', title: 'Clip 2', position: 1, duration: 20 }),
      ],
      transcripts: [
        { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE(), language: 'en' },
        { id: 't-b', version_id: 'ver-b', status: 'READY', created_at: NOW_DATE(), language: 'en' },
      ],
      segments: {
        't-a': [spokenSegment(1, line), spokenSegment(8, 'and thanks for coming tonight.')],
        't-b': [spokenSegment(1, `um ${line}`)],
      },
      rms: () => 0.5,
      briefSnapshot: briefSnapshotFor('TALKING_HEAD', {
        ranking: ['cleanliness', 'energy', 'script_match'],
      }),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    // Clip 1's clean take wins over clip 2's later, filler-laden one; clip 1
    // keeps its other beat and clip 2 contributes nothing.
    expect(timing(result?.decisions?.edits ?? [])).toEqual([
      ['ver-a', 0, 3.5, 1, 4.5],
      ['ver-a', 3.5, 5.4, 8, 9.9],
    ]);
    const rejected = result?.decisions?.cuts?.filter((cut) => cut.reason.code === 'REJECTED_TAKE');
    expect(rejected?.map((cut) => [cut.sourceVersionId, cut.transcriptText])).toEqual([
      ['ver-b', `um ${line}`],
    ]);
    expect(rejected?.[0]?.reason.summary).toBe(`Take 2 of 2; kept take 1 (“${line}”)`);
    // Loudness was measured for the two grouped beats and nothing else.
    const rms = h.runs
      .filter((args) => args[1] === '--rms')
      .map((args) => [
        versionIdFromWav(args[2]),
        Number(args[3]),
        Number(Number(args[4]).toFixed(3)),
      ]);
    expect(rms).toEqual([
      ['ver-a', 1, 4.5],
      ['ver-b', 1, 4.9],
    ]);
    expect(h.downloads).toEqual(['audio/ver-a.wav', 'audio/ver-b.wav']);
    expect(result?.warnings).toEqual([
      { code: 'script-match-unavailable', message: expect.stringContaining('script match') },
    ]);
  });

  it('keeps the take that reads the script and flags the line nobody spoke', async () => {
    // Without the script, recency would keep the second take: both are equally
    // clean, and their trigrams overlap too little to group them at all.
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      briefSnapshot: briefSnapshotFor('TALKING_HEAD'),
      script:
        'We help founders raise faster.\nOur product does the heavy lifting.\nThanks for watching.',
      videos: [video({ version_id: 'ver-a', title: 'Cam A', duration: 60 })],
      transcripts: [
        { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE(), language: 'en' },
      ],
      segments: {
        't-a': [
          spokenSegment(1, 'we help founders raise faster'),
          spokenSegment(10, 'we help founders raise much faster'),
          spokenSegment(20, 'thanks for watching everyone'),
        ],
      },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    const rejected = result?.decisions?.cuts?.filter((cut) => cut.reason.code === 'REJECTED_TAKE');
    expect(rejected?.map((cut) => [cut.inSeconds, cut.transcriptText])).toEqual([
      [10, 'we help founders raise much faster'],
    ]);
    expect(result?.decisions?.edits.map((edit) => edit.inSeconds)).toEqual([1, 20]);
    expect(result?.warnings.map((warning) => warning.code)).toContain('script-lines-missing');
    expect(
      result?.warnings.find((warning) => warning.code === 'script-lines-missing')?.message
    ).toContain('Our product does the heavy lifting.');
  });

  it('splices a re-said tail out of the long take and reports it as replaced', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      briefSnapshot: briefSnapshotFor('TALKING_HEAD'),
      videos: [video({ version_id: 'ver-a', title: 'Cam A', duration: 120 })],
      transcripts: [
        { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE(), language: 'en' },
      ],
      segments: {
        't-a': [
          spokenSegment(
            1,
            'in this video we look at how um founders raise their seed round faster than before'
          ),
          spokenSegment(30, 'how founders raise their seed round faster than before'),
        ],
      },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    const rejected = result?.decisions?.cuts?.filter((cut) => cut.reason.code === 'REJECTED_TAKE');
    expect(rejected).toHaveLength(1);
    expect(rejected?.[0]?.reason.summary).toMatch(/replaced by the take at 30/i);
    expect(rejected?.[0]?.transcriptText).toBe(
      'how um founders raise their seed round faster than before'
    );
    expect(result?.decisions?.edits.map((edit) => [edit.inSeconds, edit.outSeconds])).toEqual([
      [1, expect.any(Number)],
      [30, expect.any(Number)],
    ]);
    // The long take now stops before the word "how", the seventh word of the
    // segment, which the helper starts at 1 + 6 × 0.4.
    const firstOut = result?.decisions?.edits[0]?.outSeconds ?? 0;
    expect(firstOut).toBeLessThanOrEqual(1 + 6 * 0.4);
  });

  it('judges the script by what survived the trim, not by what was recorded', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      briefSnapshot: briefSnapshotFor('TALKING_HEAD'),
      script:
        'We help founders raise faster.\nOur product does the heavy lifting today and it always has.',
      videos: [video({ version_id: 'ver-a', title: 'Cam A', duration: 60 })],
      transcripts: [
        { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE(), language: 'en' },
      ],
      segments: {
        't-a': [
          spokenSegment(
            1,
            'we help um founders raise faster our product does the heavy lifting today and it always has'
          ),
          spokenSegment(30, 'lifting today and it always has'),
        ],
      },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    // The long take gives its tail to the cleaner pickup, and neither half now
    // reads the second line: the warning has to be about the cut, not the tape.
    expect(
      result?.decisions?.cuts?.filter((cut) => cut.reason.code === 'REJECTED_TAKE')
    ).toHaveLength(1);
    expect(
      result?.warnings.find((warning) => warning.code === 'script-lines-missing')?.message
    ).toContain('Our product does the heavy lifting today and it always has.');
  });

  it('warns when two takes overlap in the middle and both stay in the cut', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      briefSnapshot: briefSnapshotFor('TALKING_HEAD'),
      // The script is what groups these two: they share one line and nothing else.
      script: 'Our product does the heavy lifting.',
      videos: [video({ version_id: 'ver-a', title: 'Cam A', duration: 60 })],
      transcripts: [
        { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE(), language: 'en' },
      ],
      segments: {
        't-a': [
          spokenSegment(
            1,
            'we help founders raise faster our product does the heavy lifting and we ship on time'
          ),
          spokenSegment(
            40,
            'the team is twelve people our product does the heavy lifting across two offices in europe'
          ),
        ],
      },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    // The shared line sits in the middle of both takes, so neither can give it
    // up at an edge and nothing is cut; the operator is told instead.
    expect(result?.decisions?.cuts?.filter((cut) => cut.reason.code === 'REJECTED_TAKE')).toEqual(
      []
    );
    expect(result?.decisions?.edits.map((edit) => edit.inSeconds)).toEqual([1, 40]);
    expect(result?.warnings.find((warning) => warning.code === 'take-overlap-kept')?.message).toBe(
      '1 take overlaps material already in the cut and could not be trimmed; review it'
    );
  });

  it('warns about a script it cannot read', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      briefSnapshot: briefSnapshotFor('TALKING_HEAD'),
      script: 'ok\nno',
      videos: [video({ version_id: 'ver-a', title: 'Cam A', duration: 60 })],
      transcripts: [
        { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE(), language: 'en' },
      ],
      segments: { 't-a': [spokenSegment(1, 'we help founders raise faster')] },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    expect(h.persisted()?.warnings.map((warning) => warning.code)).toContain('script-unreadable');
  });

  it('ignores the script when the brief does not select takes', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      briefSnapshot: briefSnapshotFor('ASCENSORE'),
      script: 'We help founders raise faster.',
      videos: [video({ version_id: 'ver-a', title: 'Cam A', duration: 60 })],
      transcripts: [
        { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE(), language: 'en' },
      ],
      segments: {
        't-a': [
          spokenSegment(1, 'we help founders raise faster'),
          spokenSegment(10, 'we help founders raise faster'),
        ],
      },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(result?.decisions?.edits).toHaveLength(2);
    expect(result?.warnings.map((warning) => warning.code)).toContain('script-ignored');
  });

  it('picks a take on the multicam session transcript and removes the loser from the program', async () => {
    const line = 'our revenue this year doubled to four million dollars';
    const h = harness({
      layout: 'MULTICAM',
      createdAt: ONE_MINUTE_AGO,
      videos: [
        video({ version_id: 'ver-wide', title: 'Wide', position: 0 }),
        video({ version_id: 'ver-a', title: 'Cam A', position: 1 }),
      ],
      transcripts: [
        {
          id: 't-wide',
          version_id: 'ver-wide',
          status: 'READY',
          created_at: NOW_DATE(),
          language: 'en',
        },
      ],
      segments: { 't-wide': [spokenSegment(2, line, 'S0'), spokenSegment(12, line, 'S0')] },
      rms: (versionId) => (versionId === 'ver-a' ? 1 : 0.2),
      briefSnapshot: briefSnapshotFor('INTERVIEW'),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    // Two equally clean takes: the later one wins, and only it is in the program.
    expect(timing(result?.decisions?.edits ?? [])).toEqual([['ver-a', 0, 3.5, 12, 15.5]]);
    expect(result?.decisions?.cuts?.map((cut) => [cut.key, cut.reason.code])).toEqual([
      ['ver-wide:0-48', 'DEAD_AIR'],
      ['ver-wide:132-288', 'DEAD_AIR'],
      ['ver-wide:372-720', 'DEAD_AIR'],
      ['ver-wide:48-132', 'REJECTED_TAKE'],
    ]);
    expect(result?.decisions?.cuts?.[3]?.reason.summary).toBe(
      `Take 1 of 2; kept take 2 (“${line}”)`
    );
  });

  it('under a low policy keeps a restart as speech rather than calling it a false start', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A', duration: 20 })],
      transcripts: [
        { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE(), language: 'en' },
      ],
      segments: {
        't-a': [
          spokenSegment(0, 'so the market'),
          spokenSegment(3, 'so the market for this is enormous.'),
          spokenSegment(9, 'and that is why we are here.'),
        ],
      },
      briefSnapshot: briefSnapshotFor('TALKING_HEAD', {
        pacing: { silenceAggressiveness: 'low' },
      }),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    // The 1.9 s stall is over low's inside limit (1.5) but under its between
    // limit (2.5), so the two attempts stay one beat and no false start exists;
    // the 1.1 s fragment then falls to the minimum shot length.
    expect(result?.decisions?.cuts?.map((cut) => [cut.key, cut.reason.code])).toEqual([
      ['ver-a:26-72', 'DEAD_AIR'],
      ['ver-a:136-216', 'DEAD_AIR'],
      ['ver-a:280-480', 'DEAD_AIR'],
    ]);
    expect(timing(result?.decisions?.edits ?? [])).toEqual([
      ['ver-a', 0, 2.7, 3, 5.7],
      ['ver-a', 2.7, 5.4, 9, 11.7],
    ]);
  });

  it('holds the wide camera while three people talk at once and cuts the dead air after', async () => {
    const h = harness({
      layout: 'MULTICAM',
      createdAt: ONE_MINUTE_AGO,
      videos: [
        video({ version_id: 'ver-wide', title: 'Wide', position: 0 }),
        video({ version_id: 'ver-a', title: 'Cam A', position: 1 }),
        video({ version_id: 'ver-b', title: 'Cam B', position: 2 }),
      ],
      transcripts: [
        { id: 't-wide', version_id: 'ver-wide', status: 'READY', created_at: NOW_DATE() },
      ],
      segments: {
        't-wide': [
          spokenSegment(0, 'we should talk about pricing now', 'S0'),
          spokenSegment(2.6, 'no wait', 'S1'),
          spokenSegment(3.6, 'hold on', 'S2'),
          spokenSegment(20, 'okay so pricing is simple.', 'S0'),
        ],
      },
      rms: (versionId) => (versionId === 'ver-a' ? 1 : 0.2),
      briefSnapshot: briefSnapshotFor('ASCENSORE'),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(timing(result?.decisions?.edits ?? [])).toEqual([
      ['ver-wide', 0, 4.3, 0, 4.3],
      ['ver-a', 4.3, 6.2, 20, 21.9],
    ]);
    expect(result?.decisions?.edits.map((edit) => edit.reason)).toEqual([
      { code: 'HOLD_WIDE', summary: 'Several people at once; holding wide' },
      { code: 'SPEAKER_SWITCH', summary: 'Speaker on A' },
    ]);
    expect(result?.decisions?.cuts?.map((cut) => [cut.key, cut.reason.summary])).toEqual([
      ['ver-wide:103-480', '15.7s of dead air between thoughts'],
      ['ver-wide:525-720', '8.1s of dead air after the last word'],
    ]);
  });

  it('places placeholder markers on the kept program across a sequential cut', async () => {
    // Clip 2 is Italian, so its cue list differs; clip 3 has an empty
    // transcript and falls back to voice activity, which has no words.
    // That fallback only exists on a host with transcription switched off.
    vi.stubEnv('OPENFRAME_ENABLE_TRANSCRIPTION', 'false');
    const h = harness({
      layout: 'SEQUENTIAL',
      createdAt: ONE_MINUTE_AGO,
      videos: [
        video({ version_id: 'ver-a', title: 'Clip 1', position: 0, duration: 20 }),
        video({ version_id: 'ver-b', title: 'Clip 2', position: 1, duration: 20 }),
        video({ version_id: 'ver-c', title: 'Clip 3', position: 2, duration: 20 }),
      ],
      transcripts: [
        { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE(), language: 'en' },
        { id: 't-b', version_id: 'ver-b', status: 'READY', created_at: NOW_DATE(), language: 'it' },
        { id: 't-c', version_id: 'ver-c', status: 'READY', created_at: NOW_DATE(), language: 'en' },
      ],
      segments: {
        't-a': [spokenSegment(0, 'as you can see our ARR doubled.')],
        't-b': [spokenSegment(0, 'ecco la KPI dashboard.')],
      },
      vad: { 'ver-c': [{ start: 0, end: 3 }] },
      briefSnapshot: briefSnapshotFor('ASCENSORE'),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(timing(result?.decisions?.edits ?? [])).toEqual([
      ['ver-a', 0, 2.7, 0, 2.7],
      ['ver-b', 2.7, 4.2, 0, 1.5],
      ['ver-c', 4.2, 7.2, 0, 3],
    ]);
    // Clip 2 sits at 20 s on the sequential axis; its markers still land at
    // the packed program position, not at 20.x.
    expect(
      result?.decisions?.markers?.map((marker) => [
        marker.key,
        marker.kind,
        Number(marker.timelineSeconds.toFixed(3)),
        marker.durationSeconds === null ? null : Number(marker.durationSeconds.toFixed(3)),
        marker.title,
      ])
    ).toEqual([
      ['ver-a:BROLL:0', 'BROLL', 0, 2.7, 'B-roll: as you can see'],
      ['ver-a:INFOGRAPHIC:48', 'INFOGRAPHIC', 2, 0.7, 'Infographic: ARR'],
      ['ver-b:BROLL:0', 'BROLL', 2.7, 1.5, 'B-roll: ecco'],
      ['ver-b:INFOGRAPHIC:19', 'INFOGRAPHIC', 3.5, 0.7, 'Infographic: KPI'],
    ]);
    expect(result?.decisions?.markers?.[1]?.reason).toEqual({
      code: 'MARKER_JARGON',
      summary: '“ARR” in “as you can see our ARR doubled.”',
    });
  });

  it('clips a marker at a mid-beat dead-air cut and starts the next one after it', async () => {
    // "as you can see the" … 1 s stall … "KPI dashboard is live." is one beat
    // under the medium policy (0.8 s inside limit) with a DEAD_AIR cut inside it.
    const text = 'as you can see the KPI dashboard is live.';
    const words = text.split(' ').map((word, index) => {
      const stall = index >= 5 ? 1 : 0;
      return { start: index * 0.4 + stall, end: index * 0.4 + 0.3 + stall, text: word };
    });
    const segment: SegmentRow = {
      start_sec: 0,
      end_sec: words[words.length - 1]!.end,
      speaker: null,
      text,
      words,
    };
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A', duration: 4.5 })],
      transcripts: [
        { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE(), language: 'en' },
      ],
      segments: { 't-a': [segment] },
      briefSnapshot: briefSnapshotFor('TALKING_HEAD', {
        markers: { infographicOnJargon: true, brollOnIllustration: true },
      }),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(timing(result?.decisions?.edits ?? [])).toEqual([
      ['ver-a', 0, 1.9, 0, 1.9],
      ['ver-a', 1.9, 3.4, 3, 4.5],
    ]);
    expect(result?.decisions?.cuts?.map((cut) => cut.reason.summary)).toEqual([
      '1.1s of dead air mid-sentence',
    ]);
    expect(
      result?.decisions?.markers?.map((marker) => [
        marker.key,
        Number(marker.timelineSeconds.toFixed(3)),
        Number(marker.durationSeconds?.toFixed(3)),
      ])
    ).toEqual([
      ['ver-a:BROLL:0', 0, 1.9],
      ['ver-a:INFOGRAPHIC:72', 1.9, 1.5],
    ]);
  });

  it('drops a marker whose take was rejected and writes none for a run without a brief', async () => {
    const line = 'as you can see the KPI dashboard is live now';
    const fixture = (briefSnapshot: unknown) =>
      harness({
        layout: 'LINEAR',
        createdAt: ONE_MINUTE_AGO,
        videos: [video({ version_id: 'ver-a', title: 'Cam A', duration: 30 })],
        transcripts: [
          {
            id: 't-a',
            version_id: 'ver-a',
            status: 'READY',
            created_at: NOW_DATE(),
            language: 'en',
          },
        ],
        segments: {
          't-a': [spokenSegment(0, `um ${line} um`), spokenSegment(10, line)],
        },
        briefSnapshot,
      });

    const withTakes = fixture(
      briefSnapshotFor('TALKING_HEAD', {
        markers: { infographicOnJargon: true, brollOnIllustration: true },
      })
    );
    await assembleRoughCut(withTakes.deps, 'cut-1');
    const selected = withTakes.persisted()?.decisions;
    expect(selected?.cuts?.map((cut) => cut.reason.code)).toContain('REJECTED_TAKE');
    expect(selected?.markers?.map((marker) => [marker.key, marker.timelineSeconds])).toEqual([
      ['ver-a:BROLL:240', 0],
      ['ver-a:INFOGRAPHIC:288', 2],
    ]);

    const bare = fixture(null);
    await assembleRoughCut(bare.deps, 'cut-1');
    expect(bare.persisted()?.decisions).not.toHaveProperty('markers');
  });

  it('places a multicam marker from the session transcript on the packed program', async () => {
    const h = harness({
      layout: 'MULTICAM',
      createdAt: ONE_MINUTE_AGO,
      videos: [
        video({ version_id: 'ver-wide', title: 'Wide', position: 0 }),
        video({ version_id: 'ver-a', title: 'Cam A', position: 1 }),
      ],
      transcripts: [
        {
          id: 't-wide',
          version_id: 'ver-wide',
          status: 'READY',
          created_at: NOW_DATE(),
          language: 'en',
        },
      ],
      segments: { 't-wide': [spokenSegment(2, 'as you can see the KPI dashboard')] },
      rms: (versionId) => (versionId === 'ver-a' ? 1 : 0.2),
      briefSnapshot: briefSnapshotFor('ASCENSORE'),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    // The leading 2 s of dead air is gone and the speaker camera is up, yet
    // the wide camera's transcript still places the markers.
    expect(timing(result?.decisions?.edits ?? [])).toEqual([['ver-a', 0, 2.7, 2, 4.7]]);
    expect(
      result?.decisions?.markers?.map((marker) => [
        marker.key,
        Number(marker.timelineSeconds.toFixed(3)),
        Number(marker.durationSeconds?.toFixed(3)),
      ])
    ).toEqual([
      ['ver-wide:BROLL:48', 0, 2.7],
      ['ver-wide:INFOGRAPHIC:96', 2, 0.7],
    ]);
  });

  it('holds the primary camera for a brief that does not follow the speaker', async () => {
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
      segments: { 't-wide': [spokenSegment(2, 'hello there everyone and welcome')] },
      rms: (versionId) => (versionId === 'ver-a' ? 1 : 0.2),
      briefSnapshot: briefSnapshotFor('TALKING_HEAD'),
    });

    await assembleRoughCut(h.deps, 'cut-1');

    const result = h.persisted();
    expect(timing(result?.decisions?.edits ?? [])).toEqual([['ver-wide', 0, 1.9, 2, 3.9]]);
    expect(result?.decisions?.edits[0]?.reason).toEqual({
      code: 'HOLD_WIDE',
      summary: 'The brief holds the primary camera',
    });
  });
});

function NOW_DATE(): Date {
  return new Date(NOW);
}
