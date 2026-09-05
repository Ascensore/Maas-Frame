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

describe('lockResourceInTransaction', () => {
  it('locks a resource named by an id that is not hexadecimal', async () => {
    await db.$transaction(async (tx) => {
      expect(await advisoryLocksHeld(tx)).toBe(0);

      await lockResourceInTransaction(tx, 'cmk9zqx7t0000wtqu-burn-in');

      expect(await advisoryLocksHeld(tx)).toBe(1);
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
