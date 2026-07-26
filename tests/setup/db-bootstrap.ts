/**
 * Builds the test database schema outside of Vitest.
 *
 * The `api` Vitest project gets this for free through its globalSetup, but the
 * end-to-end suite runs the real app against the same database and needs the
 * schema in place before the server starts. Both paths therefore call the same
 * setup function, so there is exactly one description of how a test database is
 * built (including why it uses `prisma db push` rather than `migrate deploy`,
 * which is documented at the top of db-global.ts).
 *
 * This lives under tests/ rather than scripts/ because the production image
 * ignores tests/ entirely, and a script that imports from it would break the
 * typecheck that runs before every build.
 *
 * Usage: bun run test:db:bootstrap
 */
import { setup } from './db-global';

setup()
  .then(() => {
    console.log('Test database schema is ready');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
