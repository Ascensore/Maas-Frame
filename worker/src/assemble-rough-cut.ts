import { join } from 'node:path';
import type { Pool } from 'pg';
import {
  LOW_ATTRIBUTION_CONFIDENCE,
  pickHighestRmsCamera,
  type RmsSample,
} from '../lib/rough-cut/attribute';
import { inferCameraRole, metadataStringRecord, pickWideClip } from '../lib/rough-cut/camera-roles';
import { assembleDecisionList } from '../lib/rough-cut/decision-list';
import { computeRoughCutDecisions } from '../lib/rough-cut/decisions';
import { isDiarizationEnvEnabled } from '../lib/rough-cut/env';
import { assignClipExportFileNames } from '../lib/rough-cut/media-paths';
import { profileFromSnapshot } from '../lib/rough-cut/profile';
import { computeTimecodeOffsets } from '../lib/rough-cut/sync';
import type {
  AttributedTurn,
  CameraClip,
  RoughCutWarning,
  SyncReport,
} from '../lib/rough-cut/types';

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

function parseJson(stdout: string): unknown {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Python helper returned no JSON');
  return JSON.parse(stdout.slice(start, end + 1));
}

function isDiarizationEnabled(): boolean {
  return isDiarizationEnvEnabled(process.env);
}

async function ensureWav(
  deps: AssembleDeps,
  versionId: string,
  dest: string
): Promise<void> {
  try {
    await deps.downloadObject(`audio/${versionId}.wav`, dest);
  } catch {
    await deps.extractAudio(versionId);
    await deps.downloadObject(`audio/${versionId}.wav`, dest);
  }
}

async function rmsAt(
  deps: AssembleDeps,
  wav: string,
  start: number,
  end: number
): Promise<number> {
  const script = join(deps.scriptDir, 'diarize.py');
  const ran = await deps.run('python3', [script, '--rms', wav, String(start), String(end)]);
  if (ran.code !== 0) return 0;
  const parsed = parseJson(ran.stdout) as { rms?: number };
  return typeof parsed.rms === 'number' && Number.isFinite(parsed.rms) ? parsed.rms : 0;
}

export async function assembleRoughCut(deps: AssembleDeps, roughCutId: string): Promise<void> {
  const warnings: RoughCutWarning[] = [];
  await deps.pool.query(`UPDATE rough_cuts SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`, [
    roughCutId,
  ]);

  const cutRes = await deps.pool.query(
    `SELECT id, project_id, folder_id, profile_snapshot FROM rough_cuts WHERE id = $1`,
    [roughCutId]
  );
  const cut = cutRes.rows[0];
  if (!cut) throw new Error('Rough cut not found');
  const profile = profileFromSnapshot(cut.profile_snapshot);

  const videosRes = await deps.pool.query(
    `SELECT v.id, v.title, v.position, v.metadata,
            vv.id AS version_id, vv."versionNumber" AS version_number, vv."versionLabel" AS version_label,
            vv."providerId" AS provider_id, vv."originalUrl" AS original_url,
            vv.duration, vv.frame_rate_num, vv.frame_rate_den, vv.drop_frame, vv.start_timecode
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
     ORDER BY v.position ASC, v.id ASC`,
    [cut.project_id, cut.folder_id]
  );

  if (videosRes.rows.length < 2) {
    throw new Error('A rough cut needs at least two file-backed videos in this folder');
  }

  const tmp = await import('node:fs/promises').then(async (fs) => {
    const { mkdtemp } = fs;
    const { tmpdir } = await import('node:os');
    return mkdtemp(join(tmpdir(), 'of-rough-'));
  });
  const { rm } = await import('node:fs/promises');

  try {
    const wavs: string[] = [];
    const clips: CameraClip[] = [];
    for (const row of videosRes.rows) {
      const wav = join(tmp, `${row.version_id}.wav`);
      await ensureWav(deps, row.version_id, wav);
      wavs.push(wav);
      const metadata =
        typeof row.metadata === 'object' && row.metadata ? (row.metadata as Record<string, unknown>) : {};
      clips.push({
        videoId: row.id,
        versionId: row.version_id,
        title: row.title,
        role: inferCameraRole(row.title, metadataStringRecord(metadata), profile.cameraRoleMetadataKey),
        position: row.position,
        offsetSeconds: 0,
        durationSeconds: typeof row.duration === 'number' ? row.duration : 0,
        frameRateNum: row.frame_rate_num ?? 24,
        frameRateDen: row.frame_rate_den ?? 1,
        dropFrame: Boolean(row.drop_frame),
        startTimecode: row.start_timecode,
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

    let strategy: SyncReport['strategy'] = profile.syncStrategy;
    const syncClips: SyncReport['clips'] = [];
    const timecode = computeTimecodeOffsets(
      clips.map((clip) => ({ versionId: clip.versionId, startTimecode: clip.startTimecode })),
      rate
    );
    const useTimecode = profile.syncStrategy === 'TIMECODE' || (profile.syncStrategy === 'AUTO' && timecode.ok);
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

    const wide = pickWideClip(clips, profile.wideCameraRole);
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
    const diarizeArgs = isDiarizationEnabled()
      ? [diarizeScript, refWav]
      : [diarizeScript, '--vad-only', refWav];
    const diarized = await deps.run('python3', diarizeArgs);
    let rawTurns: Array<{ start: number; end: number; speaker: string }> = [];
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
        const value = await rmsAt(deps, wavs[index]!, Math.max(0, localStart), Math.max(0, localEnd));
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.pool.query(
      `UPDATE rough_cuts SET status = 'FAILED', error = $2, updated_at = NOW() WHERE id = $1`,
      [roughCutId, message]
    );
    throw error;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function fillTranscriptSpeakers(
  deps: AssembleDeps,
  versionId: string
): Promise<void> {
  const tmp = await import('node:fs/promises').then(async (fs) => {
    const { mkdtemp } = fs;
    const { tmpdir } = await import('node:os');
    return mkdtemp(join(tmpdir(), 'of-diar-'));
  });
  const { rm } = await import('node:fs/promises');
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
        const overlap = Math.min(segment.end_sec, turn.end) - Math.max(segment.start_sec, turn.start);
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
