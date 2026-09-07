'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { CommentEditAction, CommentEditView, EditLibraryView } from '@/lib/comment-edit/types';
import type { EditOptions } from '@/lib/comment-edit/plan';

export function useCommentEdits(
  versionId: string | null,
  enabled: boolean,
  onResolved: (versionId: string) => Promise<void>
) {
  const [state, setState] = useState<{
    versionId: string | null;
    tasks: CommentEditView[];
    error: string | null;
    library?: EditLibraryView;
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
          setState({
            versionId,
            tasks: payload.data.tasks,
            library: payload.data.library,
            error: null,
          });
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
    async (commentId: string, action: CommentEditAction, options?: EditOptions) => {
      if (!enabled || !versionId || pending.current.has(commentId)) return false;
      pending.current.add(commentId);
      mutationRevision.current++;
      setBusyIds([...pending.current]);
      const current = generation.current;
      try {
        const response = await fetch(`/api/comments/${commentId}/edit-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...(options ? { options } : {}) }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? 'Could not update editing task');
        if (current === generation.current)
          setState((old) => ({
            versionId,
            error: null,
            library: old.versionId === versionId ? old.library : undefined,
            tasks: payload.data.tasks ?? [
              ...(old.versionId === versionId
                ? old.tasks.filter((task) => task.commentId !== commentId)
                : []),
              payload.data.task,
            ],
          }));
        if (['accept', 'human', 'undo', 'revise'].includes(action)) await onResolved(versionId);
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

  const runBatch = useCallback(async () => {
    const ids = (state.versionId === versionId ? state.tasks : [])
      .filter((t) => t.status === 'QUEUED')
      .map((t) => t.commentId);
    if (!enabled || !versionId || ids.length < 2 || pending.current.size) return false;
    ids.forEach((id) => pending.current.add(id));
    mutationRevision.current++;
    setBusyIds([...pending.current]);
    const current = generation.current;
    try {
      const response = await fetch(`/api/versions/${versionId}/edit-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentIds: ids }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Could not run the batch');
      if (current === generation.current)
        setState((old) => ({ ...old, versionId, tasks: payload.data.tasks, error: null }));
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not run the batch');
      return false;
    } finally {
      ids.forEach((id) => pending.current.delete(id));
      mutationRevision.current++;
      setBusyIds([...pending.current]);
    }
  }, [enabled, versionId, state]);

  return {
    tasks: state.versionId === versionId ? state.tasks : [],
    error: state.versionId === versionId ? state.error : null,
    busyIds,
    act,
    runBatch,
    library: state.versionId === versionId ? state.library : undefined,
  };
}
