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

export async function connectCommentLiveListener(
  versionId: string
): Promise<{ client: Client; channel: string } | null> {
  const channel = commentLiveChannel(versionId);
  const connectionString = process.env.DATABASE_URL;
  if (!channel || !connectionString) return null;
  const client = new Client({
    connectionString,
    application_name: `ofc-live:${versionId}`,
  });
  await client.connect();
  await client.query(`LISTEN ${channel}`);
  return { client, channel };
}

export async function notifyCommentChanged(versionId: string): Promise<void> {
  const channel = commentLiveChannel(versionId);
  const connectionString = process.env.DATABASE_URL;
  if (!channel || !connectionString) return;
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query('SELECT pg_notify($1, $2)', [channel, encodeCommentLiveEvent(versionId)]);
  } catch (error) {
    logError('Failed to notify comment listeners:', error);
  } finally {
    await client.end().catch(() => undefined);
  }
}
