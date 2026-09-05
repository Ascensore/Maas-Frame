import { NextRequest } from 'next/server';
import { apiErrors } from '@/lib/api-response';
import { isAuthError, loadVersionForUser, withApiAuth } from '@/lib/v1-auth';
import { logError } from '@/lib/logger';
import {
  commentLiveChannel,
  connectCommentLiveListener,
  formatSseEvent,
  parseCommentLiveEvent,
  shouldListenForCommentLive,
} from '@/lib/comment-live';

type RouteParams = { params: Promise<{ versionId: string }> };

// Same ceiling as the browser stream: a longer one pins a LISTEN connection
// until the platform kills the function. Panels reconnect.
export const maxDuration = 25;

/**
 * The NLE panels' version of the comment stream. Identical mechanics to
 * `app/api/versions/[versionId]/comments/live`, except it authenticates a Bearer
 * API token rather than a browser session, which is the only reason a panel
 * cannot use that one.
 *
 * This is an accelerator, never the delivery mechanism. `shouldListenForCommentLive()`
 * is false on Vercel, where this degrades to `ready` plus pings and the panel's
 * own poll is what actually delivers comments.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;

    const { versionId } = await params;
    const loaded = await loadVersionForUser(versionId, authContext.userId);
    if ('error' in loaded) return loaded.error;

    if (!commentLiveChannel(versionId)) {
      return apiErrors.badRequest('versionId cannot be used as a live channel');
    }

    const listen = shouldListenForCommentLive();
    const listener = listen ? await connectCommentLiveListener(versionId) : null;
    if (listen && !listener) {
      return apiErrors.internalError('Failed to subscribe to comment updates');
    }

    const encoder = new TextEncoder();
    const client = listener?.client ?? null;
    const channel = listener?.channel ?? null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const close = async () => {
      if (closed) return;
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (!client) return;
      try {
        await client.query('UNLISTEN *');
      } catch {
        // The socket may already be gone.
      }
      await client.end().catch(() => undefined);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            void close();
          }
        };

        // `listening: false` tells the panel this deployment cannot push, so it
        // can keep polling rather than trusting a stream that will stay silent.
        send(formatSseEvent('ready', { versionId, listening: Boolean(client) }));

        if (client && channel) {
          client.on('notification', (message) => {
            if (message.channel !== channel) return;
            const payload = parseCommentLiveEvent(message.payload ?? '') ?? { versionId };
            send(formatSseEvent('comments', payload));
          });

          client.on('error', (error) => {
            logError('v1 comment live listener error:', error);
            void close();
            try {
              controller.close();
            } catch {
              // already closed
            }
          });
        }

        pingTimer = setInterval(() => send(': ping\n\n'), 15000);
        request.signal.addEventListener('abort', () => {
          void close();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
      cancel() {
        return close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'private, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    logError('Error opening v1 comment live stream:', error);
    return apiErrors.internalError('Failed to subscribe to comment updates');
  }
}
