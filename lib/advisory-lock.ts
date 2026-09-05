import type { Prisma } from '@prisma/client';

/**
 * Serialise concurrent writers on one resource for the rest of the transaction.
 *
 * Postgres releases a transaction-level advisory lock at commit or rollback, so there is
 * nothing to unlock and a crashed request cannot strand it. The key is any string: it is
 * hashed to the bigint the lock function takes, which is what lets a cuid name a lock.
 *
 * Two rules come with it, and both matter at every call site:
 *
 *  - Whatever the lock protects has to be *read* after it is taken. Reading first and
 *    locking afterwards is the race the lock was supposed to close.
 *  - This database runs READ COMMITTED, where a statement taken after the lock sees the
 *    other transaction's committed rows. Under SERIALIZABLE the snapshot would predate
 *    the lock and both callers would see an empty result.
 *
 * `$executeRaw` rather than `$queryRaw`: pg_advisory_xact_lock returns void, which Prisma
 * cannot deserialize as a column.
 */
export async function lockResourceInTransaction(
  tx: Prisma.TransactionClient,
  key: string
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      ('x' || left(md5(${key}), 16))::bit(64)::bigint
    )
  `;
}
