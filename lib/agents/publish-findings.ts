import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { notifyCommentChanged } from '@/lib/comment-live';
import { deriveTimestampFrame } from '@/lib/timecode';
import { prepareFindingsForPublish } from '@/lib/agents/findings';
import type { ReviewFinding } from '@/lib/agents/types';

export function findingFingerprint(finding: ReviewFinding): string {
  const payload = `${finding.timestamp}\t${finding.timestampEnd ?? ''}\t${finding.body}`;
  return createHash('sha256').update(payload).digest('hex');
}

export async function publishFindings(options: {
  versionId: string;
  agentRunId: string;
  agentSlug: string;
  findings: ReviewFinding[];
  duration: number | null;
  frameRateNum: number | null;
  frameRateDen: number | null;
  projectId: string;
}): Promise<{ posted: number; skipped: number }> {
  const prepared = prepareFindingsForPublish(options.findings, options.duration);
  if (prepared.length === 0) {
    return { posted: 0, skipped: 0 };
  }

  const tags = await db.commentTag.findMany({
    where: { projectId: options.projectId },
    select: { id: true, name: true },
  });
  const tagIdByName = new Map(tags.map((tag) => [tag.name, tag.id]));

  let posted = 0;
  let skipped = 0;

  for (const finding of prepared) {
    const fingerprint = findingFingerprint(finding);
    try {
      await db.comment.create({
        data: {
          versionId: options.versionId,
          content: finding.body,
          timestamp: finding.timestamp,
          timestampEnd: finding.timestampEnd ?? null,
          timestampFrame: deriveTimestampFrame(
            finding.timestamp,
            options.frameRateNum,
            options.frameRateDen
          ),
          source: 'AGENT',
          agentRunId: options.agentRunId,
          agentSlug: options.agentSlug,
          agentFingerprint: fingerprint,
          tagId: finding.tagName ? (tagIdByName.get(finding.tagName) ?? null) : null,
        },
      });
      posted += 1;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }

  if (posted > 0) {
    await notifyCommentChanged(options.versionId);
  }

  return { posted, skipped };
}
