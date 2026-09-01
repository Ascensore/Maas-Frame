import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, PoolConfig } from 'pg';
import { dbPoolIdleTimeoutMillis, dbPoolMax } from '@/lib/db-pool';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const globalForPool = globalThis as unknown as {
  pgPool: Pool | undefined;
};

const isDbPoolDebugEnabled = process.env.DB_POOL_DEBUG === 'true';

function createPool(connectionString: string): Pool {
  // Prevent multiple pools from being created during development (Next.js hot reload)
  if (globalForPool.pgPool) {
    return globalForPool.pgPool;
  }

  const poolConfig: PoolConfig = {
    connectionString,
    max: dbPoolMax(),
    idleTimeoutMillis: dbPoolIdleTimeoutMillis(),
    connectionTimeoutMillis: 5000, // Return error after 5 seconds if can't connect
    allowExitOnIdle: process.env.VERCEL === '1',
  };

  const pool = new Pool(poolConfig);

  // Add error handling for pool errors
  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err.message);
    // Don't crash the app on unexpected pool errors
  });

  if (isDbPoolDebugEnabled) {
    pool.on('connect', () => {
      console.debug('New database connection established');
    });

    pool.on('acquire', () => {
      console.debug('Connection acquired from pool');
    });
  }

  // Reuse across HMR and serverless isolate reuse. In production this is what
  // lets SIGTERM actually close the pooler session instead of leaking it.
  globalForPool.pgPool = pool;

  return pool;
}

function createPrismaClient() {
  // In development without a database, we'll create a mock-friendly client
  // For production or when DATABASE_URL is set, use the real adapter
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.warn('DATABASE_URL not set - database features will not work');
    // Return a client that will throw clear errors when used
    const pool = createPool('postgresql://localhost:5432/dummy');
    return new PrismaClient({
      // This will fail on actual DB operations but allows imports to work
      adapter: new PrismaPg(pool),
    });
  }

  const pool = createPool(connectionString);
  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();
globalForPrisma.prisma = db;

export async function disconnectDb(): Promise<void> {
  if (globalForPool.pgPool) {
    await globalForPool.pgPool.end();
    globalForPool.pgPool = undefined;
  }
  await db.$disconnect();
}

// Graceful shutdown handler
async function shutdown() {
  console.log('Shutting down database connections...');
  await disconnectDb();
  console.log('Database connections closed');
}

export default db;

const globalForShutdown = globalThis as unknown as {
  dbShutdownRegistered?: boolean;
};

if (!globalForShutdown.dbShutdownRegistered) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  globalForShutdown.dbShutdownRegistered = true;
}
