import { Client } from 'pg';
import { logError } from '@/lib/logger';

const VERSION_ID_RE = /^[a-z0-9_-]{8,64}$/i;

export function commentLiveChannel(versionId: string): string | null {
  if (!VERSION_ID_RE.test(versionId)) return null;
  return `ofc_${versionId}`;
}

export function encodeCommentLiveEvent(versionId: string): string {
  return JSON.stringify({ versionId });
}

export function parseCommentLiveEvent(payload: string): { versionId: string } | null {
  try {
    const parsed = JSON.parse(payload) as { versionId?: unknown };
    if (typeof parsed?.versionId !== 'string' || !parsed.versionId) return null;
    return { versionId: parsed.versionId };
  } catch {
    return null;
  }
}

export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function quotePgIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * LISTEN holds a dedicated session-mode connection for the whole SSE lifetime.
 * On Vercel that pins a slot in a 15-client pooler and takes down every
 * dashboard page (`EMAXCONNSESSION`). The client already polls comments.
 */
export function shouldListenForCommentLive(): boolean {
  return process.env.VERCEL !== '1';
}

export async function connectCommentLiveListener(
  versionId: string
): Promise<{ client: Client; channel: string } | null> {
  const channel = commentLiveChannel(versionId);
  const connectionString = process.env.DATABASE_URL;
  if (!channel || !connectionString) return null;
  const client = new Client({
    connectionString,
    application_name: `ofc-live:${versionId}`,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${quotePgIdent(channel)}`);
    return { client, channel };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

export async function notifyCommentChanged(versionId: string): Promise<void> {
  const channel = commentLiveChannel(versionId);
  if (!channel) return;
  try {
    const { db } = await import('@/lib/db');
    await db.$executeRaw`SELECT pg_notify(${channel}, ${encodeCommentLiveEvent(versionId)})`;
  } catch (error) {
    logError('Failed to notify comment listeners:', error);
  }
}
