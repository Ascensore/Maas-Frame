import { NextResponse } from 'next/server';
import { apiErrors } from '@/lib/api-response';
import { logError } from '@/lib/logger';

export const DEFAULT_SUPABASE_STORAGE_BUCKET = 'maas-frame';

export type SupabaseStorageApi = {
  origin: string;
  storageOrigin: string;
  key: string;
};

export function getSupabaseStorageApi(): SupabaseStorageApi | null {
  const raw = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)?.trim();
  if (!raw || !key) return null;

  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    return null;
  }

  const ref = new URL(origin).hostname.split('.')[0];
  if (!ref) return null;

  return {
    origin,
    storageOrigin: `https://${ref}.storage.supabase.co`,
    key,
  };
}

export function supabaseStorageConnectOrigins(): string[] {
  const api = getSupabaseStorageApi();
  if (!api) return [];
  return [api.origin, api.storageOrigin];
}

function encodeObjectKey(key: string): string {
  return key
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function objectUrl(api: SupabaseStorageApi, bucket: string, key: string): string {
  return `${api.origin}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeObjectKey(key)}`;
}

function authHeaders(api: SupabaseStorageApi, extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  headers.set('Authorization', `Bearer ${api.key}`);
  headers.set('apikey', api.key);
  return headers;
}

export async function createSupabaseSignedUploadUrl(bucket: string, key: string): Promise<string> {
  const api = getSupabaseStorageApi();
  if (!api) {
    throw new Error('Supabase storage is not configured');
  }

  const signUrl = `${api.storageOrigin}/storage/v1/object/upload/sign/${encodeURIComponent(bucket)}/${encodeObjectKey(key)}`;
  const response = await fetch(signUrl, {
    method: 'POST',
    headers: authHeaders(api, { 'x-upsert': 'true' }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Failed to sign Supabase upload (${response.status}): ${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as { url?: string; Url?: string };
  const relative = payload.url || payload.Url;
  if (!relative) {
    throw new Error('Supabase signed upload response was missing a url');
  }

  if (relative.startsWith('http://') || relative.startsWith('https://')) {
    return relative;
  }

  const path = relative.startsWith('/') ? relative : `/${relative}`;
  return `${api.storageOrigin}/storage/v1${path}`;
}

export async function putSupabaseObject(
  bucket: string,
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<void> {
  const api = getSupabaseStorageApi();
  if (!api) {
    throw new Error('Supabase storage is not configured');
  }

  const response = await fetch(objectUrl(api, bucket, key), {
    method: 'POST',
    headers: authHeaders(api, {
      'Content-Type': contentType,
      'x-upsert': 'true',
    }),
    body: new Uint8Array(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Failed to store object in Supabase (${response.status}): ${detail.slice(0, 200)}`
    );
  }
}

/**
 * Storage wraps a missing object as HTTP 400 with a nested 404 payload
 * (`code: NoSuchKey`). Cleanup after a failed PUT hits this on every retry.
 */
export function isMissingSupabaseObjectResponse(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  try {
    const payload = JSON.parse(body) as {
      code?: unknown;
      error?: unknown;
      statusCode?: unknown;
    };
    return (
      payload.code === 'NoSuchKey' || payload.error === 'not_found' || payload.statusCode === '404'
    );
  } catch {
    return false;
  }
}

export async function deleteSupabaseObject(bucket: string, key: string): Promise<void> {
  const api = getSupabaseStorageApi();
  if (!api) {
    throw new Error('Supabase storage is not configured');
  }

  const response = await fetch(objectUrl(api, bucket, key), {
    method: 'DELETE',
    headers: authHeaders(api),
  });

  if (response.ok || response.status === 404) return;

  const detail = await response.text().catch(() => '');
  if (isMissingSupabaseObjectResponse(response.status, detail)) return;

  throw new Error(`Failed to delete Supabase object (${response.status}): ${detail.slice(0, 200)}`);
}

export async function headSupabaseObject(
  bucket: string,
  key: string
): Promise<{ contentLength: bigint; contentType: string | undefined } | null> {
  const api = getSupabaseStorageApi();
  if (!api) {
    throw new Error('Supabase storage is not configured');
  }

  const response = await fetch(objectUrl(api, bucket, key), {
    method: 'HEAD',
    headers: authHeaders(api),
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to head Supabase object (${response.status})`);
  }

  const lengthHeader = response.headers.get('content-length');
  const contentLength =
    lengthHeader && /^\d+$/.test(lengthHeader) ? BigInt(lengthHeader) : BigInt(0);

  return {
    contentLength,
    contentType: response.headers.get('content-type') ?? undefined,
  };
}

function asBytes(body: unknown): Uint8Array {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error('Unsupported object body');
}

function notFoundError(): Error {
  const error = new Error('NoSuchKey');
  Object.assign(error, {
    name: 'NoSuchKey',
    Code: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  });
  return error;
}

function statusError(status: number): Error {
  const error = new Error(`Supabase storage request failed (${status})`);
  Object.assign(error, { $metadata: { httpStatusCode: status } });
  return error;
}

export async function sendSupabaseS3Command(command: unknown): Promise<{
  Body?: {
    transformToWebStream: () => ReadableStream<Uint8Array>;
    transformToByteArray: () => Promise<Uint8Array>;
  };
  ContentType?: string;
  ContentLength?: number;
  ContentRange?: string;
  ETag?: string;
  LastModified?: Date;
  AcceptRanges?: string;
}> {
  const api = getSupabaseStorageApi();
  if (!api) {
    throw new Error('Supabase storage is not configured');
  }

  const named = command as { constructor?: { name?: string }; input?: Record<string, unknown> };
  const commandName = named.constructor?.name ?? '';
  const input = named.input ?? {};
  const bucket = String(input.Bucket || DEFAULT_SUPABASE_STORAGE_BUCKET);
  const key = String(input.Key || '');

  if (commandName === 'PutObjectCommand') {
    await putSupabaseObject(
      bucket,
      key,
      asBytes(input.Body),
      typeof input.ContentType === 'string' ? input.ContentType : 'application/octet-stream'
    );
    return {};
  }

  if (commandName === 'DeleteObjectCommand') {
    await deleteSupabaseObject(bucket, key);
    return {};
  }

  if (commandName === 'HeadObjectCommand') {
    const head = await headSupabaseObject(bucket, key);
    if (!head) throw notFoundError();
    return {
      ContentLength: Number(head.contentLength),
      ContentType: head.contentType,
    };
  }

  if (commandName === 'GetObjectCommand') {
    const headers = authHeaders(api);
    if (typeof input.Range === 'string') headers.set('Range', input.Range);
    const response = await fetch(objectUrl(api, bucket, key), { method: 'GET', headers });
    if (response.status === 404) throw notFoundError();
    if (response.status === 416) throw statusError(416);
    if (!response.ok || !response.body) throw statusError(response.status);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const lastModifiedHeader = response.headers.get('last-modified');
    return {
      Body: {
        transformToWebStream: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        transformToByteArray: async () => bytes,
      },
      ContentType: response.headers.get('content-type') ?? undefined,
      ContentLength: bytes.byteLength,
      ContentRange: response.headers.get('content-range') ?? undefined,
      ETag: response.headers.get('etag') ?? undefined,
      LastModified: lastModifiedHeader ? new Date(lastModifiedHeader) : undefined,
      AcceptRanges: response.headers.get('accept-ranges') || 'bytes',
    };
  }

  if (
    commandName === 'HeadBucketCommand' ||
    commandName === 'CreateBucketCommand' ||
    commandName === 'GetBucketCorsCommand' ||
    commandName === 'PutBucketCorsCommand'
  ) {
    return {};
  }

  throw new Error(`Unsupported storage command on Supabase: ${commandName}`);
}

export async function readSupabaseObjectBytes(
  bucket: string,
  key: string,
  byteLength: number
): Promise<Uint8Array | null> {
  const api = getSupabaseStorageApi();
  if (!api) {
    throw new Error('Supabase storage is not configured');
  }

  const rangeEnd = Math.max(0, byteLength - 1);
  const response = await fetch(objectUrl(api, bucket, key), {
    method: 'GET',
    headers: authHeaders(api, { Range: `bytes=0-${rangeEnd}` }),
  });

  if (response.status === 404 || response.status === 416) return null;
  if (!response.ok) {
    throw new Error(`Failed to read Supabase object (${response.status})`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

type ProxySupabaseMediaOptions = {
  request: Request;
  bucket: string;
  key: string;
  fallbackContentType: string;
  cacheControl: string;
  extraHeaders?: Record<string, string>;
  notFoundLabel?: string;
  internalErrorMessage: string;
};

export async function proxySupabaseMediaObject({
  request,
  bucket,
  key,
  fallbackContentType,
  cacheControl,
  extraHeaders,
  notFoundLabel = 'File',
  internalErrorMessage,
}: ProxySupabaseMediaOptions): Promise<NextResponse> {
  const api = getSupabaseStorageApi();
  if (!api) {
    return apiErrors.internalError(internalErrorMessage);
  }

  const headers = authHeaders(api);
  const range = request.headers.get('range');
  if (range) headers.set('Range', range);

  let response: Response;
  try {
    response = await fetch(objectUrl(api, bucket, key), {
      method: 'GET',
      headers,
    });
  } catch (error) {
    logError('Error proxying Supabase object:', error);
    return apiErrors.internalError(internalErrorMessage);
  }

  if (response.status === 404) {
    return apiErrors.notFound(notFoundLabel);
  }
  if (response.status === 416) {
    return new NextResponse(null, {
      status: 416,
      headers: {
        'Cache-Control': cacheControl,
        'Accept-Ranges': 'bytes',
      },
    });
  }
  if (!response.ok || !response.body) {
    logError('Error proxying Supabase object:', new Error(`status ${response.status}`));
    return apiErrors.internalError(internalErrorMessage);
  }

  const outbound = new Headers();
  const contentType = response.headers.get('content-type');
  outbound.set(
    'Content-Type',
    contentType && contentType !== 'application/octet-stream' ? contentType : fallbackContentType
  );
  const contentLength = response.headers.get('content-length');
  if (contentLength) outbound.set('Content-Length', contentLength);
  const contentRange = response.headers.get('content-range');
  if (contentRange) outbound.set('Content-Range', contentRange);
  const etag = response.headers.get('etag');
  if (etag) outbound.set('ETag', etag);
  const lastModified = response.headers.get('last-modified');
  if (lastModified) outbound.set('Last-Modified', lastModified);
  outbound.set('Accept-Ranges', response.headers.get('accept-ranges') || 'bytes');
  outbound.set('Cache-Control', cacheControl);
  outbound.set('X-Content-Type-Options', 'nosniff');
  outbound.set('Content-Disposition', 'inline');

  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      outbound.set(name, value);
    }
  }

  return new NextResponse(response.body, {
    status: contentRange ? 206 : response.status,
    headers: outbound,
  });
}
