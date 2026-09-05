import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeShortFormBatch, type AnalyzeShortFormDeps } from '@/lib/short-form/analyze-job';
import { shortFormBatchConfigSchema } from '@/lib/short-form';

type Query = { sql: string; params: unknown[] };

function transcriptRows() {
  return Array.from({ length: 24 }, (_, index) => {
    const start = index * 5;
    const text = `A useful complete idea number ${index}.`;
    return {
      start_sec: start,
      end_sec: start + 4,
      text,
      words: text.split(' ').map((word, wordIndex) => ({
        start: start + wordIndex * 0.6,
        end: start + wordIndex * 0.6 + 0.5,
        text: word,
      })),
    };
  });
}

function harness(options: {
  useAi: boolean;
  visualCode?: number;
  status?: string;
  existingCandidate?: boolean;
  visual?: Record<string, unknown>;
}) {
  const queries: Query[] = [];
  const runs: string[][] = [];
  const config = shortFormBatchConfigSchema.parse({ count: 5, useAi: options.useAi });
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('FROM short_form_batches b')) {
      return {
        rows: [
          {
            id: 'batch-1',
            status: options.status ?? 'PENDING',
            config,
            warnings: [],
            source_version_id: 'source-1',
            providerId: 'r2',
            videoId: 'videos/source.mp4',
            originalUrl: '/api/upload/video/source.mp4',
          },
        ],
      };
    }
    if (sql.includes('SELECT 1 FROM short_form_candidates')) {
      return { rows: options.existingCandidate ? [{ exists: 1 }] : [] };
    }
    if (sql.includes('FROM transcripts t')) return { rows: transcriptRows() };
    if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'agent-1' }] };
    return { rows: [] };
  };
  const downloadVersionMedia = vi.fn<AnalyzeShortFormDeps['downloadVersionMedia']>(async () => {});
  const deps: AnalyzeShortFormDeps = {
    pool: {
      query,
      connect: async () => ({ query, release: () => {} }),
    } as unknown as Pool,
    run: async (_command, args) => {
      runs.push(args);
      return options.visualCode
        ? { stdout: '', stderr: 'face model unavailable', code: options.visualCode }
        : {
            stdout: JSON.stringify(
              options.visual ?? { sceneCuts: [], faces: [], faceCoverage: [] }
            ),
            stderr: '',
            code: 0,
          };
    },
    downloadVersionMedia,
    scriptDir: '/worker',
  };
  return { deps, queries, runs, downloadVersionMedia };
}

describe('analyzeShortFormBatch', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates deterministic candidates first and leaves an enabled AI batch ranking', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');
    vi.stubEnv('OPENFRAME_AGENT_MODEL', 'openai/gpt-5-mini');
    const h = harness({ useAi: true });

    await analyzeShortFormBatch(h.deps, 'batch-1');

    expect(h.runs[0]).toEqual(['/worker/short_form_analyze.py', expect.any(String), '--fps', '5']);
    const inserts = h.queries.filter((entry) =>
      entry.sql.includes('INSERT INTO short_form_candidates')
    );
    expect(inserts).toHaveLength(5);
    expect(inserts.every((entry) => entry.params[11] === 'PADDED')).toBe(true);
    const ready = h.queries.find((entry) => entry.sql.includes('SET status = $3'));
    expect(ready?.params[2]).toBe('RANKING');
    expect(String(ready?.params[1])).toContain('reliable face coverage was too low');
    expect(h.queries.some((entry) => entry.sql.includes('INSERT INTO agent_runs'))).toBe(true);
    expect(h.queries.find((entry) => entry.sql.includes('SET agent_run_id = $2'))?.params).toEqual([
      'batch-1',
      'agent-1',
    ]);
    expect(h.queries.map((entry) => entry.sql.trim())).toContain('COMMIT');
  });

  it('stores smoothed automatic crop tracks when local face coverage is reliable', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'false');
    const faces = Array.from({ length: 601 }, (_, sample) => ({
      time: sample / 5,
      x: sample % 3 === 2 ? 0.8 : sample % 3 === 1 ? 0.12 : 0.1,
      y: 0.2,
      width: 0.25,
      height: 0.35,
      confidence: 0.95,
      mouthMotion: 0.5,
      scene: 0,
    }));
    const h = harness({
      useAi: false,
      visual: {
        sceneCuts: [],
        faces,
        faceCoverage: [{ start: 0, end: 120, confidence: 0.95 }],
      },
    });

    await analyzeShortFormBatch(h.deps, 'batch-1');

    const inserts = h.queries.filter((entry) =>
      entry.sql.includes('INSERT INTO short_form_candidates')
    );
    expect(inserts).toHaveLength(5);
    expect(inserts.every((entry) => entry.params[11] === 'AUTO')).toBe(true);
    let observedDeadZone = false;
    let observedBoundedPan = false;
    for (const entry of inserts) {
      const track = JSON.parse(String(entry.params[12])) as Array<{ time: number; x: number }>;
      expect(track.length).toBeGreaterThan(1);
      expect(track[0]!.time).toBeGreaterThanOrEqual(0);
      expect(track.at(-1)!.time).toBeLessThanOrEqual(
        Number(entry.params[4]) - Number(entry.params[3])
      );
      for (let index = 1; index < track.length; index += 1) {
        const previous = track[index - 1]!;
        const current = track[index]!;
        const elapsed = current.time - previous.time;
        const movement = Math.abs(current.x - previous.x);
        expect(movement).toBeLessThanOrEqual(0.35 * elapsed + 1e-8);
        if (movement < 1e-8) observedDeadZone = true;
        if (Math.abs(movement - 0.35 * elapsed) < 1e-8) observedBoundedPan = true;
      }
    }
    expect(observedDeadZone).toBe(true);
    expect(observedBoundedPan).toBe(true);
  });

  it('falls back to deterministic padded candidates without failing visual analysis', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'false');
    const h = harness({ useAi: false, visualCode: 2 });

    await analyzeShortFormBatch(h.deps, 'batch-1');

    const ready = h.queries.find((entry) => entry.sql.includes('SET status = $3'));
    expect(ready?.params[2]).toBe('READY');
    expect(String(ready?.params[1])).toContain('Visual analysis unavailable');
    expect(String(ready?.params[1])).toContain('centered padding');
    expect(h.queries.some((entry) => entry.sql.includes('INSERT INTO agent_runs'))).toBe(false);
  });

  it('returns without downloading or replacing candidates after a completed retry', async () => {
    const h = harness({ useAi: false, status: 'READY', existingCandidate: true });

    await analyzeShortFormBatch(h.deps, 'batch-1');

    expect(h.downloadVersionMedia).not.toHaveBeenCalled();
    expect(h.runs).toEqual([]);
    expect(h.queries).toHaveLength(2);
    expect(
      h.queries.some(
        (entry) =>
          entry.sql.includes('DELETE FROM short_form_candidates') ||
          entry.sql.includes('INSERT INTO short_form_candidates')
      )
    ).toBe(false);
  });
});
