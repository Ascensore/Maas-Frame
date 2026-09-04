/**
 * How the media worker takes PENDING jobs off the table.
 *
 * Kept out of worker/src so the one predicate that decides whether a parked
 * job is republished (an assemble waiting on a transcript carries `run_after`
 * in the future) can be tested against a real database. The worker image
 * copies this file next to its own sources.
 */

export const MEDIA_JOB_PUBLISH_BATCH = 20;

export type PublishableMediaJob = {
  id: string;
  kind: string;
  versionId: string;
  payload: unknown;
};

/** The slice of a pg client the claim needs. In the worker this is a transaction-bound client. */
export type MediaJobQueryClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

/**
 * Lock the oldest PENDING jobs that are due, mark them QUEUED and return them.
 * A job whose `run_after` is still in the future stays PENDING and invisible
 * to the caller until that time passes. Run this inside a transaction: the
 * SKIP LOCKED is what keeps two workers from claiming the same rows.
 */
export async function claimDueMediaJobs(
  client: MediaJobQueryClient,
  limit: number = MEDIA_JOB_PUBLISH_BATCH
): Promise<PublishableMediaJob[]> {
  const result = await client.query(
    `SELECT id, kind, version_id, payload
     FROM media_jobs
     WHERE status = 'PENDING'
       AND (run_after IS NULL OR run_after <= NOW())
     ORDER BY created_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT $1`,
    [limit]
  );
  const jobs: PublishableMediaJob[] = result.rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    versionId: String(row.version_id),
    payload: row.payload,
  }));
  for (const job of jobs) {
    await client.query(
      `UPDATE media_jobs SET status = 'QUEUED', updated_at = NOW() WHERE id = $1`,
      [job.id]
    );
  }
  return jobs;
}
