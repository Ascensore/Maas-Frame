import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { syncCaptionTrackFromTranscript } from '@/lib/transcript-caption';
import { parseSegmentPatch, retimeSegmentWords } from '@/lib/transcript-edit';

type RouteParams = { params: Promise<{ versionId: string; segmentId: string }> };

/**
 * Fix a misheard word in one transcript line. The words keep their timings when
 * the count is unchanged; otherwise they are spread across the line, the rule an
 * uploaded SRT already follows. The caption track is rebuilt from the transcript
 * afterwards so the subtitles the player shows never drift from what the pane
 * reads.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return apiErrors.unauthorized();

    const { versionId, segmentId } = await params;
    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      select: {
        video: {
          select: {
            project: {
              select: {
                id: true,
                ownerId: true,
                workspaceId: true,
                visibility: true,
                workspace: { select: { ownerId: true } },
              },
            },
          },
        },
      },
    });
    if (!version) return apiErrors.notFound('Version');

    const access = await checkProjectAccess(version.video.project, userId);
    if (!access.hasAccess || !access.canEdit) return apiErrors.forbidden('Access denied');

    const segment = await db.transcriptSegment.findFirst({
      where: { id: segmentId, transcript: { versionId } },
      include: { transcript: { select: { id: true } } },
    });
    if (!segment) return apiErrors.notFound('Transcript line');

    const body = await request.json().catch(() => null);
    const patch = parseSegmentPatch(body);
    if (!patch.ok) return apiErrors.badRequest(patch.error);

    const words = retimeSegmentWords(
      segment.words,
      patch.value.text,
      segment.startSec,
      segment.endSec
    );

    const updated = await db.$transaction(async (tx) => {
      const row = await tx.transcriptSegment.update({
        where: { id: segment.id },
        data: {
          text: patch.value.text,
          words: words as unknown as Prisma.InputJsonValue,
          // An absent `speaker` means the patch did not mention it, which is not
          // the same as clearing it.
          ...('speaker' in patch.value ? { speaker: patch.value.speaker || null } : {}),
        },
      });

      const siblings = await tx.transcriptSegment.findMany({
        where: { transcriptId: segment.transcript.id },
        orderBy: { position: 'asc' },
        select: { text: true },
      });
      await tx.transcript.update({
        where: { id: segment.transcript.id },
        data: { searchText: siblings.map((sibling) => sibling.text).join(' ') },
      });

      return row;
    });

    let captions: 'updated' | 'skipped' | 'empty' | 'failed' = 'failed';
    try {
      captions = await syncCaptionTrackFromTranscript({
        transcriptId: segment.transcript.id,
        billedUserId: version.video.project.workspace.ownerId,
        uploadedByUserId: userId,
      });
    } catch (captionError) {
      // The edit is saved either way: a caption track we could not rebuild is
      // worth reporting, not worth losing the correction over.
      logError('Failed to rebuild caption track after a transcript edit:', captionError);
    }

    return withCacheControl(
      successResponse({
        segment: {
          id: updated.id,
          startSec: updated.startSec,
          endSec: updated.endSec,
          speaker: updated.speaker,
          text: updated.text,
          words: updated.words,
          position: updated.position,
        },
        captions,
      }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error updating transcript segment:', error);
    return apiErrors.internalError('Failed to update the transcript line');
  }
}
