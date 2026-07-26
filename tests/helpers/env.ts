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

import fs from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

/**
 * Walks up from the working directory until it finds the checkout.
 *
 * This deliberately avoids `import.meta.url`, which would be the obvious way to
 * resolve a path relative to this file: Playwright transpiles TypeScript to
 * CommonJS unless package.json declares `"type": "module"`, and in CommonJS
 * `import.meta` is a *syntax* error, so the e2e suite could not import this
 * module at all. `__dirname` has the mirror-image problem under Vitest's ESM.
 *
 * The marker is prisma/schema.prisma as well as package.json, so a stray
 * package.json inside node_modules cannot be mistaken for the checkout.
 */
function findRepoRoot(): string {
  let current = path.resolve(process.cwd());

  for (;;) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      fs.existsSync(path.join(current, 'prisma', 'schema.prisma'))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not locate the OpenFrame checkout from ${process.cwd()}: no ancestor ` +
          'directory holds both package.json and prisma/schema.prisma. Run the test ' +
          'suites from the repository root.'
      );
    }
    current = parent;
  }
}

export const REPO_ROOT = findRepoRoot();

export const TEST_ENV_PATH = path.join(REPO_ROOT, '.env.test');

let loaded = false;

export function loadTestEnv(): void {
  if (loaded) return;
  loaded = true;

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

  // Vitest sets this already, but db-global.ts also spawns the Prisma CLI and
  // lib/rate-limit.ts throws when DISABLE_RATE_LIMIT is set in production.
  // @types/node declares NODE_ENV as read-only, hence the cast.
  if (!process.env.NODE_ENV) {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
  }
}

loadTestEnv();
