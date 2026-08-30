#!/usr/bin/env bun
/**
 * Upload review media with a project camera-ingest token (of_c2c_…).
 *
 *   bun run scripts/c2c-ingest.ts --base-url http://localhost:3000 --token of_c2c_… --file clip.mov
 *   bun run scripts/c2c-ingest.ts --watch ./card --base-url http://localhost:3000 --token of_c2c_…
 *
 * OPENFRAME_BASE_URL and C2C_TOKEN can stand in for the flags.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getPartByteRange } from '@/lib/client/upload-chunking';
import {
  c2cAuthHeaders,
  c2cCreateVideoBody,
  parseC2cIngestArgs,
  parseC2cWatchState,
  shouldIngestFileName,
  shouldSkipWatchedFile,
  titleFromIngestFileName,
  type C2cWatchRecord,
} from '@/lib/c2c-ingest';

type InitData = {
  presignedPutUrl: string;
  objectKey: string;
  proxyUrl: string;
  uploadToken: string;
  contentType: string;
  multipart: {
    partSizeBytes: number;
    parts: Array<{ partNumber: number; url: string }>;
  } | null;
};

async function readJson(response: Response): Promise<{ data?: InitData; error?: string }> {
  return (await response.json().catch(() => null)) as { data?: InitData; error?: string };
}

async function putBytes(
  url: string,
  body: Uint8Array,
  contentType?: string
): Promise<string | null> {
  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;
  const response = await fetch(url, { method: 'PUT', headers, body: Buffer.from(body) });
  if (!response.ok) {
    throw new Error(`Upload PUT failed with HTTP ${response.status}`);
  }
  return response.headers.get('etag');
}

async function ingestFile(
  baseUrl: string,
  token: string,
  filePath: string,
  titleOverride: string | null
) {
  const fileName = basename(filePath);
  if (!shouldIngestFileName(fileName)) {
    throw new Error(`unsupported review file: ${fileName}`);
  }
  const bytes = new Uint8Array(await readFile(filePath));
  const sizeBytes = bytes.byteLength;
  const headers = c2cAuthHeaders(token);

  const initRes = await fetch(`${baseUrl}/api/c2c/r2-init`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fileName, sizeBytes: sizeBytes.toString() }),
  });
  const initPayload = await readJson(initRes);
  if (!initRes.ok || !initPayload.data) {
    throw new Error(initPayload.error || `r2-init failed with HTTP ${initRes.status}`);
  }
  const init = initPayload.data;

  if (init.multipart) {
    const completed: Array<{ partNumber: number; etag: string }> = [];
    for (const part of init.multipart.parts) {
      const { start, end } = getPartByteRange(
        part.partNumber,
        init.multipart.partSizeBytes,
        sizeBytes
      );
      const etag = await putBytes(part.url, bytes.subarray(start, end));
      if (!etag) throw new Error(`part ${part.partNumber} response missing ETag`);
      completed.push({ partNumber: part.partNumber, etag });
    }
    const completeRes = await fetch(`${baseUrl}/api/c2c/r2-complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        objectKey: init.objectKey,
        uploadToken: init.uploadToken,
        parts: completed,
      }),
    });
    if (!completeRes.ok) {
      const payload = await readJson(completeRes);
      throw new Error(payload.error || `r2-complete failed with HTTP ${completeRes.status}`);
    }
  } else {
    await putBytes(init.presignedPutUrl, bytes, init.contentType);
  }

  const title = titleOverride?.trim() || titleFromIngestFileName(fileName);
  const createRes = await fetch(`${baseUrl}/api/c2c/videos`, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      c2cCreateVideoBody({
        title,
        proxyUrl: init.proxyUrl,
        objectKey: init.objectKey,
        uploadToken: init.uploadToken,
        duration: null,
      })
    ),
  });
  if (!createRes.ok) {
    const payload = await readJson(createRes);
    throw new Error(payload.error || `create video failed with HTTP ${createRes.status}`);
  }
  console.log(`ingested ${fileName} as ${title}`);
}

const WATCH_STATE = '.c2c-ingested.json';

async function loadWatchState(dir: string): Promise<Record<string, C2cWatchRecord>> {
  try {
    return parseC2cWatchState(await readFile(join(dir, WATCH_STATE), 'utf8'));
  } catch {
    return {};
  }
}

async function saveWatchState(dir: string, state: Record<string, C2cWatchRecord>) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, WATCH_STATE), `${JSON.stringify(state, null, 2)}\n`);
}

async function scanWatchDir(
  baseUrl: string,
  token: string,
  dir: string,
  state: Record<string, C2cWatchRecord>
) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === WATCH_STATE) continue;
    if (!shouldIngestFileName(entry.name)) continue;
    const full = join(dir, entry.name);
    const info = await stat(full);
    if (shouldSkipWatchedFile(state[entry.name], info.size, info.mtimeMs)) continue;
    await ingestFile(baseUrl, token, full, null);
    state[entry.name] = { sizeBytes: info.size, mtimeMs: info.mtimeMs };
    await saveWatchState(dir, state);
  }
}

async function main() {
  const parsed = parseC2cIngestArgs(process.argv.slice(2), {
    OPENFRAME_BASE_URL: process.env.OPENFRAME_BASE_URL,
    C2C_TOKEN: process.env.C2C_TOKEN,
  });
  if ('error' in parsed) {
    console.error(parsed.error);
    console.error(
      'usage: bun run scripts/c2c-ingest.ts --base-url URL --token of_c2c_… --file clip.mov [--watch DIR]'
    );
    process.exit(1);
  }

  for (const file of parsed.files) {
    await ingestFile(parsed.baseUrl, parsed.token, file, parsed.title);
  }

  if (!parsed.watchDir) return;
  const state = await loadWatchState(parsed.watchDir);
  await scanWatchDir(parsed.baseUrl, parsed.token, parsed.watchDir, state);
  console.log(`watching ${parsed.watchDir}`);
  setInterval(() => {
    void scanWatchDir(parsed.baseUrl, parsed.token, parsed.watchDir as string, state).catch(
      (error) => {
        console.error(error instanceof Error ? error.message : error);
      }
    );
  }, 2000);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
