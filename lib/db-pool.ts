function isVercelRuntime(): boolean {
  return process.env.VERCEL === '1';
}

/** Cap connections per process. Serverless instances must not open a pool of 20. */
export function dbPoolMax(): number {
  if (isVercelRuntime()) return 1;
  return 20;
}

/**
 * Frozen Vercel isolates keep idle clients checked out of the session pooler
 * until this elapses. Five seconds is enough to reuse a warm isolate without
 * pinning all 15 pooler slots after a burst of API routes.
 */
export function dbPoolIdleTimeoutMillis(): number {
  if (isVercelRuntime()) return 5000;
  return 30000;
}
