import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { applyCameraRole, assemblyFromSnapshot, orderClipsForLinearLayout } from './assembly';
import { LOW_ATTRIBUTION_CONFIDENCE, pickHighestRmsCamera, type RmsSample } from './attribute';
import {
  analyseSpeech,
  detectFalseStarts,
  type Beat,
  type SourceCut,
  type SpeechAnalysis,
} from './beats';
import {
  briefFromSnapshot,
  DEFAULT_BRIEF_RANKING,
  SILENCE_AGGRESSIVENESS,
  type BriefRankingCriterion,
  type BriefSnapshot,
  type SilencePolicy,
} from './brief';
import { applyCameraGrammar } from './camera-grammar';
import { inferCameraRole, metadataStringRecord, pickWideClip } from './camera-roles';
import { assembleDecisionList, parseRoughCutDecisionList } from './decision-list';
import { computeLinearDecisions, computeRoughCutDecisions } from './decisions';
import { isDiarizationEnvEnabled, isTranscriptionEnvEnabled } from './env';
import {
  applySequentialOffsets,
  cameraClipToLayoutGuess,
  sortClipsChronologically,
} from './layout';
import {
  illustrationCuesFor,
  markersForBeat,
  placeMarkers,
  type MarkerRules,
  type SourceMarker,
} from './markers';
import { assignClipExportFileNames } from './media-paths';
import { profileFromSnapshot } from './profile';
import { packTimeline, subtractTimelineRanges, toCutIsland } from './program';
import {
  alignBeatToScript,
  parseScript,
  rankingWithScript,
  scriptCoverageWarnings,
  scriptTakeGroups,
} from './script';
import { computeTimecodeOffsets } from './sync';
import { rejectedTakeCuts, selectTakes, TAKE_WINDOW_SECONDS, type TakeCandidate } from './takes';
import { fillerWordsFor } from './text';
import {
  assessTranscriptQuality,
  decideTranscriptSource,
  parseTranscriptRowStatus,
  transcriptFallbackWarning,
  transcriptRequiredError,
  TRANSCRIPT_REQUIRED_WAIT_LIMIT_SECONDS,
  TRANSCRIPT_RETRY_DELAY_SECONDS,
  TRANSCRIPT_WAIT_LIMIT_SECONDS,
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
  CutIsland,
  EditDecision,
  Marker,
  RoughCutLayout,
  RoughCutWarning,
  SyncReport,
} from './types';

export type RunFn = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * The ASSEMBLE_ROUGH_CUT job. It lives here rather than in worker/src so it
 * is type-checked, linted and unit tested with the app; the worker image
 * copies lib/rough-cut next to its own sources and re-exports it.
 */
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
  | {
      kind: 'use';
      transcriptId: string;
      versionId: string;
      language: string | null;
      segments: TranscriptSegmentRow[];
    }
  | { kind: 'fallback'; reason: TranscriptFallbackReason };

/** The brief's editorial policy, with the pre-brief defaults for runs that have none. */
type Editorial = {
  policy: SilencePolicy;
  takeSelection: boolean;
  ranking: BriefRankingCriterion[];
  followSpeaker: boolean;
  holdWideOnChaos: boolean;
  markers: MarkerRules;
};

function editorialFromSnapshot(snapshot: BriefSnapshot | null): Editorial {
  const brief = snapshot?.brief;
  return {
    policy: brief
      ? SILENCE_AGGRESSIVENESS[brief.pacing.silenceAggressiveness]
      : SILENCE_AGGRESSIVENESS.medium,
    takeSelection: brief?.takeSelection.enabled ?? false,
    ranking: brief?.ranking ?? DEFAULT_BRIEF_RANKING,
    followSpeaker: brief?.cameraGrammar.followSpeaker ?? true,
    holdWideOnChaos: brief?.cameraGrammar.holdWideOnChaos ?? false,
    markers: brief?.markers ?? { infographicOnJargon: false, brollOnIllustration: false },
  };
}

/** One clip's speech, from its transcript or from voice activity. */
type ClipMaterial =
  | { kind: 'transcript'; clip: CameraClip; analysis: SpeechAnalysis; language: string | null }
  | { kind: 'vad'; clip: CameraClip; turns: AttributedTurn[] };

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
 * linear run whose transcripts are all ready never touches the audio unless
 * take selection needs loudness.
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

/** The copy the speaker was reading, when the operator gave one. */
function readScript(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
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

/**
 * Start a transcription for a clip that has none, the way an upload does:
 * a PENDING transcript row, audio extraction, then the transcribe job. The
 * worker that runs this job is the worker that will transcribe, so the
 * run parks itself and comes back when the row is READY.
 *
 * All of it goes in one transaction: a row with no jobs behind it would
 * leave the run waiting on a transcript nobody is writing. The row is
 * upserted either way, since the parked run needs something to wait on,
 * but the jobs are skipped when a transcription is already on its way.
 */
async function enqueueTranscription(deps: AssembleDeps, versionId: string): Promise<void> {
  const provider = (process.env.OPENFRAME_TRANSCRIPTION_PROVIDER || 'whisper-local')
    .trim()
    .toLowerCase();
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const upsert = await client.query(
      `INSERT INTO transcripts (id, version_id, language, provider, status, search_text, error, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, 'und', $2, 'PENDING', '', NULL, NOW(), NOW())
       ON CONFLICT (version_id, language)
       DO UPDATE SET status = 'PENDING', error = NULL, provider = EXCLUDED.provider, updated_at = NOW()
       RETURNING id`,
      [versionId, provider]
    );
    const transcriptId = upsert.rows[0]?.id;
    // After the upsert, never before it: the unique index on (version_id,
    // language) makes a concurrent run block there until the first commits,
    // so this SELECT then sees the first run's TRANSCRIBE job.
    const queued = await client.query(
      `SELECT id FROM media_jobs
       WHERE version_id = $1 AND kind = 'TRANSCRIBE' AND status IN ('PENDING', 'QUEUED', 'RUNNING')
       LIMIT 1`,
      [versionId]
    );
    if (!queued.rows[0]) {
      await client.query(
        `INSERT INTO media_jobs (id, kind, status, version_id, attempts, created_at, updated_at)
         VALUES (gen_random_uuid()::text, 'EXTRACT_AUDIO', 'PENDING', $1, 0, NOW(), NOW())`,
        [versionId]
      );
      await client.query(
        `INSERT INTO media_jobs (id, kind, status, version_id, payload, attempts, created_at, updated_at)
         VALUES (gen_random_uuid()::text, 'TRANSCRIBE', 'PENDING', $1, $2::jsonb, 0, NOW(), NOW())`,
        [versionId, JSON.stringify({ language: 'und', transcriptId: transcriptId ?? null })]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    // A rollback on a dead connection throws in turn; the original failure is
    // the one worth reporting.
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignored
    }
    throw error;
  } finally {
    client.release();
  }
}

async function loadTranscriptRows(
  deps: AssembleDeps,
  versionIds: string[]
): Promise<TranscriptRow[]> {
  if (versionIds.length === 0) return [];
  const res = await deps.pool.query(
    `SELECT id, version_id, status, language, created_at
     FROM transcripts
     WHERE version_id = ANY($1::text[])`,
    [versionIds]
  );
  const rows: TranscriptRow[] = [];
  for (const row of res.rows) {
    const status = parseTranscriptRowStatus(row.status);
    if (!status || typeof row.id !== 'string' || typeof row.version_id !== 'string') continue;
    rows.push({
      id: row.id,
      versionId: row.version_id,
      status,
      createdAt: row.created_at,
      language: typeof row.language === 'string' ? row.language : null,
    });
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
  decision: Exclude<TranscriptSourceDecision, { kind: 'wait' }>,
  rows: TranscriptRow[]
): Promise<TranscriptSlot> {
  if (decision.kind === 'fallback') return { kind: 'fallback', reason: decision.reason };
  const segments = await loadTranscriptSegments(deps, decision.transcriptId);
  if (segments.length === 0) return { kind: 'fallback', reason: 'empty' };
  const row = rows.find((entry) => entry.id === decision.transcriptId);
  return {
    kind: 'use',
    transcriptId: decision.transcriptId,
    versionId: decision.versionId,
    language: row?.language ?? null,
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

/**
 * Speech for one clip: the transcript analysed under the brief's silence
 * policy when it has one, voice activity otherwise. A transcript whose
 * words produce no speech at all counts as empty and falls back too.
 *
 * With transcription on there is nothing to fall back to, so the same two
 * cases fail the run instead.
 */
async function materialFor(
  deps: AssembleDeps,
  options: {
    clip: CameraClip;
    slot: TranscriptSlot;
    editorial: Editorial;
    warnings: RoughCutWarning[];
    wavFor: (versionId: string) => Promise<string>;
    /** Multicam names the clip on the fallback warning as well; linear names it always. */
    label: string | null;
    /** Transcription is on for this host, so the transcript is not optional. */
    required: boolean;
    /** How long this run was willing to wait, for the timed-out wording. */
    waitLimitSeconds: number;
  }
): Promise<ClipMaterial> {
  const { clip, slot, editorial, warnings } = options;
  let fallbackReason: TranscriptFallbackReason = 'missing';
  if (slot.kind === 'use') {
    const analysis = analyseSpeech(slot.segments, {
      versionId: clip.versionId,
      durationSeconds: clip.durationSeconds,
      policy: editorial.policy,
    });
    if (analysis.runs.length > 0) {
      const quality = assessTranscriptQuality(slot.segments);
      if (quality.weak) warnings.push(weakTranscriptWarning(quality, options.label));
      return { kind: 'transcript', clip, analysis, language: slot.language };
    }
    if (options.required) {
      throw new Error(transcriptRequiredError('empty', options.label, options.waitLimitSeconds));
    }
    fallbackReason = 'empty';
  } else {
    if (options.required) {
      throw new Error(
        transcriptRequiredError(slot.reason, options.label, options.waitLimitSeconds)
      );
    }
    fallbackReason = slot.reason;
  }
  warnings.push(transcriptFallbackWarning(fallbackReason, options.label, options.waitLimitSeconds));
  const wav = await options.wavFor(clip.versionId);
  const islands = await vadTurnsForClip(deps, wav);
  return {
    kind: 'vad',
    clip,
    turns: islands.map((island) => ({
      start: island.start,
      end: island.end,
      versionId: clip.versionId,
      speaker: null,
      confidence: 1,
    })),
  };
}

type EditorialResult = {
  /** Surviving beats per version, in source order. */
  beatsByVersion: Map<string, Beat[]>;
  cuts: SourceCut[];
  /** Placeholder markers on the surviving beats, still in source time. */
  markers: SourceMarker[];
};

/**
 * The editorial pass the brief drives: dead air is already in the analyses;
 * this adds false starts and take selection across every transcript clip,
 * and returns the beats that survive.
 */
async function editorialPass(
  deps: AssembleDeps,
  options: {
    materials: ClipMaterial[];
    timelineOffsetOf: (clip: CameraClip) => number;
    editorial: Editorial;
    warnings: RoughCutWarning[];
    wavFor: (versionId: string) => Promise<string>;
    script: string | null;
  }
): Promise<EditorialResult> {
  const { editorial, warnings } = options;
  const transcripts = options.materials.filter(
    (material): material is Extract<ClipMaterial, { kind: 'transcript' }> =>
      material.kind === 'transcript'
  );
  const language = transcripts.find((material) => material.language)?.language ?? null;
  const fillers = fillerWordsFor(language);
  const scriptLines = options.script ? parseScript(options.script, fillers) : [];
  if (options.script && scriptLines.length === 0) {
    warnings.push({
      code: 'script-unreadable',
      message: 'The script has no line of three or more words, so it was not used',
    });
  }
  if (scriptLines.length > 0 && !editorial.takeSelection) {
    warnings.push({
      code: 'script-ignored',
      message: 'The brief does not select takes, so the script was not used',
    });
  }
  const cuts: SourceCut[] = [];
  const beatsByVersion = new Map<string, Beat[]>();

  for (const material of transcripts) {
    cuts.push(...material.analysis.cuts);
    let beats = material.analysis.beats;
    if (editorial.policy.detectFalseStarts) {
      const result = detectFalseStarts(beats, fillers);
      beats = result.beats;
      cuts.push(...result.cuts);
    }
    beatsByVersion.set(material.clip.versionId, beats);
  }

  if (editorial.takeSelection && transcripts.length > 0) {
    const useScript = scriptLines.length > 0;
    if (!useScript && editorial.ranking.includes('script_match')) {
      warnings.push({
        code: 'script-match-unavailable',
        message:
          'The brief ranks takes by script match, but this run has no script; it was ignored',
      });
    }
    const candidates: TakeCandidate[] = [];
    for (const material of transcripts) {
      const offset = options.timelineOffsetOf(material.clip);
      for (const beat of beatsByVersion.get(material.clip.versionId) ?? []) {
        candidates.push({ beat, timelineStart: offset + beat.start, energy: null });
      }
    }
    // With a script, a beat is a take of the line it reads however it is
    // worded, and the reading closest to the line wins.
    const alignments = useScript
      ? candidates.map((candidate) => alignBeatToScript(candidate.beat, scriptLines, fillers))
      : [];
    alignments.forEach((alignment, index) => {
      candidates[index]!.scriptMatch = alignment.score;
    });
    const ranking = useScript ? rankingWithScript(editorial.ranking) : editorial.ranking;
    const alsoGroup = useScript
      ? scriptTakeGroups(candidates, alignments, TAKE_WINDOW_SECONDS)
      : [];
    const longPauseSeconds = editorial.policy.maxKeptGapInsideBeatSeconds;
    const options_ = { fillers, ranking, longPauseSeconds, alsoGroup };
    // Loudness costs a wav download and a python call per beat, so it is
    // measured only for beats that are actually in a group.
    if (ranking.includes('energy')) {
      const grouped = new Set(selectTakes(candidates, options_).flatMap((entry) => entry.group));
      for (const index of grouped) {
        const candidate = candidates[index]!;
        const wav = await options.wavFor(candidate.beat.versionId);
        candidate.energy = await rmsAt(deps, wav, candidate.beat.start, candidate.beat.end);
      }
    }
    const rejected = new Set<Beat>();
    for (const decision of selectTakes(candidates, options_)) {
      cuts.push(...rejectedTakeCuts(candidates, decision));
      for (const index of decision.group) {
        if (index !== decision.keptIndex) rejected.add(candidates[index]!.beat);
      }
    }
    for (const [versionId, beats] of beatsByVersion) {
      beatsByVersion.set(
        versionId,
        beats.filter((beat) => !rejected.has(beat))
      );
    }
    if (useScript) {
      const keptAlignments = alignments.filter(
        (_, index) => !rejected.has(candidates[index]!.beat)
      );
      warnings.push(...scriptCoverageWarnings(scriptLines, keptAlignments));
    }
  }

  const markers: SourceMarker[] = [];
  if (editorial.markers.infographicOnJargon || editorial.markers.brollOnIllustration) {
    for (const material of transcripts) {
      const own = material.language ?? language;
      const markerOptions = {
        rules: editorial.markers,
        cues: illustrationCuesFor(own),
        fillers: fillerWordsFor(own),
      };
      for (const beat of beatsByVersion.get(material.clip.versionId) ?? []) {
        markers.push(...markersForBeat(beat, markerOptions));
      }
    }
  }

  return { beatsByVersion, cuts, markers };
}

function turnsFromBeats(beats: Beat[], versionId: string, offsetSeconds: number): AttributedTurn[] {
  return beats.flatMap((beat) =>
    beat.runs.map((run) => ({
      start: run.start + offsetSeconds,
      end: run.end + offsetSeconds,
      versionId,
      speaker: beat.speaker,
      confidence: 1,
    }))
  );
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
    slotByVersion: Map<string, TranscriptSlot>;
    editorial: Editorial;
    script: string | null;
    wavFor: (versionId: string) => Promise<string>;
    required: boolean;
    waitLimitSeconds: number;
  }
): Promise<void> {
  const { profile, clips, warnings, editorial } = options;
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

  const materials: ClipMaterial[] = [];
  for (const clip of orderedClips) {
    const slot = options.slotByVersion.get(clip.versionId) ?? {
      kind: 'fallback' as const,
      reason: 'missing' as const,
    };
    materials.push(
      await materialFor(deps, {
        clip,
        slot,
        editorial,
        warnings,
        wavFor: options.wavFor,
        label: clip.title,
        required: options.required,
        waitLimitSeconds: options.waitLimitSeconds,
      })
    );
  }

  const result = await editorialPass(deps, {
    materials,
    timelineOffsetOf: (clip) => clip.offsetSeconds,
    editorial,
    warnings,
    wavFor: options.wavFor,
    script: options.script,
  });

  const turns: AttributedTurn[] = [];
  for (const material of materials) {
    if (material.kind === 'vad') {
      turns.push(...material.turns);
      continue;
    }
    // Linear turns are source-local; the offsets only place clips on the program.
    turns.push(
      ...turnsFromBeats(
        result.beatsByVersion.get(material.clip.versionId) ?? [],
        material.clip.versionId,
        0
      )
    );
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
  const offsetByVersion = new Map(orderedClips.map((clip) => [clip.versionId, clip.offsetSeconds]));
  const markers: Marker[] = placeMarkers(
    result.markers,
    edits,
    (versionId) => offsetByVersion.get(versionId) ?? 0,
    rate
  );
  const fileNames = assignClipExportFileNames(orderedClips);
  const decisions = assembleDecisionList({
    edits,
    clips: orderedClips,
    fileNames,
    mediaPathPrefix: profile.mediaPathPrefix,
    rate,
    cuts: result.cuts.map((cut) => toCutIsland(cut, rate)),
    markers,
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
    `SELECT id, project_id, folder_id, profile_snapshot, brief_snapshot, layout, script, created_at
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
    const editorial = editorialFromSnapshot(briefFromSnapshot(cut.brief_snapshot));

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
    // With transcription on, the transcript is not an optimisation: voice
    // activity knows nothing about takes, so a run without one is wrong
    // rather than rough. It waits far longer, starts the transcription
    // itself, and fails with something the operator can act on.
    const required = isTranscriptionEnvEnabled();
    const waitLimitSeconds = required
      ? TRANSCRIPT_REQUIRED_WAIT_LIMIT_SECONDS
      : TRANSCRIPT_WAIT_LIMIT_SECONDS;
    const now = new Date();
    const ageSeconds = (now.getTime() - new Date(cut.created_at).getTime()) / 1000;
    const transcriptDecisions = slotCandidates.map((candidateVersionIds) =>
      decideTranscriptSource({
        rows: transcriptRows,
        candidateVersionIds,
        roughCutCreatedAt: cut.created_at,
        now,
        waitLimitSeconds,
      })
    );
    const titleOf = (versionId: string) =>
      clips.find((clip) => clip.versionId === versionId)?.title ?? '';
    const waitingTitles: string[] = [];
    for (let index = 0; index < transcriptDecisions.length; index += 1) {
      const decision = transcriptDecisions[index]!;
      if (decision.kind === 'wait') {
        waitingTitles.push(titleOf(decision.versionId));
        continue;
      }
      if (!required || decision.kind !== 'fallback') continue;
      // Transcription is on, so a clip without a transcript gets one now and
      // the run waits; anything else the operator has to look at. "Missing"
      // means no candidate has a row, so the transcription goes to the first
      // candidate (the wide camera for multicam); the other reasons name the
      // candidate whose own row is the problem.
      const first = slotCandidates[index]![0]!;
      if (decision.reason === 'missing' && ageSeconds < waitLimitSeconds) {
        await enqueueTranscription(deps, first);
        waitingTitles.push(titleOf(first));
        continue;
      }
      throw new Error(
        transcriptRequiredError(
          decision.reason,
          titleOf(decision.versionId ?? first),
          waitLimitSeconds
        )
      );
    }
    if (waitingTitles.length > 0) {
      await deferForTranscript(deps, {
        roughCutId,
        versionId: clips[0]!.versionId,
        warnings: [...warnings, waitingForTranscriptWarning(waitingTitles)],
      });
      return;
    }
    const slots: TranscriptSlot[] = [];
    for (let index = 0; index < transcriptDecisions.length; index += 1) {
      const decision = transcriptDecisions[index]!;
      if (decision.kind === 'wait') continue;
      const slot = await resolveTranscriptSlot(deps, decision, transcriptRows);
      if (required && slot.kind === 'fallback') {
        // Only reachable for a READY transcript with no segment rows, so the
        // clip to name is the one whose transcript was read.
        throw new Error(
          transcriptRequiredError(
            slot.reason,
            titleOf(decision.versionId ?? slotCandidates[index]![0]!),
            waitLimitSeconds
          )
        );
      }
      slots.push(slot);
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
        slotByVersion,
        editorial,
        script: readScript(cut.script),
        wavFor,
        required,
        waitLimitSeconds,
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
    let sourceCuts: SourceCut[] = [];
    let sourceMarkers: SourceMarker[] = [];
    let cutOffset = 0;

    // Timeline-time speech from the session transcript. Its times are local
    // to the clip it was made from, so shift by that clip's sync offset.
    const slot = slots[0] ?? { kind: 'fallback' as const, reason: 'missing' as const };
    const source =
      slot.kind === 'use'
        ? (clips.find((clip) => clip.versionId === slot.versionId) ?? wide.clip)
        : wide.clip;
    // A transcript that reads as empty falls back to voice activity on its own
    // clip inside materialFor; a missing or failed one goes to diarization
    // below, which can do better than plain voice activity when enabled.
    const material: ClipMaterial | null =
      slot.kind === 'use'
        ? await materialFor(deps, {
            clip: source,
            slot,
            editorial,
            warnings,
            wavFor,
            label: source.title,
            required,
            waitLimitSeconds,
          })
        : null;
    if (material && material.kind === 'vad') {
      rawTurns = material.turns.map((turn) => ({
        start: turn.start + source.offsetSeconds,
        end: turn.end + source.offsetSeconds,
        speaker: null,
      }));
    } else if (material && material.kind === 'transcript') {
      const result = await editorialPass(deps, {
        materials: [material],
        timelineOffsetOf: (clip) => clip.offsetSeconds,
        editorial,
        warnings,
        wavFor,
        script: readScript(cut.script),
      });
      sourceCuts = result.cuts;
      sourceMarkers = result.markers;
      cutOffset = source.offsetSeconds;
      rawTurns = turnsFromBeats(
        result.beatsByVersion.get(source.versionId) ?? [],
        source.versionId,
        source.offsetSeconds
      ).map((turn) => ({ start: turn.start, end: turn.end, speaker: turn.speaker }));
    } else {
      // Unreachable when `required`: the decision loop above already threw.
      if (slot.kind === 'fallback') {
        warnings.push(transcriptFallbackWarning(slot.reason, null, waitLimitSeconds));
      }
      // No usable transcript: diarize the reference audio as before. These
      // turns are local to the wide camera's file.
      const diarizeArgs = isDiarizationEnabled()
        ? [diarizeScript, refWav]
        : [diarizeScript, '--vad-only', refWav];
      const diarized = await deps.run('python3', diarizeArgs);
      if (diarized.code === 0) {
        const parsed = parseJson(diarized.stdout) as {
          turns?: Array<{ start: number; end: number; speaker: string }>;
          warning?: string | null;
        };
        rawTurns = (parsed.turns ?? []).map((turn) => ({
          start: turn.start + wide.clip.offsetSeconds,
          end: turn.end + wide.clip.offsetSeconds,
          speaker: turn.speaker,
        }));
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

    const attributed: AttributedTurn[] = [];
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
      attributed.push({
        start: turn.start,
        end: turn.end,
        versionId: picked?.versionId ?? clips[0]!.versionId,
        speaker: turn.speaker,
        confidence,
      });
    }

    const turns = applyCameraGrammar(attributed, {
      wideVersionId: wide.clip.versionId,
      followSpeaker: editorial.followSpeaker,
      holdWideOnChaos: editorial.holdWideOnChaos,
    });

    const continuous = computeRoughCutDecisions(clips, turns, {
      minShotSeconds: profile.minShotSeconds,
      safetyPauseSeconds: profile.safetyPauseSeconds,
      maxShotSeconds: profile.maxShotSeconds,
      overlapBehaviour: profile.overlapBehaviour,
      wideVersionId: wide.clip.versionId,
    });
    // Removed source ranges come out of the continuous program, which is then
    // packed tight: the show does not keep its dead air either.
    const edits: EditDecision[] = packTimeline(
      subtractTimelineRanges(
        continuous,
        sourceCuts.map((cut) => ({ start: cut.start + cutOffset, end: cut.end + cutOffset }))
      )
    );
    const cuts: CutIsland[] = sourceCuts.map((cut) => toCutIsland(cut, rate));
    const offsetByVersion = new Map(clips.map((clip) => [clip.versionId, clip.offsetSeconds]));
    const markers: Marker[] = placeMarkers(
      sourceMarkers,
      edits,
      (versionId) => offsetByVersion.get(versionId) ?? 0,
      rate
    );
    const fileNames = assignClipExportFileNames(clips);
    const decisions = assembleDecisionList({
      edits,
      clips,
      fileNames,
      mediaPathPrefix: profile.mediaPathPrefix,
      rate,
      cuts,
      markers,
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
