// Locating the checkout, and undoing bun's automatic `.env` load.
//
// Split out of helpers/env.ts so it can be imported without side effects.
// Importing that module loads all of `.env.test` into process.env, which
// playwright.config.ts must not do: the file carries DISABLE_RATE_LIMIT for the
// api suites, and `next build` runs in production mode, where lib/rate-limit.ts
// refuses to start with that set.

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';

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

/**
 * The env files a developer machine has and CI does not.
 *
 * bun autoloads these, and so does @next/env inside `next build` and
 * `next start`, which is why both halves of the problem below need the same
 * list. `.env.test` is deliberately absent: that one is the test configuration.
 */
const DEV_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

function readDevEnv(): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const file of DEV_ENV_FILES) {
    const filePath = path.join(REPO_ROOT, file);
    if (!fs.existsSync(filePath)) continue;
    Object.assign(merged, parseDotenv(fs.readFileSync(filePath)));
  }

  return merged;
}

/**
 * Removes the values bun copied out of a plain `.env` on start-up.
 *
 * bun reads `.env` into process.env before the first line of a script runs, and
 * nothing downstream can tell that apart from `DATABASE_URL=… bun run test:api`.
 * Under the "an already-exported variable wins" contract the development `.env`
 * therefore beat `.env.test` outright, which pointed the api suites at whatever
 * deployment `.env` describes: `prisma db push --accept-data-loss` for the
 * schema, then a truncate of every table between tests. The same values reached
 * the app the e2e suite builds, R2 credentials included.
 *
 * Only entries whose current value is character-for-character what `.env` holds
 * are dropped, so a real export still wins, which is what the per-suite
 * databases of a parallel api run rely on. CI has no `.env`, so this is a no-op
 * there.
 */
export function forgetAutoloadedDotenv(): void {
  for (const [key, value] of Object.entries(readDevEnv())) {
    if (process.env[key] === value) {
      delete process.env[key];
    }
  }
}

/**
 * Every variable a development env file defines.
 *
 * Deleting them from process.env only gets you half way for the e2e suite:
 * `next build` and `next start` run @next/env themselves, which reads the same
 * files again and fills in whatever is undefined. playwright.config.ts uses this
 * list to blank the ones it does not set, which is the state CI is already in.
 */
export function developmentEnvKeys(): string[] {
  return Object.keys(readDevEnv());
}

/**
 * Reads a single variable out of `.env.test` without loading the rest of it.
 *
 * For playwright.config.ts, which needs DATABASE_URL to agree with the suite
 * that seeds the database but must keep the rest of that file away from a
 * production `next build`.
 */
export function readTestEnvValue(key: string): string | undefined {
  if (!fs.existsSync(TEST_ENV_PATH)) return undefined;

  return parseDotenv(fs.readFileSync(TEST_ENV_PATH))[key];
}
