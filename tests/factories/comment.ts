import type { Comment } from '@prisma/client';
import { db } from '@/lib/db';
import { nextSeq } from './seq';

export interface CreateCommentInput {
  versionId: string;
  authorId?: string | null;
  guestName?: string | null;
  guestEmail?: string | null;
  guestIdentityId?: string | null;
  content?: string | null;
  timestamp?: number;
  timestampEnd?: number | null;
  parentId?: string | null;
  tagId?: string | null;
  annotationData?: string | null;
  imageUrl?: string | null;
  voiceUrl?: string | null;
  voiceDuration?: number | null;
  isResolved?: boolean;
  resolvedAt?: Date | null;
}

export async function createComment(input: CreateCommentInput): Promise<Comment> {
  const seq = nextSeq();
  return db.comment.create({
    data: {
      versionId: input.versionId,
      authorId: input.authorId ?? null,
      guestName: input.guestName ?? null,
      guestEmail: input.guestEmail ?? null,
      guestIdentityId: input.guestIdentityId ?? null,
      content: input.content === undefined ? `Comment ${seq}` : input.content,
      timestamp: input.timestamp ?? 10,
      timestampEnd: input.timestampEnd ?? null,
      parentId: input.parentId ?? null,
      tagId: input.tagId ?? null,
      annotationData: input.annotationData ?? null,
      imageUrl: input.imageUrl ?? null,
      voiceUrl: input.voiceUrl ?? null,
      voiceDuration: input.voiceDuration ?? null,
      isResolved: input.isResolved ?? false,
      resolvedAt: input.resolvedAt ?? null,
    },
  });
}
