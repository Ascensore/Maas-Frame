// Builders for calling App Router route handlers directly.
//
// There are no `use server` actions in this repo, so every mutation goes through
// an exported function in app/api/**/route.ts. Those are plain functions: given
// a NextRequest and a context whose `params` is a promise (the convention
// AGENTS.md mandates), they can be invoked with no server running.

import { NextRequest } from 'next/server';

const DEFAULT_ORIGIN = 'http://localhost:3000';

export interface ApiRequestInit {
  method?: string;
  /** Serialised as JSON, with content-type set unless you override it. */
  body?: unknown;
  /** Sent verbatim. Use for multipart bodies and for malformed-JSON tests. */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  /** Names and values are used verbatim, so keep values cookie-safe. */
  cookies?: Record<string, string>;
  searchParams?: Record<string, string | number | boolean | undefined>;
}

/**
 * Builds a NextRequest for `url`, which may be a path (resolved against
 * http://localhost:3000) or an absolute URL.
 *
 * The method defaults to GET, or to POST when a body is supplied, because the
 * fetch spec rejects a GET request that carries one.
 */
export function apiRequest(url: string, init: ApiRequestInit = {}): NextRequest {
  const target = new URL(url, DEFAULT_ORIGIN);

  for (const [key, value] of Object.entries(init.searchParams ?? {})) {
    if (value === undefined) continue;
    target.searchParams.set(key, String(value));
  }

  const headers = new Headers(init.headers);

  let body: BodyInit | undefined;
  if (init.rawBody !== undefined) {
    body = init.rawBody;
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  }

  const cookieEntries = Object.entries(init.cookies ?? {});
  if (cookieEntries.length > 0) {
    headers.set('cookie', cookieEntries.map(([name, value]) => `${name}=${value}`).join('; '));
  }

  const method = init.method ?? (body === undefined ? 'GET' : 'POST');

  return new NextRequest(target, { method, headers, body });
}

/**
 * A route handler as exported from app/api/**\/route.ts.
 *
 * `undefined` is in the return type because several handlers return a value
 * whose type TypeScript widens to `NextResponse | undefined` (the early-return
 * branches out of a discriminated result object). callRoute turns that into a
 * loud failure rather than propagating it.
 */
export type RouteHandler<P> = (
  request: NextRequest,
  context: { params: Promise<P> }
) => Promise<Response | undefined> | Response | undefined;

/**
 * Invokes a route handler, wrapping `params` in the resolved promise the App
 * Router passes in. Handlers that take no params can be called with two
 * arguments.
 */
export async function callRoute<P extends Record<string, string | string[]>>(
  handler: RouteHandler<P>,
  request: NextRequest,
  params: P = {} as P
): Promise<Response> {
  const response = await handler(request, { params: Promise.resolve(params) });
  if (!response) {
    throw new Error(
      `Route handler for ${request.method} ${request.url} returned no response. ` +
        'Next.js would turn that into a 500.'
    );
  }
  return response;
}

/** Parses a JSON response body. Fails loudly with the raw text when it is not JSON. */
export async function readJson<T = any>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Expected a JSON body but got status ${response.status} with: ${text.slice(0, 500)}`
    );
  }
}

/** `data` out of a `successResponse()` envelope. */
export async function readData<T = any>(response: Response): Promise<T> {
  const payload = await readJson<{ data: T }>(response);
  return payload.data;
}

/** `error` out of an `errorResponse()` envelope. */
export async function readError(response: Response): Promise<string> {
  const payload = await readJson<{ error?: string }>(response);
  return payload.error ?? '';
}

/** Builds a multipart body for the upload routes. */
export function multipart(fields: Record<string, string | Blob>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }
  return form;
}
