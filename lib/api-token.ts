import { createHash, randomBytes } from 'crypto';
import { db } from '@/lib/db';

const TOKEN_BYTES = 32;
const PREFIX = 'of_live_';

export function hashApiToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateApiToken(): { raw: string; hash: string; prefix: string } {
  const raw = `${PREFIX}${randomBytes(TOKEN_BYTES).toString('hex')}`;
  return {
    raw,
    hash: hashApiToken(raw),
    prefix: raw.slice(0, PREFIX.length + 8),
  };
}

export function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1];
  if (!token.startsWith(PREFIX) || token.length < PREFIX.length + 16) return null;
  return token;
}

export async function resolveApiToken(
  raw: string
): Promise<{ userId: string; tokenId: string } | null> {
  const hash = hashApiToken(raw);
  const row = await db.apiToken.findUnique({
    where: { tokenHash: hash },
    select: { id: true, userId: true, revokedAt: true, expiresAt: true },
  });

  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  // Best-effort last-used stamp. A failure here must not fail the request.
  db.apiToken
    .update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => undefined);

  return { userId: row.userId, tokenId: row.id };
}
