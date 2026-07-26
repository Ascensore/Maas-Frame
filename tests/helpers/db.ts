// Test-database lifecycle helpers.
//
// Importing this module imports `@/lib/db`, which reads DATABASE_URL at module
// load. Anything that imports this must have loaded `tests/helpers/env.ts`
// first; `tests/setup/api.ts` does exactly that.

import { db } from '@/lib/db';

// Prisma owns this table and emptying it would make `prisma db push` believe the
// database has never been set up.
const PRESERVED_TABLES = new Set(['_prisma_migrations']);

let cachedTableNames: string[] | null = null;
let cachedResetStatement: string | null = null;

/**
 * Every base table in the `public` schema, read from `information_schema` so
 * the list can never drift out of sync with `prisma/schema.prisma`. A model
 * added tomorrow is emptied tomorrow, with no edit here.
 */
export async function listResettableTables(): Promise<string[]> {
  if (cachedTableNames) return cachedTableNames;

  const rows = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;

  const names = rows.map((row) => row.table_name).filter((name) => !PRESERVED_TABLES.has(name));

  if (names.length === 0) {
    throw new Error(
      'resetDb() found no tables in the public schema. The test database was ' +
        'probably never migrated. Check that tests/setup/db-global.ts ran ' +
        '`prisma db push` against DATABASE_URL.'
    );
  }

  cachedTableNames = names;
  return names;
}

/**
 * Builds the single statement that empties the database.
 *
 * Two decisions worth explaining, because the obvious implementation is both
 * slower and wrong:
 *
 *  - DELETE, not TRUNCATE. `TRUNCATE` rewrites the relation file for every
 *    table and every index, which measured at ~36ms per call against this
 *    container even with fsync off and the data directory on tmpfs. Across a
 *    suite that resets after every test that is most of the runtime. The
 *    equivalent DELETE costs ~3ms.
 *
 *  - One statement, via data-modifying CTEs, rather than one DELETE per table.
 *    Prisma's foreign keys are NOT DEFERRABLE, so a sequence of separate
 *    DELETEs has to run in child-before-parent order or it trips a constraint.
 *    Inside a single statement the FK triggers all fire after the whole
 *    statement has run, by which point every row is already gone, so no
 *    ordering is needed and a newly added table cannot break the order.
 *
 * The trailing `setval` calls stand in for TRUNCATE's `RESTART IDENTITY`, so a
 * test can still rely on `rate_limits.id` starting from 1.
 */
async function buildResetStatement(): Promise<string> {
  if (cachedResetStatement) return cachedResetStatement;

  const tables = await listResettableTables();
  const sequences = await db.$queryRaw<Array<{ sequence_name: string }>>`
    SELECT sequence_name
    FROM information_schema.sequences
    WHERE sequence_schema = 'public'
    ORDER BY sequence_name
  `;

  const deletes = tables
    .map((table, index) => `"d${index}" AS (DELETE FROM "public"."${table}")`)
    .join(', ');

  const projection =
    sequences.length > 0
      ? sequences.map((row) => `setval('"public"."${row.sequence_name}"', 1, false)`).join(', ')
      : '1';

  cachedResetStatement = `WITH ${deletes} SELECT ${projection}`;
  return cachedResetStatement;
}

/**
 * Empties the test database. Registered as `afterEach` in tests/setup/api.ts,
 * so every test starts from zero rows and no test may depend on another test's
 * data or on file execution order.
 */
export async function resetDb(): Promise<void> {
  await db.$executeRawUnsafe(await buildResetStatement());
}

/** Row count for a table, for assertions like "nothing was written". */
export async function countRows(table: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM "public"."${table}"`
  );
  return Number(rows[0]?.count ?? 0);
}

export { db };
