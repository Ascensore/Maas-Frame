// Runs once, in the Playwright main process, before the web server starts.
//
// Never import from '@playwright/test' here: globalSetup runs outside the test
// context, and importing the runner would pull in a second copy of it.

// MUST stay the first import: it loads .env.test, and everything below reads
// process.env.DATABASE_URL.
import '../helpers/env';

import { Pool } from 'pg';
import { setup as bootstrapSchema } from '../setup/db-global';

/**
 * The rate limiter is Postgres-backed and keyed on the client IP, which is the
 * same loopback address for every worker and for every run on this machine. Two
 * consecutive suite runs would therefore share one window, and `register` allows
 * five requests per hour. Clearing the table is what makes "green twice in a
 * row" mean the same thing as "green once".
 *
 * It cannot be switched off instead: lib/rate-limit.ts throws on import when
 * DISABLE_RATE_LIMIT is set and NODE_ENV is production, and the app under test
 * is a production build.
 */
async function clearRateLimits(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM rate_limits');
}

export default async function globalSetup(): Promise<void> {
  // Same bootstrap the api suite's globalSetup uses, so there is exactly one
  // description of how a test database is built. It is idempotent: on a database
  // that already has the schema it is a no-op `prisma db push`.
  await bootstrapSchema();

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', () => {});

  try {
    await clearRateLimits(pool);
  } finally {
    await pool.end();
  }
}
