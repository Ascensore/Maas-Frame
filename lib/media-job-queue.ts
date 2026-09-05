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

/**
 * A kind this worker has no queue for, which in practice means the image is
 * older than the app that queued the job. Its own class so `publishClaimedJobs`
 * can tell it from a queue that is down; the two want opposite responses.
 */
export class UnknownJobKindError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(`Unknown job kind ${kind}`);
    this.name = 'UnknownJobKindError';
    this.kind = kind;
  }
}

/**
 * Hand every claimed job to the queue, putting back the ones it would not take.
 *
 * `claimDueMediaJobs` has already committed the whole batch as QUEUED, and
 * nothing anywhere moves a QUEUED row back on its own, so giving up part way
 * through strands every job after the failing one for good. That is the right
 * trade for a queue that is down — the next tick has nothing to publish to
 * either — and the wrong one for a kind this image simply does not know: a
 * single burn-in queued by a newer app would otherwise stop the probes,
 * transcriptions and proxies behind it until the worker is rebuilt. So an
 * unknown kind is released, logged and skipped, and every other failure still
 * stops the batch.
 *
 * The released job goes back to PENDING and is claimed again on a later tick,
 * which keeps it waiting for the rebuild rather than losing it.
 */
export async function publishClaimedJobs(
  jobs: PublishableMediaJob[],
  send: (job: PublishableMediaJob) => Promise<void>,
  releaseToPending: (jobId: string) => Promise<void>
): Promise<void> {
  for (const job of jobs) {
    try {
      await send(job);
    } catch (error) {
      await releaseToPending(job.id);
      if (error instanceof UnknownJobKindError) {
        console.error(
          `media job ${job.id} has kind ${job.kind}, which this worker has no queue for: ` +
            'the worker image is out of date. The job stays PENDING until it is rebuilt.'
        );
        continue;
      }
      throw error;
    }
  }
}
