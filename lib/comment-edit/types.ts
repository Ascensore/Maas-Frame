import type { z } from 'zod';
import type { graphicPresetSchema } from '@/lib/rough-cut/effects';
export type CommentEditAction = 'human' | 'queue' | 'run' | 'accept' | 'revise' | 'undo';
export type CommentEditChange = { start: number; end: number; detail: string };
export type CommentEditRevisionView = {
  id: string;
  status: 'READY' | 'ACCEPTED' | 'FAILED';
  createdAt: string;
  adjustment: string | null;
  previewUrl: string | null;
  outputHref: string | null;
  error: string | null;
};
export type EditLibraryView = {
  presets: Array<z.infer<typeof graphicPresetSchema>>;
  workspaceId?: string;
  canManagePresets?: boolean;
  assets: Array<{
    versionId: string;
    title: string;
    duration: number;
    visualEvidence?: { frames: Array<{ seconds: number; previewUrl?: string }> };
    analysisJobId?: string | null;
    analysisStatus?: string | null;
    analysisError?: string | null;
  }>;
};
export type CommentEditView = {
  commentId: string;
  status: 'HUMAN' | 'QUEUED' | 'PLANNING' | 'RENDERING' | 'READY' | 'ACCEPTED' | 'FAILED';
  error: string | null;
  instruction: string | null;
  removedSeconds: number | null;
  previewUrl: string | null;
  outputHref: string | null;
  batchSize?: number;
  runId?: string | null;
  adjustment?: string | null;
  changes?: CommentEditChange[];
  revisions?: CommentEditRevisionView[];
};
