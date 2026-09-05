import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { shortFormBatchConfigSchema, planShortFormCandidates } from './index';
import { reliableFaceCoverage, smoothFaceTrack, type FaceSample } from './crop';

export type AnalyzeShortFormDeps = {
  pool: Pool;
  run: (
    command: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  downloadVersionMedia: (
    version: { providerId: string; videoId: string; originalUrl: string },
    dest: string
  ) => Promise<void>;
  scriptDir: string;
  visualPython?: string;
};

function parseHelperJson(stdout: string): {
  sceneCuts?: number[];
  faces?: FaceSample[];
  faceCoverage?: Array<{ start: number; end: number; confidence: number }>;
} {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Visual analyzer returned no JSON');
  return JSON.parse(stdout.slice(start, end + 1)) as ReturnType<typeof parseHelperJson>;
}

export async function analyzeShortFormBatch(
  deps: AnalyzeShortFormDeps,
  batchId: string
): Promise<void> {
  const startedAt = Date.now();
  const batchRes = await deps.pool.query(
    `SELECT b.id, b.status, b.config, b.warnings, b.source_version_id,
            vv."providerId", vv."videoId", vv."originalUrl"
     FROM short_form_batches b
     JOIN video_versions vv ON vv.id = b.source_version_id
     WHERE b.id = $1`,
    [batchId]
  );
  const batch = batchRes.rows[0];
  if (!batch) throw new Error('Short-form batch not found');
  const ready = await deps.pool.query(
    `SELECT 1 FROM short_form_candidates WHERE batch_id = $1 LIMIT 1`,
    [batchId]
  );
  if (['READY', 'RANKING'].includes(String(batch.status)) && ready.rows[0]) return;
  const config = shortFormBatchConfigSchema.parse(batch.config);
  await deps.pool.query(
    `UPDATE short_form_batches SET status = 'ANALYZING', error = NULL, updated_at = NOW() WHERE id = $1`,
    [batchId]
  );

  const transcriptRes = await deps.pool.query(
    `SELECT ts.start_sec, ts.end_sec, ts.text, ts.words
     FROM transcripts t
     JOIN transcript_segments ts ON ts.transcript_id = t.id
     WHERE t.version_id = $1 AND t.status = 'READY'
       AND t.created_at = (SELECT MIN(t2.created_at) FROM transcripts t2 WHERE t2.version_id = $1 AND t2.status = 'READY')
     ORDER BY ts.position ASC`,
    [batch.source_version_id]
  );
  if (transcriptRes.rows.length === 0) {
    await deps.pool.query(
      `UPDATE short_form_batches SET status = 'FAILED', error = $2, updated_at = NOW() WHERE id = $1`,
      [batchId, 'The rendered rough cut has no ready transcript']
    );
    throw new Error('The rendered rough cut has no ready transcript');
  }
  const transcript = transcriptRes.rows.map((row) => ({
    start: Number(row.start_sec),
    end: Number(row.end_sec),
    text: String(row.text ?? ''),
    words: Array.isArray(row.words) ? row.words : undefined,
  }));

  const warnings = Array.isArray(batch.warnings) ? [...batch.warnings.map(String)] : [];
  let evidence: ReturnType<typeof parseHelperJson> = {};
  const dir = await mkdtemp(join(tmpdir(), 'of-shorts-'));
  try {
    const sourcePath = join(dir, 'source.mp4');
    try {
      await deps.downloadVersionMedia(
        {
          providerId: String(batch.providerId),
          videoId: String(batch.videoId),
          originalUrl: String(batch.originalUrl),
        },
        sourcePath
      );
      const visual = await deps.run(deps.visualPython ?? 'python3', [
        join(deps.scriptDir, 'short_form_analyze.py'),
        sourcePath,
        '--fps',
        '5',
      ]);
      if (visual.code !== 0) throw new Error(visual.stderr || 'visual analysis failed');
      evidence = parseHelperJson(visual.stdout);
    } catch (error) {
      warnings.push(
        `Visual analysis unavailable; centered padded crops will be used (${error instanceof Error ? error.message : String(error)}).`
      );
    }

    await deps.pool.query(
      `UPDATE short_form_batches SET status = 'RANKING', updated_at = NOW() WHERE id = $1`,
      [batchId]
    );
    const planned = planShortFormCandidates({ transcript, evidence, config });
    warnings.push(...planned.warnings);
    const speechRanges = transcript.flatMap((segment) =>
      segment.words?.length
        ? segment.words.map((word: { start: number; end: number }) => ({
            start: word.start,
            end: word.end,
          }))
        : [{ start: segment.start, end: segment.end }]
    );
    const track = smoothFaceTrack(evidence.faces ?? [], { speechRanges });
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM short_form_candidates WHERE batch_id = $1 AND output_video_id IS NULL`,
        [batchId]
      );
      let paddedFallbackCount = 0;
      for (let index = 0; index < planned.candidates.length; index += 1) {
        const candidate = planned.candidates[index]!;
        const candidateTrack = track
          .filter((point) => point.time >= candidate.start && point.time <= candidate.end)
          .map((point) => ({ ...point, time: point.time - candidate.start }));
        const reliableTrack =
          candidateTrack.length > 1 &&
          reliableFaceCoverage(evidence.faceCoverage ?? [], candidate.start, candidate.end) >= 0.5;
        if (!reliableTrack) paddedFallbackCount += 1;
        await client.query(
          `INSERT INTO short_form_candidates
             (id, batch_id, rank, source_start_sec, source_end_sec, score, scores, rationale,
              title, social_caption, hashtags, crop_mode, crop_track, caption_style, status,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb,
                   $12::"ShortFormCropMode", $13::jsonb, $14::jsonb, 'PROPOSED', NOW(), NOW())`,
          [
            randomUUID(),
            batchId,
            index + 1,
            candidate.start,
            candidate.end,
            candidate.scores.total,
            JSON.stringify(candidate.scores),
            candidate.rationale,
            candidate.title,
            candidate.socialCaption,
            JSON.stringify(candidate.hashtags),
            reliableTrack ? 'AUTO' : 'PADDED',
            reliableTrack ? JSON.stringify(candidateTrack) : null,
            JSON.stringify(config.captionStyle),
          ]
        );
      }
      if (paddedFallbackCount > 0) {
        warnings.push(
          `${paddedFallbackCount} candidate${paddedFallbackCount === 1 ? '' : 's'} use centered padding because reliable face coverage was too low.`
        );
      }
      const agentsEnabled = ['1', 'true', 'yes', 'on'].includes(
        (process.env.OPENFRAME_ENABLE_AGENTS ?? '').trim().toLowerCase()
      );
      const willRerank = config.useAi && agentsEnabled;
      await client.query(
        `UPDATE short_form_batches
         SET status = $3::"ShortFormBatchStatus", warnings = $2::jsonb, error = NULL, updated_at = NOW()
         WHERE id = $1`,
        [batchId, JSON.stringify(warnings), willRerank ? 'RANKING' : 'READY']
      );
      if (willRerank) {
        const agent = await client.query(
          `INSERT INTO agent_runs
             (id, version_id, kind, agent_slug, status, model, triggered_by_id, payload,
              attempts, created_at, updated_at)
           SELECT gen_random_uuid()::text, source_version_id, 'SHORTS', 'short-form-ranker',
                  'PENDING', $2, requested_by_id, jsonb_build_object('batchId', id), 0, NOW(), NOW()
           FROM short_form_batches WHERE id = $1 RETURNING id`,
          [batchId, (process.env.OPENFRAME_AGENT_MODEL ?? '').trim() || 'mock']
        );
        if (agent.rows[0]?.id) {
          await client.query(`UPDATE short_form_batches SET agent_run_id = $2 WHERE id = $1`, [
            batchId,
            agent.rows[0].id,
          ]);
        }
      }
      await client.query('COMMIT');
      const covered = (evidence.faceCoverage ?? []).filter((entry) => entry.confidence >= 0.35);
      console.info(
        JSON.stringify({
          event: 'short_form_analysis_complete',
          batchId,
          localVisualPath: evidence.faces?.length ? 'mediapipe' : 'padded-fallback',
          candidateCount: planned.candidates.length,
          faceCoverage:
            (evidence.faceCoverage?.length ?? 0) > 0
              ? covered.length / evidence.faceCoverage!.length
              : 0,
          durationMs: Date.now() - startedAt,
          warningCount: warnings.length,
        })
      );
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    await deps.pool.query(
      `UPDATE short_form_batches SET status = 'FAILED', error = $2, updated_at = NOW() WHERE id = $1`,
      [batchId, error instanceof Error ? error.message : String(error)]
    );
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
