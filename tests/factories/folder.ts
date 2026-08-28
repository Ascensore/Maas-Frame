import type { Folder } from '@prisma/client';
import { db } from '@/lib/db';
import { nextSeq } from './seq';

export interface CreateFolderInput {
  projectId: string;
  name?: string;
  parentId?: string | null;
  position?: number;
}

export async function createFolder(input: CreateFolderInput): Promise<Folder> {
  const seq = nextSeq();
  return db.folder.create({
    data: {
      projectId: input.projectId,
      name: input.name ?? `Folder ${seq}`,
      parentId: input.parentId ?? null,
      position: input.position ?? 0,
    },
  });
}
