import type { Prisma } from '@prisma/client';

/**
 * Serialise concurrent writers on one resource for the rest of the transaction.
 *
 * Postgres releases a transaction-level advisory lock at commit or rollback, so there is
 * nothing to unlock and a crashed request cannot strand it. The key is any string: it is
 * hashed to the bigint the lock function takes, which is what lets a cuid name a lock.
 *
 * Three rules come with it, and all of them matter at every call site:
 *
 *  - `tx` has to be the transaction client of an interactive `db.$transaction(async (tx)
 *    => ...)`, and everything the lock protects has to run inside that callback. Passing
 *    `db` itself compiles — `PrismaClient` is structurally assignable to
 *    `Prisma.TransactionClient` — and it does take the lock, in the implicit
 *    single-statement transaction the `$executeRaw` runs in, which commits the instant
 *    the statement returns. The call succeeds, nothing is serialised, and the race the
 *    lock was added for is still there, so this is worth checking rather than assuming.
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
