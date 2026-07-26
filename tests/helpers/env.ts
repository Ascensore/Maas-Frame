// Loads `.env.test` into `process.env`.
//
// This module exists so it can be the *first* import of both
// `tests/setup/api.ts` and `tests/setup/db-global.ts`. ESM evaluates imports in
// source order, so putting `import '../helpers/env';` above everything else
// guarantees DATABASE_URL is set before `@/lib/db` is reached: that module reads
// `process.env.DATABASE_URL` once at import time and memoizes the pg pool on
// `globalThis`, so a late load would silently point every test at the wrong
// database (or at no database at all).
//
// It must therefore never import from `@/lib/*`.
//
// Contract: an already-exported variable always wins. `.env.test` fills the
// gaps. That is what lets CI export DATABASE_URL for a service container
// without needing a `.env.test` file at all.
//
// With one correction, see forgetAutoloadedDotenv in helpers/dev-env.ts: bun
// populates process.env from a plain `.env` before any of this runs, which the
// contract above would otherwise read as a deliberate export.

import fs from 'node:fs';
import { config as loadDotenv } from 'dotenv';

import { forgetAutoloadedDotenv, REPO_ROOT, TEST_ENV_PATH } from './dev-env';
import { assertTestDatabase } from './test-database';

export { REPO_ROOT, TEST_ENV_PATH };

let loaded = false;

export function loadTestEnv(): void {
  if (loaded) return;
  loaded = true;

  forgetAutoloadedDotenv();

  if (fs.existsSync(TEST_ENV_PATH)) {
    loadDotenv({ path: TEST_ENV_PATH, quiet: true });
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set for the api test project. Either create .env.test ' +
        '(cp .env.test.example .env.test) or export DATABASE_URL before running ' +
        'bun run test:api.'
    );
  }

  // Deliberately after the file load and before anything opens a pool: this is
  // the one place every path into the test setup goes through.
  assertTestDatabase(process.env.DATABASE_URL);

  // Vitest sets this already, but db-global.ts also spawns the Prisma CLI and
  // lib/rate-limit.ts throws when DISABLE_RATE_LIMIT is set in production.
  // @types/node declares NODE_ENV as read-only, hence the cast.
  if (!process.env.NODE_ENV) {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
  }
}

loadTestEnv();
