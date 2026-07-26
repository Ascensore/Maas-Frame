// Guards the test harness itself. Every other file in tests/api depends on
// these four things being true, and when one of them silently stops being true
// the failures elsewhere look like product bugs.

import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { cleanupRateLimits } from '@/lib/rate-limit';
import { GET as getProjects } from '@/app/api/projects/route';
import { countRows, listResettableTables, resetDb } from '../helpers/db';
import { apiRequest, callRoute } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  createComment,
  createCommentTag,
  createShareLink,
  createUser,
  seedVersion,
} from '../factories';

describe('api test infrastructure', () => {
  it('points at a test database and not at the dev one', async () => {
    const [{ current_database: name }] = await db.$queryRaw<
      Array<{ current_database: string }>
    >`SELECT current_database()`;

    // `openframe_test` is what everything uses by default. The optional suffix
    // exists because this suite empties every table after every test, so two
    // runs against one database destroy each other: writing several suites in
    // parallel means giving each run its own database, created by hand in the
    // same container and named `openframe_test_<something>`.
    //
    // The guard that matters is the one this leaves intact: the dev database is
    // called `openframe`, which does not match, so a stray DATABASE_URL still
    // cannot get this suite to truncate real data.
    expect(name).toMatch(/^openframe_test(_[a-z0-9]+)?$/);
  });

  it('discovers every table from information_schema, so resetDb cannot drift', async () => {
    const tables = await listResettableTables();

    // Sampled across the schema rather than asserted exhaustively: a new model
    // should not have to be added here, that is the whole point of reading
    // information_schema.
    expect(tables).toContain('users');
    expect(tables).toContain('projects');
    expect(tables).toContain('comments');
    expect(tables).toContain('rate_limits');
    expect(tables).toContain('video_upload_sessions');
    expect(tables).not.toContain('_prisma_migrations');
  });

  it('resetDb empties tables that hold rows', async () => {
    await createUser();
    await createUser();
    expect(await countRows('users')).toBe(2);

    await resetDb();

    expect(await countRows('users')).toBe(0);
  });

  // resetDb empties every table in one statement rather than in dependency
  // order, relying on foreign-key triggers firing after the whole statement.
  // This is the test that would catch that going wrong: the graph below spans
  // parents and children in both alphabetical directions.
  it('resetDb clears a full foreign-key graph in any direction', async () => {
    const scenario = await seedVersion();
    const tag = await createCommentTag({ projectId: scenario.project.id });
    await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      tagId: tag.id,
    });
    await createShareLink({ projectId: scenario.project.id, videoId: scenario.video.id });
    await db.$executeRaw`
      INSERT INTO rate_limits (key, action, count, window_start)
      VALUES ('reset-test', 'api', 1, NOW())
    `;

    await resetDb();

    for (const table of await listResettableTables()) {
      expect(await countRows(table), `${table} should be empty`).toBe(0);
    }
  });

  it('resetDb restarts the rate_limits sequence, standing in for RESTART IDENTITY', async () => {
    await db.$executeRaw`
      INSERT INTO rate_limits (key, action, count, window_start)
      VALUES ('seq-test-a', 'api', 1, NOW()), ('seq-test-b', 'api', 1, NOW())
    `;
    expect((await db.rateLimit.findFirstOrThrow({ orderBy: { id: 'desc' } })).id).toBe(2);

    await resetDb();
    await db.$executeRaw`
      INSERT INTO rate_limits (key, action, count, window_start)
      VALUES ('seq-test-c', 'api', 1, NOW())
    `;

    expect((await db.rateLimit.findFirstOrThrow()).id).toBe(1);
  });

  it('exposes cleanup_rate_limits(), which prisma db push does not create', async () => {
    await db.$executeRaw`
      INSERT INTO rate_limits (key, action, count, window_start)
      VALUES ('infra-test', 'api', 1, NOW() - INTERVAL '2 hours')
    `;
    expect(await countRows('rate_limits')).toBe(1);

    await cleanupRateLimits();

    expect(await countRows('rate_limits')).toBe(0);
  });

  it('mocks auth() while leaving the rest of @/lib/auth real', async () => {
    signedOut();
    const anonymous = await callRoute(getProjects, apiRequest('/api/projects'));
    expect(anonymous.status).toBe(401);

    const user = await createUser();
    signedInAs(user);
    const authenticated = await callRoute(getProjects, apiRequest('/api/projects'));
    expect(authenticated.status).toBe(200);
  });
});
