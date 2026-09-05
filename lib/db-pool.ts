function isVercelRuntime(): boolean {
  return process.env.VERCEL === '1';
}

/**
 * Supabase's session pooler pins a backend per client, even while idle. Vercel
 * can run more isolates than that pool's capacity, so its application queries
 * need transaction pooling. Keep DATABASE_URL itself intact for migrations and
 * long-running workers, which may require session-level features.
 */
export function dbRuntimeConnectionString(connectionString: string): string {
  if (!isVercelRuntime()) return connectionString;

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }

  if (
    (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
    url.hostname.endsWith('.pooler.supabase.com') &&
    (url.port === '5432' || url.port === '')
  ) {
    url.port = '6543';
    return url.toString();
  }
  return connectionString;
}

/** Cap connections per process. Serverless instances must not open a pool of 20. */
export function dbPoolMax(): number {
  if (isVercelRuntime()) return 1;
  return 20;
}

/**
 * Release idle Vercel clients promptly. This limits client connections but is
 * not a substitute for transaction pooling: timers can pause in frozen isolates.
 */
export function dbPoolIdleTimeoutMillis(): number {
  if (isVercelRuntime()) return 5000;
  return 30000;
}
