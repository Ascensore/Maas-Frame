import { createHash, randomBytes } from 'crypto';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/db';

const TOKEN_BYTES = 32;
const PREFIX = 'of_c2c_';

export function hashC2cToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateC2cToken(): { raw: string; hash: string; prefix: string } {
  const raw = `${PREFIX}${randomBytes(TOKEN_BYTES).toString('hex')}`;
  return {
    raw,
    hash: hashC2cToken(raw),
    prefix: raw.slice(0, PREFIX.length + 8),
  };
}

export function extractC2cBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1];
  if (!token.startsWith(PREFIX) || token.length < PREFIX.length + 16) return null;
  return token;
}

export type ResolvedC2cConnection = {
  connectionId: string;
  createdById: string;
  projectId: string;
  folderId: string | null;
  billedUserId: string;
  project: {
    id: string;
    name: string;
    ownerId: string;
    workspaceId: string;
    visibility: 'PRIVATE' | 'INVITE' | 'PUBLIC';
  };
};

export async function resolveC2cConnection(raw: string): Promise<ResolvedC2cConnection | null> {
  const hash = hashC2cToken(raw);
  const row = await db.c2cConnection.findUnique({
    where: { tokenHash: hash },
    select: {
      id: true,
      createdById: true,
      projectId: true,
      folderId: true,
      revokedAt: true,
      project: {
        select: {
          id: true,
          name: true,
          ownerId: true,
          workspaceId: true,
          visibility: true,
          workspace: { select: { ownerId: true } },
        },
      },
    },
  });

  if (!row) return null;
  if (row.revokedAt) return null;

  db.c2cConnection
    .update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => undefined);

  return {
    connectionId: row.id,
    createdById: row.createdById,
    projectId: row.projectId,
    folderId: row.folderId,
    billedUserId: row.project.workspace.ownerId,
    project: {
      id: row.project.id,
      name: row.project.name,
      ownerId: row.project.ownerId,
      workspaceId: row.project.workspaceId,
      visibility: row.project.visibility,
    },
  };
}

export async function loadC2cCaller(request: NextRequest): Promise<ResolvedC2cConnection | null> {
  const raw = extractC2cBearerToken(request.headers.get('authorization'));
  if (!raw) return null;
  return resolveC2cConnection(raw);
}
