import crypto from 'crypto';

const R2_UPLOAD_TOKEN_TYPE = 'r2-upload';
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;

interface R2UploadTokenPayload {
  typ: typeof R2_UPLOAD_TOKEN_TYPE;
  uid: string;
  pid: string;
  key: string;
  sid: string;
  jti: string;
  tkey: string;
  iat: number;
  exp: number;
}

export interface R2UploadTokenSubject {
  userId: string;
  projectId: string;
  objectKey: string;
  sessionId?: string;
  tokenId?: string;
  thumbnailObjectKey?: string;
}

function getR2UploadTokenSecret(): string {
  const secret = process.env.R2_UPLOAD_TOKEN_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('Missing R2_UPLOAD_TOKEN_SECRET or NEXTAUTH_SECRET.');
  }
  return secret;
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function isValidPayload(value: unknown): value is R2UploadTokenPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<R2UploadTokenPayload>;
  return (
    payload.typ === R2_UPLOAD_TOKEN_TYPE &&
    typeof payload.uid === 'string' &&
    typeof payload.pid === 'string' &&
    typeof payload.key === 'string' &&
    typeof payload.sid === 'string' &&
    typeof payload.jti === 'string' &&
    typeof payload.tkey === 'string' &&
    typeof payload.iat === 'number' &&
    Number.isFinite(payload.iat) &&
    typeof payload.exp === 'number' &&
    Number.isFinite(payload.exp)
  );
}

export function createR2UploadToken(
  subject: R2UploadTokenSubject & {
    sessionId: string;
    tokenId: string;
    thumbnailObjectKey: string;
  },
  ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: R2UploadTokenPayload = {
    typ: R2_UPLOAD_TOKEN_TYPE,
    uid: subject.userId,
    pid: subject.projectId,
    key: subject.objectKey,
    sid: subject.sessionId,
    jti: subject.tokenId,
    tkey: subject.thumbnailObjectKey,
    iat: now,
    exp: now + ttlSeconds,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signPayload(encodedPayload, getR2UploadTokenSecret());
  return `${encodedPayload}.${signature}`;
}

export function verifyR2UploadToken(token: string, subject: R2UploadTokenSubject): boolean {
  const payload = parseR2UploadToken(token);
  if (!payload) return false;

  if (
    payload.uid !== subject.userId ||
    payload.pid !== subject.projectId ||
    payload.key !== subject.objectKey
  ) {
    return false;
  }

  if (subject.sessionId && payload.sid !== subject.sessionId) return false;
  if (subject.tokenId && payload.jti !== subject.tokenId) return false;
  if (subject.thumbnailObjectKey && payload.tkey !== subject.thumbnailObjectKey) return false;

  return true;
}

export function parseR2UploadToken(token: string): R2UploadTokenPayload | null {
  // Resolved before the try. A server booted with neither R2_UPLOAD_TOKEN_SECRET nor
  // NEXTAUTH_SECRET set is misconfigured, and swallowing that throw made it answer
  // "invalid token" for every upload grant: a total upload outage that looks like a
  // client bug and says nothing about why.
  const secret = getR2UploadTokenSecret();

  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [encodedPayload, providedSignature] = parts;
    if (!encodedPayload || !providedSignature) return null;

    const expectedSignature = signPayload(encodedPayload, secret);
    const providedBuffer = Buffer.from(providedSignature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (providedBuffer.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return null;

    const payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const payloadUnknown: unknown = JSON.parse(payloadJson);

    if (!isValidPayload(payloadUnknown)) return null;

    const payload = payloadUnknown;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
