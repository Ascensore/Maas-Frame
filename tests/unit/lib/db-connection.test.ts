import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pool: vi.fn(), adapter: vi.fn() }));

vi.mock('pg', () => ({
  Pool: class {
    constructor(config: unknown) {
      mocks.pool(config);
    }
    on() {}
  },
}));
vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class {
    constructor(pool: unknown) {
      mocks.adapter(pool);
    }
  },
}));
vi.mock('@prisma/client', () => ({ PrismaClient: class {} }));

const globals = globalThis as typeof globalThis & {
  prisma?: unknown;
  pgPool?: unknown;
  dbShutdownRegistered?: boolean;
};
const originalShutdownRegistered = globals.dbShutdownRegistered;

afterEach(() => {
  delete globals.prisma;
  delete globals.pgPool;
  globals.dbShutdownRegistered = originalShutdownRegistered;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

describe('Prisma runtime connection', () => {
  it.each([
    ['1', 'aws-1-eu-west-1.pooler.supabase.com:5432', '6543'],
    ['1', 'aws-1-eu-west-1.pooler.supabase.com', '6543'],
    ['1', 'aws-1-eu-west-1.pooler.supabase.com:6543', '6543'],
    [undefined, 'aws-1-eu-west-1.pooler.supabase.com:5432', '5432'],
    ['1', 'localhost:5432', '5432'],
    ['1', 'db.example.supabase.co:5432', '5432'],
    ['1', 'aws-1.pooler.supabase.com.example.org:5432', '5432'],
  ])('uses the expected pooling port on Vercel=%s for %s', async (vercel, host, port) => {
    const input = `postgresql://postgres.project:p%40ss@${host}/postgres?sslmode=require`;
    vi.stubEnv('VERCEL', vercel);
    vi.stubEnv('DATABASE_URL', input);
    globals.dbShutdownRegistered = true;

    await import('@/lib/db');

    expect(mocks.pool).toHaveBeenCalledTimes(1);
    const config = mocks.pool.mock.calls[0][0];
    const expected = new URL(input);
    expected.port = port;
    expect(config.connectionString).toBe(expected.toString());
    expect(config.max).toBe(vercel === '1' ? 1 : 20);
    expect(mocks.adapter).toHaveBeenCalledTimes(1);
    // Migration commands and session-based workers still read the original URL.
    expect(process.env.DATABASE_URL).toBe(input);
  });
});
