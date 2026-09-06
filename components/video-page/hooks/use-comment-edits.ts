'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { CommentEditAction, CommentEditView } from '@/lib/comment-edit/types';

export function useCommentEdits(
  versionId: string | null,
  enabled: boolean,
  onResolved: (versionId: string) => Promise<void>
) {
  const [state, setState] = useState<{
    versionId: string | null;
    tasks: CommentEditView[];
    error: string | null;
  }>({ versionId: null, tasks: [], error: null });
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const pending = useRef(new Set<string>());
  const generation = useRef(0);
  const mutationRevision = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    if (!enabled || !versionId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const revision = mutationRevision.current;
      try {
        const response = await fetch(`/api/versions/${versionId}/edit-tasks`, {
          cache: 'no-store',
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? 'Could not load editing tasks');
        if (
          !stopped &&
          current === generation.current &&
          revision === mutationRevision.current &&
          pending.current.size === 0
        )
          setState({ versionId, tasks: payload.data.tasks, error: null });
      } catch (error) {
        if (!stopped && current === generation.current)
          setState((old) => ({
            versionId,
            tasks: old.versionId === versionId ? old.tasks : [],
            error: error instanceof Error ? error.message : 'Could not load editing tasks',
          }));
      } finally {
        if (!stopped) timer = setTimeout(() => void refresh(), 3000);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [versionId, enabled]);

  const act = useCallback(
    async (commentId: string, action: CommentEditAction) => {
      if (!enabled || !versionId || pending.current.has(commentId)) return false;
      pending.current.add(commentId);
      mutationRevision.current++;
      setBusyIds([...pending.current]);
      const current = generation.current;
      try {
        const response = await fetch(`/api/comments/${commentId}/edit-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? 'Could not update editing task');
        if (current === generation.current)
          setState((old) => ({
            versionId,
            error: null,
            tasks: [
              ...(old.versionId === versionId
                ? old.tasks.filter((task) => task.commentId !== commentId)
                : []),
              payload.data.task,
            ],
          }));
        if (action === 'accept' || action === 'human') await onResolved(versionId);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not update editing task');
        return false;
      } finally {
        pending.current.delete(commentId);
        mutationRevision.current++;
        setBusyIds([...pending.current]);
      }
    },
    [versionId, enabled, onResolved]
  );

  return {
    tasks: state.versionId === versionId ? state.tasks : [],
    error: state.versionId === versionId ? state.error : null,
    busyIds,
    act,
  };
}
