import { db } from '@/lib/db';
import type { AgentContext, AgentContextComment, AgentContextCue } from '@/lib/agents/types';

export async function loadAgentContext(
  versionId: string,
  brief: string | null
): Promise<AgentContext> {
  const version = await db.videoVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      title: true,
      duration: true,
      frameRateNum: true,
      frameRateDen: true,
      video: { select: { title: true, project: { select: { name: true } } } },
    },
  });
  if (!version) {
    throw new Error(`Version ${versionId} not found`);
  }

  const [transcript, comments] = await Promise.all([
    db.transcript.findFirst({
      where: { versionId, status: 'READY' },
      orderBy: { updatedAt: 'desc' },
      select: {
        language: true,
        segments: {
          orderBy: { position: 'asc' },
          select: { startSec: true, endSec: true, text: true },
        },
      },
    }),
    db.comment.findMany({
      where: { versionId, parentId: null },
      orderBy: { timestamp: 'asc' },
      take: 200,
      select: {
        id: true,
        timestamp: true,
        timestampEnd: true,
        content: true,
        isResolved: true,
        source: true,
      },
    }),
  ]);

  const segments: AgentContextCue[] =
    transcript?.segments.map((segment) => ({
      start: segment.startSec,
      end: segment.endSec,
      text: segment.text,
    })) ?? [];

  const contextComments: AgentContextComment[] = comments.map((comment) => ({
    id: comment.id,
    timestamp: comment.timestamp,
    timestampEnd: comment.timestampEnd,
    content: comment.content,
    isResolved: comment.isResolved,
    source: comment.source,
  }));

  return {
    version: {
      id: version.id,
      title: version.title ?? version.video.title,
      duration: version.duration,
      projectName: version.video.project.name,
      frameRateNum: version.frameRateNum,
      frameRateDen: version.frameRateDen,
    },
    transcript: transcript ? { language: transcript.language, segments } : null,
    comments: contextComments,
    brief,
  };
}
