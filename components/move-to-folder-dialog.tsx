'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Folder, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { depthOf, folderPath } from '@/lib/folders';

export type ProjectFolder = {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
};

interface MoveToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  videoIds: string[];
  folders: ProjectFolder[];
  currentFolderId: string | null;
  onMoved?: (movedIds: string[], folderId: string | null) => void;
}

export function MoveToFolderDialog({
  open,
  onOpenChange,
  projectId,
  videoIds,
  folders,
  currentFolderId,
  onMoved,
}: MoveToFolderDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(currentFolderId);
  const [isMoving, setIsMoving] = useState(false);

  useEffect(() => {
    if (open) setSelectedId(currentFolderId);
  }, [open, currentFolderId]);

  const options = useMemo(() => {
    return [...folders].sort((a, b) => {
      const pathA = folderPath(a.id, folders)
        .map((crumb) => crumb.name)
        .join('/');
      const pathB = folderPath(b.id, folders)
        .map((crumb) => crumb.name)
        .join('/');
      return pathA.localeCompare(pathB);
    });
  }, [folders]);

  const count = videoIds.length;
  const noun = count === 1 ? 'video' : 'videos';

  const handleMove = async () => {
    if (isMoving || videoIds.length === 0) return;
    setIsMoving(true);
    try {
      const results = await Promise.all(
        videoIds.map(async (videoId) => {
          const res = await fetch(`/api/projects/${projectId}/videos/${videoId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderId: selectedId }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok) {
            throw new Error(typeof body?.error === 'string' ? body.error : 'Failed to move videos');
          }
          return videoId;
        })
      );
      toast.success(results.length === 1 ? 'Video moved' : `${results.length} videos moved`);
      onOpenChange(false);
      onMoved?.(results, selectedId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to move videos');
    } finally {
      setIsMoving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {count === 1 ? 'video' : `${count} videos`} to a folder</DialogTitle>
          <DialogDescription>
            Choose a folder in this project, or the project root. The {noun} stay in the project.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-64 overflow-y-auto rounded-md border">
          <button
            type="button"
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
              selectedId === null ? 'bg-accent' : 'hover:bg-muted'
            }`}
            onClick={() => setSelectedId(null)}
            disabled={isMoving}
          >
            <Folder className="h-4 w-4" />
            Project root
          </button>
          {options.map((folder) => (
            <button
              type="button"
              key={folder.id}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                selectedId === folder.id ? 'bg-accent' : 'hover:bg-muted'
              }`}
              style={{ paddingLeft: `${12 + depthOf(folder.id, folders) * 12}px` }}
              onClick={() => setSelectedId(folder.id)}
              disabled={isMoving}
            >
              <Folder className="h-4 w-4 shrink-0" />
              {folder.name}
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isMoving}>
            Cancel
          </Button>
          <Button onClick={() => void handleMove()} disabled={isMoving || videoIds.length === 0}>
            {isMoving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
