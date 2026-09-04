export const IMPORT_SOURCE_KEY = 'import_source';
export const IMPORT_FILE_ID_KEY = 'import_file_id';
export const IMPORT_STATUS_KEY = 'import_status';
export const IMPORT_ERROR_KEY = 'import_error';

export type DriveImportStatus = 'pending' | 'ready' | 'failed';

export type DriveImportClassification =
  | { ok: true; fileId: string }
  | { ok: false; reason: 'empty' | 'not-drive' | 'folder' | 'invalid' };

const FOLDER_PATH = /\/folders\//;
const FILE_ID_PATTERN = /^[a-zA-Z0-9_-]{20,80}$/;

function extractDriveFileId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== 'drive.google.com' && host !== 'docs.google.com') return null;
  if (parsed.pathname.includes('/folders/')) return null;

  const fromPath = parsed.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fromPath?.[1] && FILE_ID_PATTERN.test(fromPath[1])) return fromPath[1];

  const fromQuery = parsed.searchParams.get('id');
  if (fromQuery && FILE_ID_PATTERN.test(fromQuery)) return fromQuery;
  return null;
}

export function classifyDriveImportUrl(url: string): DriveImportClassification {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const host = parsed.hostname.toLowerCase();
  const isDrive = host === 'drive.google.com' || host === 'docs.google.com';
  if (!isDrive) return { ok: false, reason: 'not-drive' };
  if (FOLDER_PATH.test(parsed.pathname)) return { ok: false, reason: 'folder' };

  const fileId = extractDriveFileId(trimmed);
  if (!fileId) return { ok: false, reason: 'invalid' };
  return { ok: true, fileId };
}

export function driveImportRefusalMessage(
  reason: Exclude<DriveImportClassification, { ok: true }>['reason']
): string {
  if (reason === 'folder') {
    return 'Google Drive folders cannot be imported. Paste a link to a single file that is shared with anyone with the link.';
  }
  if (reason === 'not-drive') {
    return 'Only Google Drive file links can be imported';
  }
  if (reason === 'empty') {
    return 'A Google Drive file link is required';
  }
  return 'That Google Drive link cannot be imported. Use a file share link, not a folder.';
}

export function driveDownloadUrl(fileId: string, confirm?: string): string {
  const parsed = new URL('https://drive.google.com/uc');
  parsed.searchParams.set('export', 'download');
  parsed.searchParams.set('id', fileId);
  if (confirm) parsed.searchParams.set('confirm', confirm);
  return parsed.toString();
}

export function isDriveVirusScanHtml(body: string): boolean {
  const sample = body.slice(0, 12_000).toLowerCase();
  if (!sample.includes('<html') && !sample.includes('<!doctype')) return false;
  return (
    sample.includes('virus scan warning') ||
    sample.includes('uc-download-link') ||
    sample.includes('google drive') ||
    sample.includes('download anyway')
  );
}

export function extractDriveConfirmToken(html: string): string | null {
  const quoted = /confirm=([0-9A-Za-z_-]+)/.exec(html);
  if (quoted?.[1] && quoted[1] !== 't') return quoted[1];
  const input = /name=["']confirm["'][^>]*value=["']([0-9A-Za-z_-]+)["']/.exec(html);
  if (input?.[1]) return input[1];
  return 't';
}

export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const utf = /filename\*=(?:UTF-8''|utf-8'')([^;]+)/i.exec(header);
  if (utf?.[1]) {
    try {
      return decodeURIComponent(utf[1].trim().replace(/^["']|["']$/g, ''));
    } catch {
      return utf[1].trim();
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || null;
}

export function looksLikeVideoBytes(bytes: Uint8Array): boolean {
  if (bytes.length >= 12) {
    const box = String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0);
    if (box === 'ftyp') return true;
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return true;
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    return true;
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x41 &&
    bytes[9] === 0x56 &&
    bytes[10] === 0x49 &&
    bytes[11] === 0x20
  ) {
    return true;
  }
  return false;
}

export function readImportStatus(metadata: unknown): DriveImportStatus | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[IMPORT_STATUS_KEY];
  if (raw === 'pending' || raw === 'ready' || raw === 'failed') return raw;
  return null;
}

export function readImportFileId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[IMPORT_FILE_ID_KEY];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export function importMetadata(options: {
  fileId: string;
  status: DriveImportStatus;
  error?: string;
}): Record<string, string> {
  const value: Record<string, string> = {
    [IMPORT_SOURCE_KEY]: 'gdrive',
    [IMPORT_FILE_ID_KEY]: options.fileId,
    [IMPORT_STATUS_KEY]: options.status,
  };
  if (options.error) value[IMPORT_ERROR_KEY] = options.error.slice(0, 200);
  return value;
}

export type DriveDownloadResult = {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
};

export class DriveImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveImportError';
  }
}

async function readDriveResponse(
  response: Response,
  fileId: string
): Promise<{ kind: 'html'; html: string } | { kind: 'file'; result: DriveDownloadResult }> {
  const contentType = (response.headers.get('content-type') || 'application/octet-stream')
    .split(';')[0]!
    .trim();
  const buffer = new Uint8Array(await response.arrayBuffer());
  const asText = new TextDecoder('utf-8', { fatal: false }).decode(buffer.slice(0, 12_000));
  if (contentType.includes('text/html') || isDriveVirusScanHtml(asText)) {
    return { kind: 'html', html: new TextDecoder('utf-8', { fatal: false }).decode(buffer) };
  }
  const fileName =
    filenameFromContentDisposition(response.headers.get('content-disposition')) ?? `${fileId}.mp4`;
  return {
    kind: 'file',
    result: { bytes: buffer, contentType, fileName },
  };
}

export async function downloadPublicDriveFile(
  fileId: string,
  fetchImpl: typeof fetch = fetch
): Promise<DriveDownloadResult> {
  const first = await fetchImpl(driveDownloadUrl(fileId), { redirect: 'follow' });
  if (!first.ok && first.status !== 200) {
    throw new DriveImportError(
      'Could not download that Google Drive file. It must be shared with anyone with the link.'
    );
  }
  const parsed = await readDriveResponse(first, fileId);
  if (parsed.kind === 'file') return parsed.result;

  const confirm = extractDriveConfirmToken(parsed.html);
  const retry = await fetchImpl(driveDownloadUrl(fileId, confirm ?? 't'), { redirect: 'follow' });
  if (!retry.ok) {
    throw new DriveImportError(
      'Google Drive asked for a virus-scan confirmation and the file still could not be downloaded. Share it with anyone with the link.'
    );
  }
  const retried = await readDriveResponse(retry, fileId);
  if (retried.kind === 'html') {
    throw new DriveImportError(
      'Google Drive served a confirmation page instead of the file. Share the file with anyone with the link and try again.'
    );
  }
  return retried.result;
}
