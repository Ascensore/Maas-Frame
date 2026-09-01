// Exercises the DB-backed rate limiter against real Postgres.
//
// The counter lives in an UNLOGGED `rate_limits` table and is maintained by a
// single INSERT ... ON CONFLICT DO UPDATE whose CASE arms decide between
// "increment inside the window" and "start a new window". Neither that SQL nor
// `cleanup_rate_limits()` (a plpgsql function that only exists because
// tests/setup/db-global.ts replays it) can be checked without a database.
//
// .env.test sets DISABLE_RATE_LIMIT=true so that one test file cannot exhaust a
// window for the next one. isRateLimitDisabled() reads the variable on every
// call rather than at import, so re-enabling it per test is enough, and
// tests/setup/api.ts undoes the stub afterwards.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  RATE_LIMIT_CONFIGS,
  checkRateLimit,
  cleanupRateLimits,
  getClientIp,
  rateLimit,
  rateLimitHeaders,
} from '@/lib/rate-limit';
import { POST as postComment } from '@/app/api/versions/[versionId]/comments/route';
import { apiRequest, callRoute } from '../helpers/request';
import { signedInAs } from '../helpers/session';
import { countRows } from '../helpers/db';
import { seedVersion } from '../factories';

const CONFIG = { windowMs: 60_000, maxRequests: 3 };

function enableRateLimiting(): void {
  vi.stubEnv('DISABLE_RATE_LIMIT', 'false');
}

describe('RATE_LIMIT_CONFIGS', () => {
  it('gives every action a positive window and a positive maximum', () => {
    const entries = Object.entries(RATE_LIMIT_CONFIGS);

    expect(entries.length).toBeGreaterThan(0);
    for (const [action, config] of entries) {
      expect(config.windowMs, `${action} windowMs`).toBeGreaterThan(0);
      expect(config.maxRequests, `${action} maxRequests`).toBeGreaterThan(0);
    }
  });
});

describe('checkRateLimit while disabled', () => {
  it('allows everything and writes no rows', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await checkRateLimit('1.2.3.4', 'login', CONFIG);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(CONFIG.maxRequests);
    }

    expect(await countRows('rate_limits')).toBe(0);
  });
});

describe('checkRateLimit', () => {
  beforeEach(() => {
    enableRateLimiting();
  });

  it('allows the first N calls and blocks the next one', async () => {
    const outcomes: Array<{ allowed: boolean; remaining: number }> = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await checkRateLimit('1.2.3.4', 'login', CONFIG);
      outcomes.push({ allowed: result.allowed, remaining: result.remaining });
    }

    expect(outcomes).toEqual([
      { allowed: true, remaining: 2 },
      { allowed: true, remaining: 1 },
      { allowed: true, remaining: 0 },
      { allowed: false, remaining: 0 },
      { allowed: false, remaining: 0 },
    ]);

    const row = await db.rateLimit.findFirstOrThrow();
    expect(row.key).toBe('1.2.3.4');
    expect(row.action).toBe('login');
    expect(row.count).toBe(5);
  });

  it('keeps one row per key and action pair', async () => {
    await checkRateLimit('1.2.3.4', 'login', CONFIG);
    await checkRateLimit('1.2.3.4', 'login', CONFIG);
    await checkRateLimit('5.6.7.8', 'login', CONFIG);
    await checkRateLimit('1.2.3.4', 'register', CONFIG);

    const rows = await db.rateLimit.findMany({ orderBy: [{ key: 'asc' }, { action: 'asc' }] });
    expect(rows.map((row) => [row.key, row.action, row.count])).toEqual([
      ['1.2.3.4', 'login', 2],
      ['1.2.3.4', 'register', 1],
      ['5.6.7.8', 'login', 1],
    ]);
  });

  it('does not let one key exhaust another key budget', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await checkRateLimit('1.2.3.4', 'login', CONFIG);
    }

    expect((await checkRateLimit('1.2.3.4', 'login', CONFIG)).allowed).toBe(false);
    expect((await checkRateLimit('5.6.7.8', 'login', CONFIG)).allowed).toBe(true);
  });

  it('does not let one action exhaust another action budget', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await checkRateLimit('1.2.3.4', 'login', CONFIG);
    }

    expect((await checkRateLimit('1.2.3.4', 'comment', CONFIG)).allowed).toBe(true);
  });

  it('derives resetAt from the stored window start plus the window length', async () => {
    const result = await checkRateLimit('1.2.3.4', 'login', CONFIG);
    const row = await db.rateLimit.findFirstOrThrow();

    expect(result.resetAt.getTime()).toBe(row.windowStart.getTime() + CONFIG.windowMs);
  });

  // The CASE arms in the upsert: once window_start is older than the window, the
  // count resets to 1 and window_start moves to now rather than incrementing.
  it('starts a fresh window once the old one has expired', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await checkRateLimit('1.2.3.4', 'login', CONFIG);
    }
    expect((await checkRateLimit('1.2.3.4', 'login', CONFIG)).allowed).toBe(false);

    // Age the window past its length instead of waiting a real minute.
    await db.$executeRaw`
      UPDATE rate_limits
      SET window_start = NOW() - INTERVAL '2 minutes'
      WHERE key = '1.2.3.4' AND action = 'login'
    `;

    const afterReset = await checkRateLimit('1.2.3.4', 'login', CONFIG);

    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(CONFIG.maxRequests - 1);
    const row = await db.rateLimit.findFirstOrThrow();
    expect(row.count).toBe(1);
    expect(Date.now() - row.windowStart.getTime()).toBeLessThan(30_000);
  });

  it('keeps blocking while the window is still open', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await checkRateLimit('1.2.3.4', 'login', CONFIG);
    }

    await db.$executeRaw`
      UPDATE rate_limits
      SET window_start = NOW() - INTERVAL '30 seconds'
      WHERE key = '1.2.3.4' AND action = 'login'
    `;

    expect((await checkRateLimit('1.2.3.4', 'login', CONFIG)).allowed).toBe(false);
  });

  it('falls back to the api config for an unknown action', async () => {
    const result = await checkRateLimit('1.2.3.4', 'no-such-action');

    expect(result.remaining).toBe(RATE_LIMIT_CONFIGS.api.maxRequests - 1);
  });

  // An oversized value is hashed to fit its column rather than skipped, so it is written
  // and counted like any other. A huge key cannot bloat the table either: what lands in
  // the column is a fixed-width digest.
  it('records an over-long key and an over-long action', async () => {
    const longKey = await checkRateLimit('x'.repeat(257), 'login', CONFIG);
    const longAction = await checkRateLimit('1.2.3.4', 'y'.repeat(65), CONFIG);

    expect(longKey.allowed).toBe(true);
    expect(longAction.allowed).toBe(true);
    expect(await countRows('rate_limits')).toBe(2);
  });

  it('records a key of exactly 255 characters, the column width', async () => {
    const result = await checkRateLimit('x'.repeat(255), 'login', CONFIG);

    expect(result.allowed).toBe(true);
    expect(await countRows('rate_limits')).toBe(1);
  });

  // This is the case that used to fail open twice over: the guard allowed a 256-character
  // key through, the INSERT then failed with SQLSTATE 22001 against a VARCHAR(255) column,
  // and the catch answered "allowed" for every attempt. The key is now hashed before it
  // reaches the query, so the limit applies to it like any other.
  it('counts a 256-character key and blocks it past the cap', async () => {
    const key = 'x'.repeat(256);

    for (let attempt = 0; attempt < CONFIG.maxRequests; attempt += 1) {
      const result = await checkRateLimit(key, 'login', CONFIG);
      expect(result.allowed).toBe(true);
    }

    const blocked = await checkRateLimit(key, 'login', CONFIG);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);

    expect(await countRows('rate_limits')).toBe(1);
    expect((await db.rateLimit.findFirstOrThrow()).count).toBe(CONFIG.maxRequests + 1);
  });

  it('keeps two different over-long keys in separate buckets', async () => {
    await checkRateLimit(`a${'x'.repeat(300)}`, 'login', CONFIG);
    await checkRateLimit(`b${'x'.repeat(300)}`, 'login', CONFIG);

    expect(await countRows('rate_limits')).toBe(2);
  });

  it('counts concurrent calls exactly once each', async () => {
    await Promise.all(Array.from({ length: 6 }, () => checkRateLimit('1.2.3.4', 'login', CONFIG)));

    expect((await db.rateLimit.findFirstOrThrow()).count).toBe(6);
  });
});

describe('cleanup_rate_limits()', () => {
  beforeEach(() => {
    enableRateLimiting();
  });

  it('deletes windows older than an hour and keeps the rest', async () => {
    await db.$executeRaw`
      INSERT INTO rate_limits (key, action, count, window_start) VALUES
        ('stale', 'login', 5, NOW() - INTERVAL '61 minutes'),
        ('fresh', 'login', 5, NOW() - INTERVAL '59 minutes'),
        ('now', 'login', 1, NOW())
    `;

    await cleanupRateLimits();

    const remaining = (await db.rateLimit.findMany({ select: { key: true } })).map(
      (row) => row.key
    );
    expect(remaining.sort()).toEqual(['fresh', 'now']);
  });

  it('is safe to call against an empty table', async () => {
    await cleanupRateLimits();

    expect(await countRows('rate_limits')).toBe(0);
  });
});

describe('rateLimit', () => {
  beforeEach(() => {
    enableRateLimiting();
  });

  it('returns null while allowed and a 429 with headers once blocked', async () => {
    const request = apiRequest('/api/anything');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await rateLimit(request, 'login', CONFIG)).toBeNull();
    }

    const blocked = await rateLimit(request, 'login', CONFIG);

    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(blocked?.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(blocked?.headers.get('X-RateLimit-Reset')).toMatch(/^\d+$/);
    expect(await blocked!.json()).toEqual({
      error: 'Too many requests. Please try again later.',
    });
  });

  // With TRUSTED_PROXY_MODE unset, getClientIp() collapses every caller to
  // 127.0.0.1, so the limit is per process rather than per client. Pinned here
  // because it is a deliberate trade-off, not an accident.
  it('shares one bucket across every caller when no trusted proxy is configured', async () => {
    const first = apiRequest('/api/anything', { headers: { 'x-forwarded-for': '9.9.9.9' } });
    const second = apiRequest('/api/anything', { headers: { 'x-forwarded-for': '8.8.8.8' } });

    expect(await rateLimit(first, 'login', CONFIG)).toBeNull();
    expect(await rateLimit(second, 'login', CONFIG)).toBeNull();
    expect(await rateLimit(first, 'login', CONFIG)).toBeNull();
    expect((await rateLimit(second, 'login', CONFIG))?.status).toBe(429);
    expect((await db.rateLimit.findFirstOrThrow()).key).toBe('127.0.0.1');
  });
});

describe('getClientIp', () => {
  it('returns 127.0.0.1 and ignores proxy headers with no trusted proxy mode', () => {
    const request = apiRequest('/api/anything', {
      headers: {
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '203.0.113.9',
        'cf-connecting-ip': '203.0.113.9',
      },
    });

    expect(getClientIp(request)).toBe('127.0.0.1');
  });

  it('trusts cf-connecting-ip in cloudflare mode', () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'cloudflare');
    const request = apiRequest('/api/anything', {
      headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '10.0.0.1' },
    });

    expect(getClientIp(request)).toBe('203.0.113.9');
  });

  it('rejects an implausible cf-connecting-ip in cloudflare mode', () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'cloudflare');
    const request = apiRequest('/api/anything', {
      headers: { 'cf-connecting-ip': 'not-an-ip; drop table' },
    });

    expect(getClientIp(request)).toBe('127.0.0.1');
  });

  it('prefers x-real-ip and otherwise the last x-forwarded-for entry in nginx mode', () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'nginx');

    expect(
      getClientIp(
        apiRequest('/api/anything', {
          headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '10.0.0.1' },
        })
      )
    ).toBe('203.0.113.9');

    // The last entry is the one nginx appends, so a client-supplied prefix
    // cannot spoof it.
    expect(
      getClientIp(
        apiRequest('/api/anything', {
          headers: { 'x-forwarded-for': 'spoofed, 198.51.100.7' },
        })
      )
    ).toBe('198.51.100.7');
  });

  it('trusts the first x-forwarded-for entry in vercel mode', () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'vercel');

    expect(
      getClientIp(
        apiRequest('/api/anything', {
          headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'x-real-ip': '198.51.100.1' },
        })
      )
    ).toBe('203.0.113.9');
  });

  it('ignores proxy headers for an unrecognised mode', () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'haproxy');
    const request = apiRequest('/api/anything', {
      headers: { 'x-real-ip': '203.0.113.9', 'cf-connecting-ip': '203.0.113.9' },
    });

    expect(getClientIp(request)).toBe('127.0.0.1');
  });
});

describe('rateLimitHeaders', () => {
  it('renders the reset time as unix seconds', () => {
    const resetAt = new Date(1_700_000_123_456);

    expect(rateLimitHeaders({ allowed: true, remaining: 7, resetAt }, 10)).toEqual({
      'X-RateLimit-Limit': '10',
      'X-RateLimit-Remaining': '7',
      'X-RateLimit-Reset': '1700000123',
    });
  });
});

describe('rate limiting on a real route', () => {
  beforeEach(() => {
    enableRateLimiting();
  });

  it('blocks comment creation after the configured number of comments', async () => {
    const scenario = await seedVersion({ duration: 600 });
    signedInAs(scenario.owner);
    const max = RATE_LIMIT_CONFIGS.comment.maxRequests;

    const statuses: number[] = [];
    for (let attempt = 0; attempt <= max; attempt += 1) {
      const response = await callRoute(
        postComment,
        apiRequest(`/api/versions/${scenario.version.id}/comments`, {
          body: { content: `comment ${attempt}`, timestamp: attempt },
        }),
        { versionId: scenario.version.id }
      );
      statuses.push(response.status);
    }

    expect(statuses.slice(0, max)).toEqual(Array.from({ length: max }, () => 201));
    expect(statuses[max]).toBe(429);
    // The blocked request must not have written a row.
    expect(await db.comment.count()).toBe(max);
    expect((await db.rateLimit.findFirstOrThrow()).action).toBe('comment');
  });
});
