'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  Plus,
  Settings,
  Share2,
  Play,
  Users,
  Building2,
  ArrowUp,
  ArrowDown,
  Globe,
  UserPlus,
  Lock,
  Download,
  Loader2,
  Trash2,
  ChevronDown,
  FolderInput,
  Folder,
  FolderPlus,
  MoreVertical,
  Pencil,
  Clapperboard,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { VideoCard } from '@/components/video-card';
import { VideoDragDropUploader } from '@/components/video-drag-drop-uploader';
import { MoveVideosDialog } from '@/components/move-videos-dialog';
import { MoveToFolderDialog, type ProjectFolder } from '@/components/move-to-folder-dialog';
import { RoughCutDialog } from '@/components/rough-cut-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { folderPath } from '@/lib/folders';
import type { DirectUploadProvider } from '@/components/video-page/types';
import {
  runProjectDownloadManifest,
  type ProjectDownloadManifest,
} from '@/lib/client/project-download';
import { downloadProgressPercent } from '@/lib/client/download-file';
import { beginUnloadGuard } from '@/lib/client/unload-guard';
import {
  createDownloadProgressToast,
  type DownloadProgressToastHandle,
} from '@/components/download-progress-toast';

interface SerializedVideo {
  id: string;
  title: string;
  metadata?: unknown;
  thumbnailUrl: string;
  currentVersion: number;
  commentCount: number;
  duration: string;
  durationSeconds?: number | null;
  startTimecode?: string | null;
  recordedAt?: string | null;
  createdAt?: string | null;
  position?: number;
  lastUpdated: string;
  updatedAt: string;
}

interface ProjectContentClientProps {
  project: {
    name: string;
    description: string | null;
    visibility: string;
    allowDownloads: boolean;
    workspace: { id: string; name: string } | null;
    members: { role: string }[];
  };
  projectId: string;
  videos: SerializedVideo[];
  folders: Array<ProjectFolder & { videoCount: number }>;
  currentFolderId: string | null;
  allVideoIds: string[];
  canEdit: boolean;
  canDownloadProject: boolean;
  isOwner: boolean;
  workspaceRole: string | null;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  directUploadsEnabled: boolean;
  directUploadProvider: DirectUploadProvider;
  roughCutEnabled: boolean;
}

export function ProjectContentClient({
  project,
  projectId,
  videos,
  folders,
  currentFolderId,
  allVideoIds,
  canEdit,
  canDownloadProject,
  isOwner,
  totalPages,
  currentPage,
  pageSize,
  directUploadsEnabled,
  directUploadProvider,
  roughCutEnabled,
}: ProjectContentClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sortOrder = searchParams.get('sort') || 'desc';
  const [localVideos, setLocalVideos] = useState<SerializedVideo[]>(videos);
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [includeAssetsInDownload, setIncludeAssetsInDownload] = useState(false);
  const [isDeletingSelected, setIsDeletingSelected] = useState(false);
  const [showDeleteSelectedDialog, setShowDeleteSelectedDialog] = useState(false);
  const [showMoveSelectedDialog, setShowMoveSelectedDialog] = useState(false);
  const [showMoveToFolderDialog, setShowMoveToFolderDialog] = useState(false);
  const [moveToFolderVideoIds, setMoveToFolderVideoIds] = useState<string[]>([]);
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [folderPendingDelete, setFolderPendingDelete] = useState<ProjectFolder | null>(null);
  const [isDeletingFolder, setIsDeletingFolder] = useState(false);
  const [folderPendingRename, setFolderPendingRename] = useState<ProjectFolder | null>(null);
  const [renameFolderName, setRenameFolderName] = useState('');
  const [isRenamingFolder, setIsRenamingFolder] = useState(false);
  const [roughCutTarget, setRoughCutTarget] = useState<{
    folderId: string | null;
    folderLabel: string;
    videoCount: number;
    videos: SerializedVideo[];
  } | null>(null);

  const canSelectVideos = canDownloadProject || canEdit;

  useEffect(() => {
    setLocalVideos(videos);
  }, [videos]);

  const selectedCount = selectedVideoIds.length;
  const pageVideoIds = useMemo(() => localVideos.map((video) => video.id), [localVideos]);
  const allSelected = useMemo(
    () => pageVideoIds.length > 0 && pageVideoIds.every((id) => selectedVideoIds.includes(id)),
    [pageVideoIds, selectedVideoIds]
  );

  const createQueryString = useCallback(
    (name: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(name, value);

      if (name !== 'page') {
        params.set('page', '1');
      }

      return params.toString();
    },
    [searchParams]
  );

  const folderQuery = useCallback(
    (folderId: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (folderId) params.set('folder', folderId);
      else params.delete('folder');
      params.set('page', '1');
      return params.toString();
    },
    [searchParams]
  );

  const childFolders = useMemo(
    () => folders.filter((folder) => folder.parentId === currentFolderId),
    [folders, currentFolderId]
  );
  const crumbs = useMemo(
    () => (currentFolderId ? folderPath(currentFolderId, folders) : []),
    [currentFolderId, folders]
  );
  const currentFolderLabel = crumbs[crumbs.length - 1]?.name ?? project.name;
  const canGenerateCurrentFolderRoughCut = roughCutEnabled && canEdit && allVideoIds.length >= 1;
  const addVideoHref = currentFolderId
    ? `/projects/${projectId}/videos/new?folder=${currentFolderId}`
    : `/projects/${projectId}/videos/new`;

  const handleVideoDeleted = useCallback((videoId: string) => {
    setLocalVideos((prev) => prev.filter((video) => video.id !== videoId));
    setSelectedVideoIds((prev) => prev.filter((id) => id !== videoId));
  }, []);

  const handleVideosMoved = useCallback((movedIds: string[]) => {
    const moved = new Set(movedIds);
    setLocalVideos((prev) => prev.filter((video) => !moved.has(video.id)));
    setSelectedVideoIds([]);
    setSelectionMode(false);
  }, []);

  const handleVideosMovedToFolder = useCallback(
    (movedIds: string[], folderId: string | null) => {
      if (folderId === currentFolderId) return;
      handleVideosMoved(movedIds);
      router.refresh();
    },
    [currentFolderId, handleVideosMoved, router]
  );

  const openMoveToFolder = useCallback((videoIds: string[]) => {
    setMoveToFolderVideoIds(videoIds);
    setShowMoveToFolderDialog(true);
  }, []);

  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name || isCreatingFolder) return;
    setIsCreatingFolder(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId: currentFolderId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(typeof body?.error === 'string' ? body.error : 'Failed to create folder');
        return;
      }
      setShowNewFolderDialog(false);
      setNewFolderName('');
      toast.success('Folder created');
      router.refresh();
    } catch {
      toast.error('Failed to create folder');
    } finally {
      setIsCreatingFolder(false);
    }
  }, [currentFolderId, isCreatingFolder, newFolderName, projectId, router]);

  const handleRenameFolder = useCallback(async () => {
    if (!folderPendingRename || isRenamingFolder) return;
    const name = renameFolderName.trim();
    if (!name) return;
    setIsRenamingFolder(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/folders/${folderPendingRename.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(typeof body?.error === 'string' ? body.error : 'Failed to rename folder');
        return;
      }
      setFolderPendingRename(null);
      toast.success('Folder renamed');
      router.refresh();
    } catch {
      toast.error('Failed to rename folder');
    } finally {
      setIsRenamingFolder(false);
    }
  }, [folderPendingRename, isRenamingFolder, projectId, renameFolderName, router]);

  const handleDeleteFolder = useCallback(async () => {
    if (!folderPendingDelete || isDeletingFolder) return;
    setIsDeletingFolder(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/folders/${folderPendingDelete.id}`, {
        method: 'DELETE',
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(typeof body?.error === 'string' ? body.error : 'Failed to delete folder');
        return;
      }
      setFolderPendingDelete(null);
      toast.success('Folder deleted. Videos inside it moved to the project root.');
      router.refresh();
    } catch {
      toast.error('Failed to delete folder');
    } finally {
      setIsDeletingFolder(false);
    }
  }, [folderPendingDelete, isDeletingFolder, projectId, router]);

  const toggleVideoSelection = useCallback((videoId: string, selected: boolean) => {
    setSelectedVideoIds((prev) => {
      if (selected) {
        if (prev.includes(videoId)) return prev;
        return [...prev, videoId];
      }
      return prev.filter((id) => id !== videoId);
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    // Scope selection to the current page only. Selecting every video across
    // every page from a single button is too easy to trigger by accident when
    // the user only meant the videos they can see.
    setSelectedVideoIds((prev) => {
      const next = new Set(prev);
      pageVideoIds.forEach((id) => next.add(id));
      return Array.from(next);
    });
  }, [pageVideoIds]);

  const handleDeselectAll = useCallback(() => {
    const pageIds = new Set(pageVideoIds);
    setSelectedVideoIds((prev) => prev.filter((id) => !pageIds.has(id)));
  }, [pageVideoIds]);

  const handleClearSelection = useCallback(() => {
    setSelectedVideoIds([]);
    setSelectionMode(false);
  }, []);

  const handleEnterSelectionMode = useCallback(() => {
    setSelectionMode(true);
  }, []);

  const startProjectDownload = useCallback(
    async (videoIds?: string[], options?: { allVersions?: boolean; includeAssets?: boolean }) => {
      if (!canDownloadProject || isDownloading) return;

      const searchParams = new URLSearchParams();
      if (videoIds && videoIds.length > 0) {
        searchParams.set('videoIds', videoIds.join(','));
      }
      if (options?.allVersions) {
        searchParams.set('versions', 'all');
      }
      if (options?.includeAssets) {
        searchParams.set('assets', '1');
      }
      const query = searchParams.toString() ? `?${searchParams.toString()}` : '';

      setIsDownloading(true);
      let progressToast: DownloadProgressToastHandle | null = null;
      let releaseUnloadGuard: (() => void) | null = null;
      try {
        const response = await fetch(`/api/projects/${projectId}/download${query}`, {
          cache: 'no-store',
        });
        const body = await response.json().catch(() => null);

        if (!response.ok) {
          const message =
            typeof body?.error === 'string' ? body.error : 'Failed to prepare project download';
          toast.error(message);
          return;
        }

        const manifest = body?.data as ProjectDownloadManifest | undefined;
        if (!manifest?.files?.length) {
          toast.error('No downloadable files found');
          return;
        }

        progressToast = createDownloadProgressToast(`project-download-${projectId}`, {
          title: `Downloading ${manifest.totalFiles} files`,
          description: 'Starting…',
        });
        // The files are pulled one by one through this tab, so closing it drops
        // everything that hasn't been saved yet. Warn before that happens.
        releaseUnloadGuard = beginUnloadGuard();
        await runProjectDownloadManifest(manifest, (p) => {
          const percent = downloadProgressPercent({
            receivedBytes: p.receivedBytes,
            totalBytes: p.totalBytes,
          });
          progressToast?.update({
            title: `Downloading file ${p.index}/${p.total}`,
            description: `${p.fileName}${percent !== null ? ` · ${percent}%` : ''}`,
            percent,
          });
        });
        progressToast.success(`Downloaded ${manifest.totalFiles} files`);
      } catch {
        // The progress panel never expires on its own, so clear it before the
        // error toast replaces it.
        progressToast?.dismiss();
        toast.error('Failed to start project download');
      } finally {
        releaseUnloadGuard?.();
        setIsDownloading(false);
      }
    },
    [canDownloadProject, isDownloading, projectId]
  );

  const handleDeleteSelected = useCallback(async () => {
    if (!canEdit || selectedCount === 0 || isDeletingSelected) return;

    setIsDeletingSelected(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/videos/bulk-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoIds: selectedVideoIds }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof body?.error === 'string' ? body.error : 'Failed to delete selected videos';
        toast.error(message);
        return;
      }

      const deletedIds = new Set(selectedVideoIds);
      setLocalVideos((prev) => prev.filter((video) => !deletedIds.has(video.id)));
      setSelectedVideoIds([]);
      setSelectionMode(false);
      setShowDeleteSelectedDialog(false);
      toast.success(
        typeof body?.data?.message === 'string' ? body.data.message : 'Selected videos deleted'
      );

      // The current page may now be out of range (e.g. we deleted every video
      // on it). Clamp to the last valid page so the refresh lands on a page
      // that still has videos instead of showing "No videos yet".
      const remainingTotal = allVideoIds.filter((id) => !deletedIds.has(id)).length;
      const newTotalPages = Math.max(1, Math.ceil(remainingTotal / pageSize));
      if (currentPage > newTotalPages) {
        router.push(`?${createQueryString('page', newTotalPages.toString())}`);
      } else {
        router.refresh();
      }
    } catch {
      toast.error('Failed to delete selected videos');
    } finally {
      setIsDeletingSelected(false);
    }
  }, [
    allVideoIds,
    canEdit,
    createQueryString,
    currentPage,
    isDeletingSelected,
    pageSize,
    projectId,
    router,
    selectedCount,
    selectedVideoIds,
  ]);

  return (
    <>
      <VideoDragDropUploader
        fixedProjectId={projectId}
        fixedProjectName={project.name}
        canUpload={canEdit && directUploadsEnabled}
        directUploadProvider={directUploadProvider}
        folderId={currentFolderId}
      />

      {/* Project Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-[27px] font-extrabold tracking-[-0.035em]">{project.name}</h1>
            <Badge variant="outline" className="flex items-center gap-1">
              {project.visibility === 'PUBLIC' && <Globe className="h-3 w-3" />}
              {project.visibility === 'INVITE' && <UserPlus className="h-3 w-3" />}
              {project.visibility === 'PRIVATE' && <Lock className="h-3 w-3" />}
              {project.visibility.toLowerCase()}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            {project.workspace && (
              <Link href={`/workspaces/${project.workspace.id}`}>
                <Badge
                  variant="secondary"
                  className="flex items-center gap-1 hover:bg-accent transition-colors"
                >
                  <Building2 className="h-3 w-3" />
                  {project.workspace.name}
                </Badge>
              </Link>
            )}
            {project.description && (
              <span className="text-muted-foreground">{project.description}</span>
            )}
          </div>
          {crumbs.length > 0 && (
            <nav className="mt-3 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
              <Link href={`?${folderQuery(null)}`} className="hover:text-foreground">
                {project.name}
              </Link>
              {crumbs.map((crumb, index) => (
                <span key={crumb.id} className="flex items-center gap-1">
                  <span>/</span>
                  {index === crumbs.length - 1 ? (
                    <span className="text-foreground">{crumb.name}</span>
                  ) : (
                    <Link href={`?${folderQuery(crumb.id)}`} className="hover:text-foreground">
                      {crumb.name}
                    </Link>
                  )}
                </span>
              ))}
            </nav>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-4 sm:mt-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const newOrder = sortOrder === 'desc' ? 'asc' : 'desc';
              router.push(`?${createQueryString('sort', newOrder)}`);
            }}
            className="flex items-center gap-2"
          >
            {sortOrder === 'desc' ? (
              <>
                <ArrowDown className="h-4 w-4" />
                Newest first
              </>
            ) : (
              <>
                <ArrowUp className="h-4 w-4" />
                Oldest first
              </>
            )}
          </Button>
          {canDownloadProject && localVideos.length > 0 && !selectionMode && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={isDownloading}>
                  {isDownloading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-2" />
                  )}
                  Download project
                  <ChevronDown className="h-4 w-4 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem
                  checked={includeAssetsInDownload}
                  onCheckedChange={(checked) => setIncludeAssetsInDownload(checked === true)}
                  onSelect={(event) => event.preventDefault()}
                >
                  Include assets
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    startProjectDownload(undefined, { includeAssets: includeAssetsInDownload })
                  }
                >
                  Latest version only
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    startProjectDownload(undefined, {
                      allVersions: true,
                      includeAssets: includeAssetsInDownload,
                    })
                  }
                >
                  All versions
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canGenerateCurrentFolderRoughCut && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setRoughCutTarget({
                  folderId: currentFolderId,
                  folderLabel: currentFolderLabel,
                  videoCount: allVideoIds.length,
                  videos: localVideos,
                })
              }
            >
              <Clapperboard className="h-4 w-4 mr-2" />
              Generate rough cut
            </Button>
          )}
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/projects/${projectId}/share`}>
                <Share2 className="h-4 w-4 mr-2" />
                Share
              </Link>
            </Button>
          )}
          {(isOwner || project.members[0]?.role === 'ADMIN') && (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/projects/${projectId}/members`}>
                  <Users className="h-4 w-4 mr-2" />
                  Members
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/projects/${projectId}/settings`}>
                  <Settings className="h-4 w-4 mr-2" />
                  Settings
                </Link>
              </Button>
            </>
          )}
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => setShowNewFolderDialog(true)}>
              <FolderPlus className="h-4 w-4 mr-2" />
              New folder
            </Button>
          )}
          {canEdit && (
            <Button size="sm" asChild>
              <Link href={addVideoHref}>
                <Plus className="h-4 w-4 mr-2" />
                Add Video
              </Link>
            </Button>
          )}
        </div>
      </div>

      {selectionMode && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
          <span className="text-sm font-medium">Selection mode</span>
          <span className="text-sm text-muted-foreground">
            {selectedCount > 0 ? `${selectedCount} selected` : 'None selected'}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={allSelected ? handleDeselectAll : handleSelectAll}
            >
              {totalPages > 1
                ? allSelected
                  ? 'Deselect page'
                  : 'Select page'
                : allSelected
                  ? 'Deselect all'
                  : 'Select all'}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClearSelection}>
              Cancel
            </Button>
            {canDownloadProject && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isDownloading || selectedCount === 0}
                  >
                    {isDownloading ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4 mr-2" />
                    )}
                    Download selected
                    <ChevronDown className="h-4 w-4 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuCheckboxItem
                    checked={includeAssetsInDownload}
                    onCheckedChange={(checked) => setIncludeAssetsInDownload(checked === true)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    Include assets
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() =>
                      startProjectDownload(selectedVideoIds, {
                        includeAssets: includeAssetsInDownload,
                      })
                    }
                  >
                    Latest version only
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      startProjectDownload(selectedVideoIds, {
                        allVersions: true,
                        includeAssets: includeAssetsInDownload,
                      })
                    }
                  >
                    All versions
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openMoveToFolder(selectedVideoIds)}
                disabled={selectedCount === 0 || isDeletingSelected}
              >
                <Folder className="h-4 w-4 mr-2" />
                Move to folder
              </Button>
            )}
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowMoveSelectedDialog(true)}
                disabled={selectedCount === 0 || isDeletingSelected}
              >
                <FolderInput className="h-4 w-4 mr-2" />
                Move to project
              </Button>
            )}
            {canEdit && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowDeleteSelectedDialog(true)}
                disabled={selectedCount === 0 || isDeletingSelected}
              >
                {isDeletingSelected ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" />
                )}
                Delete selected
              </Button>
            )}
          </div>
        </div>
      )}

      {childFolders.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 mb-6">
          {childFolders.map((folder) => (
            <Card key={folder.id} className="group relative">
              <Link href={`?${folderQuery(folder.id)}`} className="block">
                <CardContent className="flex items-center gap-3 py-6">
                  <Folder className="h-8 w-8 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <h3 className="font-medium truncate">{folder.name}</h3>
                    <p className="text-sm text-muted-foreground">Folder</p>
                  </div>
                </CardContent>
              </Link>
              {canEdit && (
                <div className="absolute top-2 right-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Folder actions for ${folder.name}`}
                      >
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {roughCutEnabled && folder.videoCount >= 1 && (
                        <DropdownMenuItem
                          onSelect={() =>
                            setRoughCutTarget({
                              folderId: folder.id,
                              folderLabel: folder.name,
                              videoCount: folder.videoCount,
                              videos: [],
                            })
                          }
                        >
                          <Clapperboard className="mr-2 h-4 w-4" />
                          Generate rough cut
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onSelect={() => {
                          setFolderPendingRename(folder);
                          setRenameFolderName(folder.name);
                        }}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onSelect={() => setFolderPendingDelete(folder)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Videos Grid */}
      {localVideos.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {localVideos.map((video) => (
            <VideoCard
              key={video.id}
              video={video}
              projectId={projectId}
              canManage={canEdit}
              canSelect={canSelectVideos}
              selectionMode={selectionMode}
              selected={selectedVideoIds.includes(video.id)}
              onEnterSelectionMode={handleEnterSelectionMode}
              onSelectedChange={(selected) => toggleVideoSelection(video.id, selected)}
              onDeleted={handleVideoDeleted}
              onMoveToFolder={() => openMoveToFolder([video.id])}
            />
          ))}
        </div>
      ) : childFolders.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Play className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">
              {currentFolderId ? 'This folder is empty' : 'No videos yet'}
            </h3>
            <p className="text-muted-foreground text-center mb-4">
              {currentFolderId
                ? 'Add a video or create another folder in here'
                : 'Add your first video to start collecting feedback'}
            </p>
            {canEdit && (
              <Button asChild>
                <Link href={addVideoHref}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Video
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-8 flex items-center justify-end space-x-2">
          <Button variant="outline" size="sm" disabled={currentPage <= 1} asChild={currentPage > 1}>
            {currentPage > 1 ? (
              <Link href={`?${createQueryString('page', (currentPage - 1).toString())}`}>
                Previous
              </Link>
            ) : (
              'Previous'
            )}
          </Button>
          <span className="text-sm font-medium">
            Page {currentPage} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage >= totalPages}
            asChild={currentPage < totalPages}
          >
            {currentPage < totalPages ? (
              <Link href={`?${createQueryString('page', (currentPage + 1).toString())}`}>Next</Link>
            ) : (
              'Next'
            )}
          </Button>
        </div>
      )}

      <AlertDialog open={showDeleteSelectedDialog} onOpenChange={setShowDeleteSelectedDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedCount} video{selectedCount === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the selected videos, all of their versions, comments, and
              stored media from Bunny and Cloudflare R2. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingSelected}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteSelected();
              }}
              disabled={isDeletingSelected || selectedCount === 0}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingSelected && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete selected
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <MoveVideosDialog
        open={showMoveSelectedDialog}
        onOpenChange={setShowMoveSelectedDialog}
        projectId={projectId}
        videoIds={selectedVideoIds}
        onMoved={handleVideosMoved}
      />

      <MoveToFolderDialog
        open={showMoveToFolderDialog}
        onOpenChange={setShowMoveToFolderDialog}
        projectId={projectId}
        videoIds={moveToFolderVideoIds}
        folders={folders}
        currentFolderId={currentFolderId}
        onMoved={handleVideosMovedToFolder}
      />

      {roughCutEnabled ? (
        <RoughCutDialog
          open={roughCutTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRoughCutTarget(null);
          }}
          projectId={projectId}
          workspaceId={project.workspace?.id ?? null}
          folderId={roughCutTarget?.folderId ?? currentFolderId}
          folderLabel={roughCutTarget?.folderLabel ?? currentFolderLabel}
          videoCount={roughCutTarget?.videoCount ?? allVideoIds.length}
          videos={roughCutTarget?.videos ?? localVideos}
        />
      ) : null}

      <Dialog open={showNewFolderDialog} onOpenChange={setShowNewFolderDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              {currentFolderId
                ? 'Created inside the folder you are viewing.'
                : 'Created at the project root.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="new-folder-name">Name</Label>
            <Input
              id="new-folder-name"
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleCreateFolder();
                }
              }}
              maxLength={100}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNewFolderDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreateFolder()}
              disabled={isCreatingFolder || !newFolderName.trim()}
            >
              {isCreatingFolder && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={folderPendingRename !== null}
        onOpenChange={(open) => {
          if (!open) setFolderPendingRename(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
            <DialogDescription>The name is visible to everyone on this project.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="rename-folder-name">Name</Label>
            <Input
              id="rename-folder-name"
              value={renameFolderName}
              onChange={(event) => setRenameFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleRenameFolder();
                }
              }}
              maxLength={100}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFolderPendingRename(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleRenameFolder()}
              disabled={isRenamingFolder || !renameFolderName.trim()}
            >
              {isRenamingFolder && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={folderPendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setFolderPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {folderPendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Nested folders are deleted too. Videos inside them move to the project root; they are
              not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingFolder}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteFolder();
              }}
              disabled={isDeletingFolder}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingFolder && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
