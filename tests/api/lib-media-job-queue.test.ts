// Exercises lib/media-job-queue.ts against the real test database.
//
// The worker's publish loop cannot be imported from tests, so the one
// predicate that decides whether a parked job is republished lives in lib and
// is proven here: a PENDING job whose run_after is still in the future must
// stay invisible and PENDING, while everything due comes back oldest first and
// flips to QUEUED. Without the predicate an assemble job waiting on a
// transcript would be republished on every two-second poll.

import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { claimDueMediaJobs } from '@/lib/media-job-queue';
import { seedVersion } from '../factories';

let client: Client;

beforeEach(async () => {
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
});

afterEach(async () => {
  await client.end();
});

async function claimInTransaction(limit?: number) {
  await client.query('BEGIN');
  try {
    const jobs = await claimDueMediaJobs(client, limit);
    await client.query('COMMIT');
    return jobs;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function statusesOf(ids: string[]): Promise<Record<string, string>> {
  const rows = await db.mediaJob.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true },
  });
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

describe('claimDueMediaJobs', () => {
  it('leaves a job parked in the future alone and queues the due ones oldest first', async () => {
    const { version } = await seedVersion();
    const base = Date.now();
    const parked = await db.mediaJob.create({
      data: {
        versionId: version.id,
        kind: 'ASSEMBLE_ROUGH_CUT',
        payload: { roughCutId: 'cut-parked' },
        runAfter: new Date(base + 60 * 60 * 1000),
        createdAt: new Date(base - 3000),
      },
    });
    const due = await db.mediaJob.create({
      data: {
        versionId: version.id,
        kind: 'ASSEMBLE_ROUGH_CUT',
        payload: { roughCutId: 'cut-due' },
        runAfter: new Date(base - 60 * 1000),
        createdAt: new Date(base - 2000),
      },
    });
    const immediate = await db.mediaJob.create({
      data: { versionId: version.id, kind: 'PROBE_MEDIA', createdAt: new Date(base - 1000) },
    });

    const jobs = await claimInTransaction();

    expect(jobs).toEqual([
      {
        id: due.id,
        kind: 'ASSEMBLE_ROUGH_CUT',
        versionId: version.id,
        payload: { roughCutId: 'cut-due' },
      },
      { id: immediate.id, kind: 'PROBE_MEDIA', versionId: version.id, payload: null },
    ]);
    expect(await statusesOf([parked.id, due.id, immediate.id])).toEqual({
      [parked.id]: 'PENDING',
      [due.id]: 'QUEUED',
      [immediate.id]: 'QUEUED',
    });

    // Nothing is due any more: the claimed rows are QUEUED and the parked one
    // is still in the future, so a second pass must find nothing.
    expect(await claimInTransaction()).toEqual([]);
  });

  it('claims at most the batch size, oldest first', async () => {
    const { version } = await seedVersion();
    const base = Date.now();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const job = await db.mediaJob.create({
        data: {
          versionId: version.id,
          kind: 'EXTRACT_AUDIO',
          createdAt: new Date(base - (3 - index) * 1000),
        },
      });
      ids.push(job.id);
    }

    const jobs = await claimInTransaction(2);

    expect(jobs.map((job) => job.id)).toEqual([ids[0], ids[1]]);
    expect(await statusesOf(ids)).toEqual({
      [ids[0]!]: 'QUEUED',
      [ids[1]!]: 'QUEUED',
      [ids[2]!]: 'PENDING',
    });
  });
});
