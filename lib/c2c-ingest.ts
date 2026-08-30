import { reviewKindFromFileName } from '@/lib/review-kind';

const C2C_PREFIX = 'of_c2c_';

export type C2cIngestArgs = {
  baseUrl: string;
  token: string;
  files: string[];
  watchDir: string | null;
  title: string | null;
};

export type C2cIngestEnv = {
  OPENFRAME_BASE_URL?: string;
  C2C_TOKEN?: string;
};

export type C2cWatchRecord = {
  sizeBytes: number;
  mtimeMs: number;
};

export function titleFromIngestFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const withoutExt = base.replace(/\.[^/.]+$/, '').trim();
  return withoutExt || base;
}

export function shouldIngestFileName(fileName: string): boolean {
  return reviewKindFromFileName(fileName) !== null;
}

export function normalizeC2cBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function parseC2cIngestArgs(
  argv: string[],
  env: C2cIngestEnv = {}
): C2cIngestArgs | { error: string } {
  let baseUrl = env.OPENFRAME_BASE_URL ?? '';
  let token = env.C2C_TOKEN ?? '';
  let title: string | null = null;
  let watchDir: string | null = null;
  const files: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--base-url') {
      if (!next) return { error: '--base-url needs a URL' };
      baseUrl = next;
      i += 1;
      continue;
    }
    if (arg === '--token') {
      if (!next) return { error: '--token needs a value' };
      token = next;
      i += 1;
      continue;
    }
    if (arg === '--file') {
      if (!next) return { error: '--file needs a path' };
      files.push(next);
      i += 1;
      continue;
    }
    if (arg === '--watch') {
      if (!next) return { error: '--watch needs a directory' };
      watchDir = next;
      i += 1;
      continue;
    }
    if (arg === '--title') {
      if (!next) return { error: '--title needs a value' };
      title = next;
      i += 1;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }

  const normalizedUrl = normalizeC2cBaseUrl(baseUrl);
  if (!normalizedUrl) return { error: 'pass --base-url or set OPENFRAME_BASE_URL' };
  if (!token.startsWith(C2C_PREFIX) || token.length < C2C_PREFIX.length + 16) {
    return { error: 'pass a camera ingest token (--token or C2C_TOKEN), starting with of_c2c_' };
  }
  if (title !== null && files.length !== 1) {
    return { error: '--title is only valid with exactly one --file' };
  }
  if (files.length === 0 && !watchDir) {
    return { error: 'pass --file PATH and/or --watch DIR' };
  }

  return {
    baseUrl: normalizedUrl,
    token,
    files,
    watchDir,
    title,
  };
}

export function c2cAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export function c2cCreateVideoBody(input: {
  title: string;
  proxyUrl: string;
  objectKey: string;
  uploadToken: string;
  duration: number | null;
}): {
  title: string;
  videoUrl: string;
  objectKey: string;
  uploadToken: string;
  duration: number | null;
} {
  return {
    title: input.title,
    videoUrl: input.proxyUrl,
    objectKey: input.objectKey,
    uploadToken: input.uploadToken,
    duration: input.duration,
  };
}

export function parseC2cWatchState(raw: string): Record<string, C2cWatchRecord> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, C2cWatchRecord> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const sizeBytes = (value as { sizeBytes?: unknown }).sizeBytes;
      const mtimeMs = (value as { mtimeMs?: unknown }).mtimeMs;
      if (typeof sizeBytes !== 'number' || typeof mtimeMs !== 'number') continue;
      if (!Number.isFinite(sizeBytes) || !Number.isFinite(mtimeMs) || sizeBytes < 0) continue;
      out[key] = { sizeBytes, mtimeMs };
    }
    return out;
  } catch {
    return {};
  }
}

export function shouldSkipWatchedFile(
  previous: C2cWatchRecord | undefined,
  sizeBytes: number,
  mtimeMs: number
): boolean {
  if (!previous) return false;
  return previous.sizeBytes === sizeBytes && previous.mtimeMs === mtimeMs;
}
