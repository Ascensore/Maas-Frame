import { NextRequest } from 'next/server';
import { MediaJobKind } from '@prisma/client';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { applyOverrides, parseRoughCutOverrides } from '@/lib/rough-cut/overrides';
import { findActiveMaterializeJob, loadRoughCutForEditor } from '@/lib/rough-cut/review';

type RouteParams = { params: Promise<{ roughCutId: string }> };

/**
 * Re-cut the delivered video from the saved overrides. The work is a media job,
 * so this answers 202 and the pane follows the render state on the review
 * payload. One render at a time per run: a second one would race the first for
 * the output video's next version.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { roughCutId } = await params;
    const loaded = await loadRoughCutForEditor(roughCutId, session.user.id, 'render');
    if ('error' in loaded) return loaded.error;
    const { row, decisions } = loaded;

    if (decisions.edits.length === 0) {
      return apiErrors.badRequest('Rough cut has nothing to render');
    }

    // What the worker will actually cut. A reviewer can cut the last of the
    // program away, and the job would then fail on the same check deep inside
    // ffmpeg's temp directory; refuse it here, where they can undo it.
    const effective = applyOverrides(decisions, parseRoughCutOverrides(row.overrides));
    const firstEdit = effective.edits[0];
    if (!firstEdit) {
      return apiErrors.badRequest('Nothing is left in the program after the reviewer’s cuts');
    }

    // Checking for a running render and queueing one has to be one step, or two
    // clicks a moment apart both see an idle cut and queue a job each. The lock
    // is per rough cut, so renders of different cuts never wait on each other.
    const job = await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          ('x' || left(md5(${roughCutId}), 16))::bit(64)::bigint
        )
      `;
      const active = await findActiveMaterializeJob(roughCutId, tx);
      if (active) return null;
      // Created here rather than through enqueueMediaJob so the insert shares
      // the transaction that holds the lock.
      return tx.mediaJob.create({
        data: {
          versionId: firstEdit.sourceVersionId,
          kind: MediaJobKind.MATERIALIZE_ROUGH_CUT,
          payload: { roughCutId },
        },
        select: { id: true, status: true },
      });
    });
    if (!job) return apiErrors.conflict('A render is already running for this cut');

    return withCacheControl(
      successResponse({ job: { id: job.id, status: job.status } }, 202),
      'private, no-store'
    );
  } catch (error) {
    logError('Error queueing a rough cut render:', error);
    return apiErrors.internalError('Failed to queue the rough cut render');
  }
}
