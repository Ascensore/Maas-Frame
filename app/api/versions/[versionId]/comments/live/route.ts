import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, computeProjectAccess, projectAccessInclude } from '@/lib/auth';
import { apiErrors } from '@/lib/api-response';
import { validateShareLinkAccess } from '@/lib/share-links';
import { getShareSessionFromRequest } from '@/lib/share-session';
import { logError } from '@/lib/logger';
import {
  commentLiveChannel,
  connectCommentLiveListener,
  formatSseEvent,
  parseCommentLiveEvent,
  shouldListenForCommentLive,
} from '@/lib/comment-live';

type RouteParams = { params: Promise<{ versionId: string }> };

// Keep this well under the session-pooler idle window. A 300s stream used to
// pin a LISTEN connection until Vercel killed the function, which is how a
// few open review pages exhausted the 15-client cap.
export const maxDuration = 25;

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    const { versionId } = await params;
    const userId = session?.user?.id;

    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      include: {
        video: {
          include: {
            project: { include: projectAccessInclude(userId) },
          },
        },
      },
    });
    if (!version) return apiErrors.notFound('Version');

    const project = version.video.project;
    const access = computeProjectAccess(project, userId);
    const shareSession = getShareSessionFromRequest(request, version.video.id);
    const shareAccess = shareSession
      ? await validateShareLinkAccess({
          token: shareSession.token,
          projectId: project.id,
          videoId: version.video.id,
          requiredPermission: 'VIEW',
          passwordVerified: shareSession.passwordVerified,
        })
      : { hasAccess: false, requiresPassword: false };

    if (!access.hasAccess && !shareAccess.hasAccess) {
      return apiErrors.forbidden('Access denied');
    }

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

        send(formatSseEvent('ready', { versionId }));

        if (client && channel) {
          client.on('notification', (message) => {
            if (message.channel !== channel) return;
            const payload = parseCommentLiveEvent(message.payload ?? '') ?? { versionId };
            send(formatSseEvent('comments', payload));
          });

          client.on('error', (error) => {
            logError('Comment live listener error:', error);
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
    logError('Error opening comment live stream:', error);
    return apiErrors.internalError('Failed to subscribe to comment updates');
  }
}
