import bcrypt from 'bcryptjs';
import { SharePermission, type ShareLink } from '@prisma/client';
import { db } from '@/lib/db';
import { nextSeq } from './seq';

// Matches tests/factories/user.ts: low cost, because bcrypt.compare() works
// against any cost factor and the production one is pure test latency.
const TEST_BCRYPT_ROUNDS = 4;

export interface CreateShareLinkInput {
  projectId: string;
  /** Null (the default) is a project-wide link; a video id scopes it. */
  videoId?: string | null;
  permission?: SharePermission;
  token?: string;
  /** Plain text. Hashed into passwordHash, so the row never holds it. */
  password?: string;
  expiresAt?: Date | null;
  allowGuests?: boolean;
  allowDownloads?: boolean;
}

export async function createShareLink(input: CreateShareLinkInput): Promise<ShareLink> {
  const seq = nextSeq();
  return db.shareLink.create({
    data: {
      projectId: input.projectId,
      videoId: input.videoId ?? null,
      permission: input.permission ?? SharePermission.VIEW,
      token: input.token ?? `share-token-${seq}`,
      passwordHash:
        input.password === undefined ? null : await bcrypt.hash(input.password, TEST_BCRYPT_ROUNDS),
      expiresAt: input.expiresAt ?? null,
      allowGuests: input.allowGuests ?? true,
      allowDownloads: input.allowDownloads ?? false,
    },
  });
}
