# AGENTS.md

## Must-follow constraints

- Use `bun` only. Do not use `npm` or `pnpm`.
- Do not start the dev server (`bun run dev`); assume it is already running.
- If you change `prisma/schema.prisma`, run `bun run db:generate`.
- In App Router dynamic routes, keep `params` typed as `Promise<...>` and `await params` in handlers/pages.

## Validation before finishing

- Run `bun run check`.
- Run `bun run verify` (this is `bun run check` plus the unit and component tests).
- If you touched an API route, also run `bun run test:api`. It needs the test database:
  `bun run test:db:up` first.

## Testing

- The testing stack, layout and conventions live in `TESTING.md`. Read it before adding a
  test.
- Tests live in a top-level `tests/` tree, never colocated with the code.
- Import test globals explicitly: `import { describe, it, expect, vi } from 'vitest';`.
- Never write a BigInt literal (`1n`) in any file. `tsconfig.json` targets ES2017, so `tsc`
  rejects the syntax with TS2737 and `bun run check` fails. Use `BigInt(1)` instead, and
  compare `BigInt(...)` against `BigInt(...)`.

### When a change needs a test

Match the change to a layer. Most changes need exactly one.

| You changed                                                                                                     | Write                                                                           |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A pure function in `lib/` (validation, a limit, a date rule, a URL or filename check, a permission calculation) | a unit test in `tests/unit/lib/`                                                |
| An API route, or any authorization, quota or billing rule behind one                                            | an integration test in `tests/api/`                                             |
| A new API route                                                                                                 | classify it in `tests/api/auth-matrix.test.ts`, or the suite fails until you do |
| Real logic in a React hook (optimistic updates, throttling, retries)                                            | a hook test in `tests/component/hooks/`                                         |
| A user-visible flow across more than one page                                                                   | an end-to-end spec in `tests/e2e/`                                              |
| Presentation only (styling, copy, layout, a `components/ui/` wrapper)                                           | nothing                                                                         |

Always write a test for a bug fix, at the layer where the bug lived. The test must fail
before the fix and pass after it. If it passes before the fix, it is testing the wrong
thing.

For an API route, three cases are the minimum: an unauthenticated caller, a caller who is
signed in but not authorized, and the happy path. Assert the database row, not only the
status code: a refused DELETE has to leave the row present.

### Two ways a test can be worthless

Both have been found in this repo, so they are worth naming.

1. **A test that cannot fail.** Before you finish, name the specific mutation of the
   production code your test would catch. If you cannot name one, delete the test. When it
   matters, prove it: break the code on purpose, watch the test go red, then revert.
2. **A test whose input comes from the code under test.** Iterating the same constant the
   function looks up means deleting an entry from that constant also deletes its own test
   case. Write expected values by hand as literals.

## Repo-specific conventions

- Use `auth()` from `@/lib/auth` for server-side session reads.
- Use `checkProjectAccess()` / `checkWorkspaceAccess()` for authorization instead of ad-hoc role checks.
- For API responses, use `successResponse` / `apiErrors` from `@/lib/api-response`.
- Keep API and UI imports on `@/` aliases when available.
- In Prisma raw SQL, use `$executeRaw` for statements that return no rows (e.g. `pg_advisory_xact_lock`). Using `$queryRaw` on void-returning functions causes a Prisma deserialization error (`Failed to deserialize column of type 'void'`).

## Important locations

- Custom SQL managed by Prisma migrations: `prisma/migrations/*/migration.sql`.
- Shared API response helpers: `lib/api-response.ts`.
- Auth + access-control helpers: `lib/auth.ts`.

## Change safety rules

- Prefer backward-compatible API changes unless explicitly asked to break contracts.
- For multi-step DB writes, use Prisma transactions.
