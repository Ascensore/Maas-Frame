// Per-file setup for the `api` Vitest project.
//
// Runs before each test file is imported, which is what makes the vi.mock()
// registrations below reliable: they are in place before any test file pulls
// `@/lib/auth` or `nodemailer` into its module graph. Putting them in a helper
// that a test file imports would make the registration order depend on the
// order of that file's import statements.
//
// See TESTING.md section 5.

// MUST stay the first import. tests/helpers/env.ts loads .env.test on
// evaluation, and `@/lib/db` (reached below through tests/helpers/db.ts) reads
// process.env.DATABASE_URL once at module load and memoizes the pg pool on
// globalThis. ESM evaluates dependencies in import order, so anything that moves
// above this line points the whole suite at the wrong database.
import '../helpers/env';

import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { resetSentMail } from '../helpers/mail';

// lib/db.ts registers a SIGINT and a SIGTERM listener at module scope. With one
// module registry per test file that is two listeners per file, which trips
// Node's default limit of 10 and floods the output with
// MaxListenersExceededWarning. Lifting the cap is enough; lib/db.ts is
// production code and is left alone.
process.setMaxListeners(0);

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
// Partial mock: only `auth` is replaced. checkProjectAccess(),
// checkWorkspaceAccess() and computeProjectAccess() keep their real
// implementations and keep querying the real test database, because they are the
// subject of these tests rather than a dependency of them.
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, auth: vi.fn() };
});

// ---------------------------------------------------------------------------
// Next.js cache primitives
// ---------------------------------------------------------------------------
// revalidatePath() has no request scope to work with outside a server render,
// and unstable_cache() would wrap the Bunny/R2 stat helpers in a cache that has
// no incremental-cache handler behind it. Identity is the right stand-in for
// both.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  unstable_noStore: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------
// Presigners return deterministic fake URLs so a test can assert on the object
// key that a route chose, which is the part that actually matters. Nothing here
// speaks S3.
vi.mock('@/lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  return {
    ...actual,
    createPresignedVideoPutUrl: vi.fn(async (key: string) => `https://r2.test/put/${key}`),
    createPresignedImagePutUrl: vi.fn(async (key: string) => `https://r2.test/put/${key}`),
    createPresignedUploadPartUrl: vi.fn(
      async (key: string, uploadId: string, partNumber: number) =>
        `https://r2.test/part/${key}?uploadId=${uploadId}&partNumber=${partNumber}`
    ),
    createMultipartVideoUpload: vi.fn(async () => 'test-multipart-upload-id'),
    completeMultipartVideoUpload: vi.fn(async () => undefined),
    abortMultipartVideoUpload: vi.fn(async () => undefined),
    uploadAudio: vi.fn(async (key: string) => `https://r2.test/object/${key}`),
    deleteVideoObject: vi.fn(async () => undefined),
    deleteR2Object: vi.fn(async () => undefined),
    headVideoObject: vi.fn(async () => ({
      contentLength: 1024,
      contentType: 'video/mp4',
      etag: 'test-etag',
    })),
    readVideoObjectBytes: vi.fn(async () => ({
      body: new Uint8Array(0),
      contentLength: 0,
      contentType: 'video/mp4',
    })),
    ensureR2BucketExists: vi.fn(async () => undefined),
    ensureR2UploadCors: vi.fn(async () => []),
  };
});

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------
// getStripe() is the single seam every Stripe call goes through. Suites that
// need a specific response (the webhook suite, mainly) override these per test.
vi.mock('@/lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stripe')>();
  return {
    ...actual,
    getStripe: vi.fn(() => ({
      customers: { create: vi.fn(async () => ({ id: 'cus_test_default' })) },
      subscriptions: { list: vi.fn(async () => ({ data: [] })) },
      checkout: {
        sessions: { create: vi.fn(async () => ({ url: 'https://stripe.test/checkout' })) },
      },
      billingPortal: {
        sessions: { create: vi.fn(async () => ({ url: 'https://stripe.test/portal' })) },
      },
      webhooks: {
        constructEvent: vi.fn(() => {
          throw new Error('stripe.webhooks.constructEvent was not stubbed for this test');
        }),
      },
    })),
  };
});

// ---------------------------------------------------------------------------
// Bunny storage stats
// ---------------------------------------------------------------------------
// getCachedUserBunnyStorage() is an HTTP call to the Bunny API, and it sits in
// the middle of reserveStorageQuota(). Default to "no Bunny bytes"; the quota
// suite overrides it to prove Bunny usage counts against the limit.
vi.mock('@/lib/admin-stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-stats')>();
  return {
    ...actual,
    getCachedUserBunnyStorage: vi.fn(async () => ({}) as Record<string, number>),
  };
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
// notifyUsers()/notifyProjectOwner() fan out to Telegram over fetch() and to
// SMTP. Tests assert on the rows a route writes, not on delivery.
vi.mock('@/lib/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notifications')>();
  return {
    ...actual,
    notifyUsers: vi.fn(async () => undefined),
    notifyProjectOwner: vi.fn(async () => undefined),
  };
});

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------
// SMTP_* is configured in .env.test on purpose, so isEmailVerificationEnabled()
// is true and the routes take their production branch. Messages are captured
// instead of sent; assert on them with tests/helpers/mail.ts.
vi.mock('nodemailer', async () => {
  const { recordSentMail } = await import('../helpers/mail');
  const createTransport = vi.fn(() => ({
    sendMail: vi.fn(async (message: unknown) => {
      recordSentMail(message);
      return { messageId: 'test-message-id', accepted: [], rejected: [] };
    }),
    verify: vi.fn(async () => true),
  }));

  return { default: { createTransport }, createTransport };
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// A stale database from a crashed previous run would otherwise leak into the
// first test of the file.
beforeAll(async () => {
  await resetDb();
});

beforeEach(() => {
  resetSentMail();
});

// Every test creates the data it needs and nothing survives it, so no test can
// depend on execution order or on another test's rows.
afterEach(async () => {
  // Vitest's `unstubEnvs` option defaults to false, so a vi.stubEnv() leaks into
  // every following test in the file. That is not a theoretical worry here: one
  // test turning OPENFRAME_ENABLE_STRIPE off silently disarms hasBillingAccess()
  // and every quota check for the rest of the file, and the tests that follow
  // pass for the wrong reason. Undo it centrally rather than trusting 13 files
  // to remember.
  vi.unstubAllEnvs();
  await resetDb();
});
