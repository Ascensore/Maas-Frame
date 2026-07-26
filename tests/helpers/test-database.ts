// Guard that keeps the test suites off a real database.
//
// This is deliberately a separate, side-effect-free module rather than part of
// helpers/env.ts: importing that one loads .env.test and throws when
// DATABASE_URL is missing, which a unit test cannot exercise.

/**
 * A database name that identifies a disposable test database.
 *
 * `test` has to be its own `_`/`-` delimited segment, so `openframe_test` and
 * `openframe_test_api` (the per-suite databases the parallel api runs use) are
 * accepted while `openframe` is not.
 */
const TEST_DATABASE_NAME = /(^|[_-])test([_-]|$)/i;

/**
 * Throws unless `url` names a test database.
 *
 * The reason this exists: bun loads a plain `.env` into `process.env` on its
 * own, so anything that reaches the test setup outside Vitest, such as
 * `bun run test:db:bootstrap`, inherits the DATABASE_URL of whatever deployment
 * `.env` happens to describe when `.env.test` is absent. tests/setup/db-global.ts
 * then builds the schema with `prisma db push --accept-data-loss`, and the api
 * suites truncate every table between tests. Neither is something you want
 * pointed at a database holding real rows, and the failure is silent: the
 * bootstrap prints its usual success line either way.
 *
 * CI is unaffected because it exports DATABASE_URL for a service container
 * named openframe_test.
 */
export function assertTestDatabase(url: string): void {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      'DATABASE_URL is not a valid connection string, so there is no way to ' +
        'tell whether it points at a test database. Refusing to continue.'
    );
  }

  const name = decodeURIComponent(parsed.pathname).replace(/^\//, '');

  if (TEST_DATABASE_NAME.test(name)) return;

  throw new Error(
    `Refusing to run the test setup against database "${name}" on ` +
      `${parsed.hostname}: the name does not mark it as a test database.\n\n` +
      'The setup builds the schema with `prisma db push --accept-data-loss` ' +
      'and the api suites truncate every table, so this would destroy real ' +
      'data.\n\n' +
      'A test database is one whose name carries a `test` segment, for ' +
      'example openframe_test or openframe_test_api.\n\n' +
      'The usual cause is a missing .env.test, which leaves DATABASE_URL to be ' +
      'inherited from .env: cp .env.test.example .env.test'
  );
}
