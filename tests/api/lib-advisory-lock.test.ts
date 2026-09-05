// The shared advisory lock helper, against the real database.
//
// Every caller of it runs inside a transaction whose whole purpose is the lock, and none
// of them can see whether the lock was taken: they see the read that follows it, which
// looks identical whether or not anything is serialising it. So the two things worth
// pinning here are that the SQL is valid for a key that is not already a hash — a cuid is
// not hexadecimal, and `('x' || left(<key>, 16))::bit(64)` on one throws — and that a lock
// is actually held afterwards.

import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { lockResourceInTransaction } from '@/lib/advisory-lock';
import { db } from '@/lib/db';

/** Advisory locks held by the connection running this transaction. */
async function advisoryLocksHeld(tx: Prisma.TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ held: number }>>`
    SELECT count(*)::int AS held
    FROM pg_locks
    WHERE locktype = 'advisory' AND pid = pg_backend_pid()
  `;
  return rows[0]?.held ?? 0;
}

/**
 * The advisory locks this connection holds, as `classid:objid:objsubid`.
 *
 * Postgres splits the single bigint `pg_advisory_xact_lock` was given across
 * two `oid` columns — the high 32 bits into `classid`, the low 32 into `objid`
 * — and sets `objsubid` to 1 to mark the one-argument form. So the key that was
 * locked is readable back out of the catalog.
 */
async function advisoryLockKeys(tx: Prisma.TransactionClient): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ key: string }>>`
    SELECT classid::text || ':' || objid::text || ':' || objsubid::text AS key
    FROM pg_locks
    WHERE locktype = 'advisory' AND pid = pg_backend_pid()
  `;
  return rows.map((row) => row.key);
}

describe('lockResourceInTransaction', () => {
  it('locks a resource named by an id that is not hexadecimal', async () => {
    await db.$transaction(async (tx) => {
      expect(await advisoryLocksHeld(tx)).toBe(0);

      await lockResourceInTransaction(tx, 'cmk9zqx7t0000wtqu-burn-in');

      expect(await advisoryLocksHeld(tx)).toBe(1);
    });
  });

  it('takes the lock this key names, not merely some lock', async () => {
    // Counting locks cannot tell the helper apart from one that hashes a
    // constant, hashes the wrong end of the digest, or reads 16 hex digits from
    // the wrong side of it: every one of those holds exactly one lock too. What
    // separates them is which lock.
    await db.$transaction(async (tx) => {
      const key = 'cmk9zqx7t0000wtqu-burn-in';
      await lockResourceInTransaction(tx, key);

      // Written out by hand rather than derived from the helper: md5 of that
      // string begins 8959af13 d963874d, which is 2304356115 then 3647178573.
      expect(await advisoryLockKeys(tx)).toEqual(['2304356115:3647178573:1']);

      // And the same claim as the split itself, so the halves cannot be read
      // the wrong way round without this failing as well. Both halves are above
      // 2^31 here, which is why this slices the bit string rather than shifting
      // a bigint Postgres would treat as negative.
      const rows = await tx.$queryRaw<Array<{ held: number }>>`
        WITH k AS (SELECT ('x' || left(md5(${key}), 16))::bit(64) AS b)
        SELECT count(*)::int AS held
        FROM pg_locks l, k
        WHERE l.locktype = 'advisory'
          AND l.pid = pg_backend_pid()
          AND l.classid = substring(k.b from 1 for 32)::bit(32)::bigint
          AND l.objid = substring(k.b from 33 for 32)::bit(32)::bigint
      `;
      expect(rows[0]?.held).toBe(1);
    });
  });

  it('gives two different keys two different locks', async () => {
    await db.$transaction(async (tx) => {
      await lockResourceInTransaction(tx, 'version-one');
      await lockResourceInTransaction(tx, 'version-two');

      // One lock apiece: a helper that hashed anything other than the key it was given
      // would hand both callers the same lock and make every second writer wait.
      expect(await advisoryLocksHeld(tx)).toBe(2);
    });
  });
});
