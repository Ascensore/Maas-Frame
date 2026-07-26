# Contributing to OpenFrame

Thanks for taking the time to contribute.
This guide covers setup, PR expectations, and required conventions.

## Local setup

1. Install dependencies.

```bash
bun install
```

2. Copy environment variables.

```bash
cp .env.example .env
```

3. Generate Prisma client.

```bash
bun run db:generate
```

4. Run validation.

```bash
bun run check
```

## Running the tests

The testing stack, layout, and conventions live in [TESTING.md](TESTING.md). Read it before adding a test, and see the "When a change needs a test" table in [AGENTS.md](AGENTS.md) for which layer your change belongs in. A bug fix always needs a test that fails before the fix.

| Command            | Runs                                               | Needs the test database |
| ------------------ | -------------------------------------------------- | ----------------------- |
| `bun run test`     | unit and component suites                          | no                      |
| `bun run test:api` | API integration suites                             | yes                     |
| `bun run test:e2e` | Playwright end-to-end specs                        | yes                     |
| `bun run verify`   | `bun run check` plus the unit and component suites | no                      |

The test database is a disposable Postgres defined in `docker-compose.test.yml`, on port `55432` so it cannot collide with your dev stack.

```bash
bun run test:db:up
bun run test:api
bun run test:db:down
```

`scripts/test.sh <unit|api|e2e|all>` does all of that in one command. It runs each suite inside a container, so no package manager runs on your host, and it starts the test database first when the suite needs one.

```bash
./scripts/test.sh unit
./scripts/test.sh all
```

The `pre-push` hook runs `bun run verify`, so lint, format, typecheck, and the unit and component suites have to pass before a push leaves your machine. `bun run test:api` is deliberately not in the hook, because it needs the database container. Run it yourself when you change an API route.

## Contribution workflow

1. Fork and create a branch from `master`.
2. Keep changes focused on one logical concern.
3. Follow repository conventions in this file.
4. Run required checks locally.
5. Open a PR with a clear summary and checklist.

## Branch naming

- `feature/<short-topic>`
- `fix/<short-topic>`
- `docs/<short-topic>`
- `refactor/<short-topic>`
- `chore/<short-topic>`

## Commit and PR title standard

Use Conventional Commits with this pattern:

```text
type(scope): short summary
```

## Required checks before opening a PR

- Run `bun run check`.
- Run `bun run verify`, or let the `pre-push` hook run it for you.
- If you changed an API route, also run `bun run test:api` with the test database up.
- If `prisma/schema.prisma` changed, run `bun run db:generate`.
- Ensure no unrelated file changes are included.
- Ensure no secrets or private keys are committed.
- Update docs when behavior changes.

## Project conventions (must follow)

- Use Bun commands only.
- Server-side session reads must use `auth()` from [lib/auth.ts](lib/auth.ts).
- Access control should use `checkProjectAccess()` / `checkWorkspaceAccess()`.
- API responses should use `successResponse` / `apiErrors` from [lib/api-response.ts](lib/api-response.ts).
- In App Router dynamic routes, keep `params` typed as `Promise<...>` and use `await params`.
- For multi-step DB writes, use Prisma transactions.
- Prefer backward-compatible API changes unless a breaking change is explicitly requested.
- Prefer `@/` imports when available.

## Security issues

Do not open public issues for vulnerabilities.
Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Need help?

If you are unsure where to start, open an issue with context and a proposed approach.
