import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { LOW_ATTRIBUTION_CONFIDENCE, pickHighestRmsCamera, type RmsSample } from './attribute';
import { briefFromSnapshot, SILENCE_AGGRESSIVENESS } from './brief';
import { applyCameraRole, assemblyFromSnapshot, orderClipsForLinearLayout } from './assembly';
import { inferCameraRole, metadataStringRecord, pickWideClip } from './camera-roles';
import { assembleDecisionList, parseRoughCutDecisionList } from './decision-list';
import { computeRoughCutDecisions, computeLinearDecisions } from './decisions';
import { isDiarizationEnvEnabled } from './env';
import {
  applySequentialOffsets,
  cameraClipToLayoutGuess,
  sortClipsChronologically,
} from './layout';
import { assignClipExportFileNames } from './media-paths';
import { profileFromSnapshot } from './profile';
import { computeTimecodeOffsets } from './sync';
import {
  assessTranscriptQuality,
  decideTranscriptSource,
  parseTranscriptRowStatus,
  transcriptFallbackWarning,
  TRANSCRIPT_MAX_KEPT_GAP_SECONDS,
  TRANSCRIPT_RETRY_DELAY_SECONDS,
  turnsFromTranscriptSegments,
  waitingForTranscriptWarning,
  weakTranscriptWarning,
  type TranscriptFallbackReason,
  type TranscriptRow,
  type TranscriptSegmentRow,
  type TranscriptSourceDecision,
} from './transcript-source';
import type {
  AttributedTurn,
  CameraClip,
  RoughCutLayout,
  RoughCutWarning,
  SyncReport,
} from './types';

/**
 * The ASSEMBLE_ROUGH_CUT job. It lives here rather than in worker/src so it
 * is type-checked, linted and unit tested with the app; the worker image
 * copies lib/rough-cut next to its own sources and re-exports it.
 */
export type RunFn = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string; code: number }>;

export type AssembleDeps = {
  pool: Pool;
  run: RunFn;
  downloadObject: (key: string, dest: string) => Promise<void>;
  objectKeyFromProvider: (version: {
    providerId: string;
    videoId: string;
    originalUrl: string;
  }) => string | null;
  extractAudio: (versionId: string) => Promise<void>;
  scriptDir: string;
};

/** What a run knows about one transcript slot once the decision has been resolved against rows. */
type TranscriptSlot =
  | { kind: 'use'; transcriptId: string; versionId: string; segments: TranscriptSegmentRow[] }
  | { kind: 'fallback'; reason: TranscriptFallbackReason };

function parseJson(stdout: string): unknown {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Python helper returned no JSON');
  return JSON.parse(stdout.slice(start, end + 1));
}

function isDiarizationEnabled(): boolean {
  return isDiarizationEnvEnabled(process.env);
}

async function ensureWav(deps: AssembleDeps, versionId: string, dest: string): Promise<void> {
  try {
    await deps.downloadObject(`audio/${versionId}.wav`, dest);
  } catch {
    await deps.extractAudio(versionId);
    await deps.downloadObject(`audio/${versionId}.wav`, dest);
  }
}

/**
 * Download each wav at most once, and only when something asks for it. A
 * linear run whose transcripts are all ready never touches the audio.
 */
function createWavCache(deps: AssembleDeps, dir: string): (versionId: string) => Promise<string> {
  const paths = new Map<string, string>();
  return async (versionId: string) => {
    const existing = paths.get(versionId);
    if (existing) return existing;
    const wav = join(dir, `${versionId}.wav`);
    await ensureWav(deps, versionId, wav);
    paths.set(versionId, wav);
    return wav;
  };
}

async function rmsAt(deps: AssembleDeps, wav: string, start: number, end: number): Promise<number> {
  const script = join(deps.scriptDir, 'diarize.py');
  const ran = await deps.run('python3', [script, '--rms', wav, String(start), String(end)]);
  if (ran.code !== 0) return 0;
  const parsed = parseJson(ran.stdout) as { rms?: number };
  return typeof parsed.rms === 'number' && Number.isFinite(parsed.rms) ? parsed.rms : 0;
}

function isoTimestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function readLayout(value: unknown): RoughCutLayout {
  if (value === 'LINEAR' || value === 'SEQUENTIAL' || value === 'MULTICAM') return value;
  return 'MULTICAM';
}

async function persistReady(
  deps: AssembleDeps,
  roughCutId: string,
  decisions: unknown,
  syncReport: SyncReport,
  warnings: RoughCutWarning[],
  rate: { num: number; den: number; dropFrame: boolean }
): Promise<void> {
  await deps.pool.query(
    `UPDATE rough_cuts
     SET status = 'READY',
         decisions = $2::jsonb,
         sync_report = $3::jsonb,
         warnings = $4::jsonb,
         frame_rate_num = $5,
         frame_rate_den = $6,
         drop_frame = $7,
         error = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [
      roughCutId,
      JSON.stringify(decisions),
      JSON.stringify(syncReport),
      JSON.stringify(warnings.slice(0, 50)),
      rate.num,
      rate.den,
      rate.dropFrame,
    ]
  );

  const parsed = parseRoughCutDecisionList(decisions);
  const firstVersionId = parsed?.edits[0]?.sourceVersionId;
  if (!firstVersionId) return;

  await deps.pool.query(
    `INSERT INTO media_jobs (id, kind, status, version_id, payload, attempts, created_at, updated_at)
     VALUES (gen_random_uuid()::text, 'MATERIALIZE_ROUGH_CUT', 'PENDING', $1, $2::jsonb, 0, NOW(), NOW())`,
    [firstVersionId, JSON.stringify({ roughCutId })]
  );
}

/**
 * Leave the run RUNNING, tell the UI why, and come back later. The retry is
 * a fresh media job with `run_after` set, which `publishPending` skips until
 * the delay has passed.
 */
async function deferForTranscript(
  deps: AssembleDeps,
  options: { roughCutId: string; versionId: string; warnings: RoughCutWarning[] }
): Promise<void> {
  await deps.pool.query(
    `UPDATE rough_cuts SET warnings = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [options.roughCutId, JSON.stringify(options.warnings.slice(0, 50))]
  );
  await deps.pool.query(
    `INSERT INTO media_jobs (id, kind, status, version_id, payload, attempts, run_after, created_at, updated_at)
     VALUES (gen_random_uuid()::text, 'ASSEMBLE_ROUGH_CUT', 'PENDING', $1, $2::jsonb, 0,
             NOW() + ($3::int * INTERVAL '1 second'), NOW(), NOW())`,
    [
      options.versionId,
      JSON.stringify({ roughCutId: options.roughCutId }),
      TRANSCRIPT_RETRY_DELAY_SECONDS,
    ]
  );
}

async function loadTranscriptRows(
  deps: AssembleDeps,
  versionIds: string[]
): Promise<TranscriptRow[]> {
  if (versionIds.length === 0) return [];
  const res = await deps.pool.query(
    `SELECT id, version_id, status, created_at
     FROM transcripts
     WHERE version_id = ANY($1::text[])`,
    [versionIds]
  );
  const rows: TranscriptRow[] = [];
  for (const row of res.rows) {
    const status = parseTranscriptRowStatus(row.status);
    if (!status || typeof row.id !== 'string' || typeof row.version_id !== 'string') continue;
    rows.push({ id: row.id, versionId: row.version_id, status, createdAt: row.created_at });
  }
  return rows;
}

async function loadTranscriptSegments(
  deps: AssembleDeps,
  transcriptId: string
): Promise<TranscriptSegmentRow[]> {
  const res = await deps.pool.query(
    `SELECT start_sec, end_sec, speaker, text, words
     FROM transcript_segments
     WHERE transcript_id = $1
     ORDER BY position ASC`,
    [transcriptId]
  );
  return res.rows.map((row) => ({
    startSec: Number(row.start_sec),
    endSec: Number(row.end_sec),
    speaker: typeof row.speaker === 'string' && row.speaker.trim() ? row.speaker : null,
    text: typeof row.text === 'string' ? row.text : '',
    words: row.words,
  }));
}

async function resolveTranscriptSlot(
  deps: AssembleDeps,
  decision: Exclude<TranscriptSourceDecision, { kind: 'wait' }>
): Promise<TranscriptSlot> {
  if (decision.kind === 'fallback') return decision;
  const segments = await loadTranscriptSegments(deps, decision.transcriptId);
  if (segments.length === 0) return { kind: 'fallback', reason: 'empty' };
  return {
    kind: 'use',
    transcriptId: decision.transcriptId,
    versionId: decision.versionId,
    segments,
  };
}

async function vadTurnsForClip(
  deps: AssembleDeps,
  wav: string
): Promise<Array<{ start: number; end: number }>> {
  const script = join(deps.scriptDir, 'diarize.py');
  const ran = await deps.run('python3', [script, '--vad-only', wav]);
  if (ran.code !== 0) return [];
  const parsed = parseJson(ran.stdout) as { turns?: Array<{ start: number; end: number }> };
  return parsed.turns ?? [];
}

async function assembleLinearLayout(
  deps: AssembleDeps,
  options: {
    roughCutId: string;
    profile: ReturnType<typeof profileFromSnapshot>;
    clips: CameraClip[];
    warnings: RoughCutWarning[];
    metadataByVideoId: Map<string, Record<string, unknown>>;
    clipOrder: string[] | null;
    /** Source-local speech for one clip: transcript when it has one, VAD otherwise. */
    turnsFor: (clip: CameraClip) => Promise<AttributedTurn[]>;
  }
): Promise<void> {
  const { profile, clips, warnings } = options;
  const guessClips = clips.map((clip) =>
    cameraClipToLayoutGuess(
      clip,
      metadataStringRecord(options.metadataByVideoId.get(clip.videoId) ?? {})
    )
  );
  const orderedGuess = orderClipsForLinearLayout(guessClips, options.clipOrder, (entries) =>
    sortClipsChronologically(entries, {
      num: clips[0]!.frameRateNum,
      den: clips[0]!.frameRateDen,
      dropFrame: clips[0]!.dropFrame,
    })
  );
  const byVideoId = new Map(clips.map((clip) => [clip.videoId, clip]));
  const orderedClips = applySequentialOffsets(
    orderedGuess
      .map((guess) => byVideoId.get(guess.id))
      .filter((clip): clip is CameraClip => Boolean(clip))
  );

  const turns: AttributedTurn[] = [];
  for (const clip of orderedClips) {
    turns.push(...(await options.turnsFor(clip)));
  }

  const edits = computeLinearDecisions(orderedClips, turns, {
    minShotSeconds: profile.minShotSeconds,
  });
  if (turns.length === 0) {
    warnings.push({
      code: 'no-speech-detected',
      message: 'No speech was detected; the timeline keeps each clip in full',
    });
  }

  const rate = {
    num: orderedClips[0]!.frameRateNum,
    den: orderedClips[0]!.frameRateDen,
    dropFrame: orderedClips[0]!.dropFrame,
  };
  const fileNames = assignClipExportFileNames(orderedClips);
  const decisions = assembleDecisionList({
    edits,
    clips: orderedClips,
    fileNames,
    mediaPathPrefix: profile.mediaPathPrefix,
    rate,
  });
  const syncReport: SyncReport = {
    strategy: 'AUTO',
    clips: orderedClips.map((clip) => ({
      versionId: clip.versionId,
      offsetSeconds: clip.offsetSeconds,
      method: 'sequence',
      confidence: 1,
    })),
  };
  await persistReady(deps, options.roughCutId, decisions, syncReport, warnings, rate);
}

/** The run's row, its resolved settings, and the folder's file-backed videos. */
async function loadRun(deps: AssembleDeps, roughCutId: string) {
  const cutRes = await deps.pool.query(
    `SELECT id, project_id, folder_id, profile_snapshot, brief_snapshot, layout, created_at
     FROM rough_cuts WHERE id = $1`,
    [roughCutId]
  );
  const cut = cutRes.rows[0];
  if (!cut) throw new Error('Rough cut not found');
  const profile = profileFromSnapshot(cut.profile_snapshot);
  const assembly = assemblyFromSnapshot(cut.profile_snapshot);
  const layout = readLayout(cut.layout);

  const videosRes = await deps.pool.query(
    `SELECT v.id, v.title, v.position, v.metadata, v."createdAt" AS video_created_at,
            vv.id AS version_id, vv."versionNumber" AS version_number, vv."versionLabel" AS version_label,
            vv."providerId" AS provider_id, vv."originalUrl" AS original_url,
            vv.duration, vv.frame_rate_num, vv.frame_rate_den, vv.drop_frame, vv.start_timecode,
            vv.recorded_at
     FROM videos v
     JOIN LATERAL (
       SELECT * FROM video_versions
       WHERE "videoParentId" = v.id
       ORDER BY "versionNumber" DESC
       LIMIT 1
     ) vv ON true
     WHERE v."projectId" = $1 AND v.kind = 'VIDEO'
       AND (($2::text IS NULL AND v.folder_id IS NULL) OR v.folder_id = $2)
       AND vv."providerId" IN ('r2', 'bunny')
       AND COALESCE(v.metadata->>'import_status', 'ready') = 'ready'
     ORDER BY v.position ASC, v.id ASC`,
    [cut.project_id, cut.folder_id]
  );

  if (videosRes.rows.length === 0) {
    throw new Error('A rough cut needs at least one file-backed video in this folder');
  }
  if (layout === 'MULTICAM' && videosRes.rows.length < 2) {
    throw new Error('A multicam rough cut needs at least two file-backed videos in this folder');
  }

  return { cut, profile, assembly, layout, videosRes };
}

export async function assembleRoughCut(deps: AssembleDeps, roughCutId: string): Promise<void> {
  const warnings: RoughCutWarning[] = [];
  await deps.pool.query(
    `UPDATE rough_cuts SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`,
    [roughCutId]
  );

  // Everything after the status flip runs inside the try, so a failure such as
  // a folder that lost its videos lands on the row as FAILED rather than
  // leaving it RUNNING with only the media job marked failed.
  let tmp: string | null = null;
  try {
    const { cut, profile, assembly, layout, videosRes } = await loadRun(deps, roughCutId);
    // The brief's silence policy decides how long a pause survives inside a
    // turn. Runs made before briefs existed keep the medium default.
    const briefSnapshot = briefFromSnapshot(cut.brief_snapshot);
    const maxGapSeconds = briefSnapshot
      ? SILENCE_AGGRESSIVENESS[briefSnapshot.brief.pacing.silenceAggressiveness]
          .maxKeptGapInsideBeatSeconds
      : TRANSCRIPT_MAX_KEPT_GAP_SECONDS;
    const clips: CameraClip[] = [];
    const metadataByVideoId = new Map<string, Record<string, unknown>>();
    for (const row of videosRes.rows) {
      const metadata =
        typeof row.metadata === 'object' && row.metadata
          ? (row.metadata as Record<string, unknown>)
          : {};
      metadataByVideoId.set(row.id, metadata);
      clips.push({
        videoId: row.id,
        versionId: row.version_id,
        title: row.title,
        role: applyCameraRole(
          row.id,
          inferCameraRole(row.title, metadataStringRecord(metadata), profile.cameraRoleMetadataKey),
          assembly.cameraRoles
        ),
        position: row.position,
        offsetSeconds: 0,
        durationSeconds: typeof row.duration === 'number' ? row.duration : 0,
        frameRateNum: row.frame_rate_num ?? 24,
        frameRateDen: row.frame_rate_den ?? 1,
        dropFrame: Boolean(row.drop_frame),
        startTimecode: row.start_timecode,
        recordedAt: isoTimestamp(row.recorded_at),
        createdAt: isoTimestamp(row.video_created_at),
        originalUrl: row.original_url,
        versionNumber: row.version_number,
        versionLabel: row.version_label,
      });
    }

    const rate = {
      num: clips[0]!.frameRateNum,
      den: clips[0]!.frameRateDen,
      dropFrame: clips[0]!.dropFrame,
    };

    // The transcript comes first: it is a cheap query, and a run that has to
    // wait for one must not download any media. Multicam reads one transcript
    // for the whole session (the wide camera's when it has one); linear
    // layouts need one per clip.
    const wide = layout === 'MULTICAM' ? pickWideClip(clips, profile.wideCameraRole) : null;
    if (layout === 'MULTICAM' && !wide) throw new Error('No camera clips found');
    const slotCandidates: string[][] =
      layout === 'MULTICAM'
        ? [
            [
              wide!.clip.versionId,
              ...clips
                .filter((clip) => clip.versionId !== wide!.clip.versionId)
                .map((clip) => clip.versionId),
            ],
          ]
        : clips.map((clip) => [clip.versionId]);
    const transcriptRows = await loadTranscriptRows(
      deps,
      clips.map((clip) => clip.versionId)
    );
    const now = new Date();
    const transcriptDecisions = slotCandidates.map((candidateVersionIds) =>
      decideTranscriptSource({
        rows: transcriptRows,
        candidateVersionIds,
        roughCutCreatedAt: cut.created_at,
        now,
      })
    );
    const waitingFor = transcriptDecisions.filter(
      (decision): decision is Extract<TranscriptSourceDecision, { kind: 'wait' }> =>
        decision.kind === 'wait'
    );
    if (waitingFor.length > 0) {
      const titles = waitingFor.map(
        (decision) => clips.find((clip) => clip.versionId === decision.versionId)?.title ?? ''
      );
      await deferForTranscript(deps, {
        roughCutId,
        versionId: clips[0]!.versionId,
        warnings: [...warnings, waitingForTranscriptWarning(titles)],
      });
      return;
    }
    const slots: TranscriptSlot[] = [];
    for (const decision of transcriptDecisions) {
      if (decision.kind === 'wait') continue;
      slots.push(await resolveTranscriptSlot(deps, decision));
    }

    tmp = await mkdtemp(join(tmpdir(), 'of-rough-'));
    const wavFor = createWavCache(deps, tmp);

    if (layout !== 'MULTICAM') {
      const slotByVersion = new Map<string, TranscriptSlot>();
      clips.forEach((clip, index) => {
        const slot = slots[index];
        if (slot) slotByVersion.set(clip.versionId, slot);
      });

      await assembleLinearLayout(deps, {
        roughCutId,
        profile,
        clips,
        warnings,
        metadataByVideoId,
        clipOrder: assembly.clipOrder,
        turnsFor: async (clip) => {
          const slot = slotByVersion.get(clip.versionId) ?? {
            kind: 'fallback' as const,
            reason: 'missing' as const,
          };
          let fallbackReason: TranscriptFallbackReason = 'missing';
          if (slot.kind === 'use') {
            const turns = turnsFromTranscriptSegments(slot.segments, {
              versionId: clip.versionId,
              offsetSeconds: 0,
              durationSeconds: clip.durationSeconds,
              maxGapSeconds,
            });
            if (turns.length > 0) {
              const quality = assessTranscriptQuality(slot.segments);
              if (quality.weak) warnings.push(weakTranscriptWarning(quality, clip.title));
              return turns;
            }
            fallbackReason = 'empty';
          } else {
            fallbackReason = slot.reason;
          }
          warnings.push(transcriptFallbackWarning(fallbackReason, clip.title));
          const wav = await wavFor(clip.versionId);
          const islands = await vadTurnsForClip(deps, wav);
          return islands.map((island) => ({
            start: island.start,
            end: island.end,
            versionId: clip.versionId,
            speaker: null,
            confidence: 1,
          }));
        },
      });
      return;
    }

    const wavs: string[] = [];
    for (const clip of clips) {
      wavs.push(await wavFor(clip.versionId));
    }

    let strategy: SyncReport['strategy'] = profile.syncStrategy;
    const syncClips: SyncReport['clips'] = [];
    const timecode = computeTimecodeOffsets(
      clips.map((clip) => ({ versionId: clip.versionId, startTimecode: clip.startTimecode })),
      rate
    );
    const useTimecode =
      profile.syncStrategy === 'TIMECODE' || (profile.syncStrategy === 'AUTO' && timecode.ok);
    if (useTimecode && timecode.ok) {
      for (const clip of clips) {
        clip.offsetSeconds = timecode.offsets.get(clip.versionId) ?? 0;
        syncClips.push({
          versionId: clip.versionId,
          offsetSeconds: clip.offsetSeconds,
          method: 'timecode',
          confidence: 1,
        });
      }
      strategy = 'TIMECODE';
    } else {
      if (profile.syncStrategy === 'TIMECODE') {
        warnings.push({
          code: 'timecode-missing',
          message: 'Embedded timecode was missing; clips were left unsynced at offset 0',
        });
        for (const clip of clips) {
          syncClips.push({
            versionId: clip.versionId,
            offsetSeconds: 0,
            method: 'none',
            confidence: 0,
          });
        }
      } else {
        const script = join(deps.scriptDir, 'sync_offsets.py');
        const ran = await deps.run('python3', [script, ...wavs]);
        if (ran.code !== 0) {
          warnings.push({
            code: 'waveform-sync-failed',
            message: ran.stderr || 'Waveform sync failed; clips were left at offset 0',
          });
        } else {
          const parsed = parseJson(ran.stdout) as {
            offsets?: Array<{ path: string; offsetSeconds: number; confidence: number }>;
          };
          parsed.offsets?.forEach((entry, index) => {
            const clip = clips[index];
            if (!clip) return;
            clip.offsetSeconds = entry.offsetSeconds;
            syncClips.push({
              versionId: clip.versionId,
              offsetSeconds: entry.offsetSeconds,
              method: 'waveform',
              confidence: entry.confidence,
            });
          });
        }
        strategy = 'WAVEFORM';
      }
    }

    if (!wide) throw new Error('No camera clips found');
    if (wide.inferred) {
      warnings.push({
        code: 'wide-inferred',
        message: `No clip had role ${profile.wideCameraRole}; using ${wide.clip.title} as the safety shot`,
      });
    }

    const diarizeScript = join(deps.scriptDir, 'diarize.py');
    const refIndex = clips.findIndex((clip) => clip.versionId === wide.clip.versionId);
    const refWav = wavs[refIndex] ?? wavs[0]!;
    let rawTurns: Array<{ start: number; end: number; speaker: string | null }> = [];

    // Timeline-time speech from the session transcript. Its times are local
    // to the clip it was made from, so shift by that clip's sync offset.
    const slot = slots[0] ?? { kind: 'fallback' as const, reason: 'missing' as const };
    let transcriptUsed = false;
    if (slot.kind === 'use') {
      const source = clips.find((clip) => clip.versionId === slot.versionId) ?? wide.clip;
      const turns = turnsFromTranscriptSegments(slot.segments, {
        versionId: source.versionId,
        offsetSeconds: source.offsetSeconds,
        durationSeconds: source.durationSeconds,
        maxGapSeconds,
      });
      if (turns.length > 0) {
        transcriptUsed = true;
        const quality = assessTranscriptQuality(slot.segments);
        if (quality.weak) warnings.push(weakTranscriptWarning(quality, source.title));
        rawTurns = turns.map((turn) => ({
          start: turn.start,
          end: turn.end,
          speaker: turn.speaker,
        }));
      }
    }

    if (!transcriptUsed) {
      warnings.push(transcriptFallbackWarning(slot.kind === 'use' ? 'empty' : slot.reason));
      const diarizeArgs = isDiarizationEnabled()
        ? [diarizeScript, refWav]
        : [diarizeScript, '--vad-only', refWav];
      const diarized = await deps.run('python3', diarizeArgs);
      if (diarized.code === 0) {
        const parsed = parseJson(diarized.stdout) as {
          turns?: Array<{ start: number; end: number; speaker: string }>;
          warning?: string | null;
        };
        rawTurns = parsed.turns ?? [];
        if (parsed.warning) {
          warnings.push({ code: 'diarization-fallback', message: parsed.warning });
        }
      } else {
        warnings.push({
          code: 'diarization-failed',
          message: diarized.stderr || 'Diarization failed; using per-camera voice activity',
        });
      }
    }

    if (rawTurns.length === 0) {
      for (let index = 0; index < wavs.length; index += 1) {
        const ran = await deps.run('python3', [diarizeScript, '--vad-only', wavs[index]!]);
        if (ran.code !== 0) continue;
        const parsed = parseJson(ran.stdout) as {
          turns?: Array<{ start: number; end: number }>;
        };
        for (const turn of parsed.turns ?? []) {
          rawTurns.push({
            start: turn.start + clips[index]!.offsetSeconds,
            end: turn.end + clips[index]!.offsetSeconds,
            speaker: clips[index]!.role,
          });
        }
      }
    }

    const turns: AttributedTurn[] = [];
    for (const turn of rawTurns) {
      const samples: RmsSample[] = [];
      for (let index = 0; index < clips.length; index += 1) {
        const localStart = turn.start - clips[index]!.offsetSeconds;
        const localEnd = turn.end - clips[index]!.offsetSeconds;
        const value = await rmsAt(
          deps,
          wavs[index]!,
          Math.max(0, localStart),
          Math.max(0, localEnd)
        );
        samples.push({ versionId: clips[index]!.versionId, rms: value });
      }
      const picked = pickHighestRmsCamera(samples);
      const confidence = picked?.confidence ?? 0;
      if (confidence < LOW_ATTRIBUTION_CONFIDENCE) {
        warnings.push({
          code: 'low-attribution-confidence',
          message: `Could not confidently pick a camera for ${turn.start.toFixed(1)}s–${turn.end.toFixed(1)}s`,
        });
      }
      turns.push({
        start: turn.start,
        end: turn.end,
        versionId: picked?.versionId ?? clips[0]!.versionId,
        speaker: turn.speaker,
        confidence,
      });
    }

    const edits = computeRoughCutDecisions(clips, turns, {
      minShotSeconds: profile.minShotSeconds,
      safetyPauseSeconds: profile.safetyPauseSeconds,
      maxShotSeconds: profile.maxShotSeconds,
      overlapBehaviour: profile.overlapBehaviour,
      wideVersionId: wide.clip.versionId,
    });
    const fileNames = assignClipExportFileNames(clips);
    const decisions = assembleDecisionList({
      edits,
      clips,
      fileNames,
      mediaPathPrefix: profile.mediaPathPrefix,
      rate,
    });

    const syncReport: SyncReport = { strategy, clips: syncClips };
    await persistReady(deps, roughCutId, decisions, syncReport, warnings, rate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.pool.query(
      `UPDATE rough_cuts SET status = 'FAILED', error = $2, updated_at = NOW() WHERE id = $1`,
      [roughCutId, message]
    );
    throw error;
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

export async function fillTranscriptSpeakers(deps: AssembleDeps, versionId: string): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'of-diar-'));
  const wav = join(tmp, 'audio.wav');
  try {
    await ensureWav(deps, versionId, wav);
    const args = isDiarizationEnabled()
      ? [join(deps.scriptDir, 'diarize.py'), wav]
      : [join(deps.scriptDir, 'diarize.py'), '--vad-only', wav];
    const ran = await deps.run('python3', args);
    if (ran.code !== 0) throw new Error(ran.stderr || 'diarization failed');
    const parsed = parseJson(ran.stdout) as {
      turns?: Array<{ start: number; end: number; speaker: string }>;
    };
    const turns = parsed.turns ?? [];
    const segments = await deps.pool.query(
      `SELECT ts.id, ts.start_sec, ts.end_sec
       FROM transcript_segments ts
       JOIN transcripts t ON t.id = ts.transcript_id
       WHERE t.version_id = $1
       ORDER BY ts.position ASC`,
      [versionId]
    );
    for (const segment of segments.rows) {
      let best: { speaker: string; overlap: number } | null = null;
      for (const turn of turns) {
        const overlap =
          Math.min(segment.end_sec, turn.end) - Math.max(segment.start_sec, turn.start);
        if (overlap <= 0) continue;
        if (!best || overlap > best.overlap) best = { speaker: turn.speaker, overlap };
      }
      if (best) {
        await deps.pool.query(`UPDATE transcript_segments SET speaker = $2 WHERE id = $1`, [
          segment.id,
          best.speaker,
        ]);
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
