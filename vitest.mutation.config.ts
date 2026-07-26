import { defineConfig } from 'vitest/config';

// The Vitest config StrykerJS runs against, kept apart from vitest.config.ts on
// purpose.
//
// Only the `unit` project belongs here. Stryker restarts the suite once per
// surviving mutant across several concurrent workers, and the `api` project
// cannot take that: it shares one Postgres, empties every table between tests,
// and therefore runs with `fileParallelism: false`. Pointing Stryker at it would
// either serialise the whole run into something nobody waits for, or let two
// workers truncate each other's rows and report the resulting failures as killed
// mutants, which is a false pass.
//
// So mutation coverage is scoped to modules the unit project genuinely covers.
// `stryker.config.json` lists them explicitly rather than globbing `lib/`, for
// the same reason: a file whose only coverage is an API integration test would
// report every one of its mutants as survived, and a report that is mostly noise
// gets ignored.
export default defineConfig({
  // Same as the root config: Vite 8 resolves the tsconfig `paths` itself.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/setup/unit.ts'],
    // Same reason as the root config: next-auth's lib/env.js imports the
    // extensionless specifier 'next/server', which Node's ESM resolver cannot
    // resolve, so it has to go through Vite's resolver instead of being
    // externalised. Stryker runs under node, never under bun, so this is not
    // optional here the way it appears to be locally.
    server: { deps: { inline: [/next-auth/] } },
  },
});
