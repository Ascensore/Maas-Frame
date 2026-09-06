export type CommentEditAction = 'human' | 'queue' | 'run' | 'accept';
export type CommentEditView = {
  commentId: string;
  status: 'HUMAN' | 'QUEUED' | 'PLANNING' | 'RENDERING' | 'READY' | 'ACCEPTED' | 'FAILED';
  error: string | null;
  instruction: string | null;
  removedSeconds: number | null;
  previewUrl: string | null;
  outputHref: string | null;
};
