'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  FolderPlus,
  Loader2,
  Download,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { VideoDragDropUploader } from '@/components/video-drag-drop-uploader';
import { useRoughCutHistory } from '@/components/video-page/hooks/use-rough-cut';
import type { DirectUploadProvider } from '@/components/video-page/types';
import { folderPath } from '@/lib/folders';
import type { EditorialProjectType } from '@/lib/rough-cut/brief';
import { upsertMetadataField } from '@/lib/rough-cut/camera-roles';
import { PROJECT_TYPE_LABELS } from '@/components/editorial-briefs-card';
import { isWaitingForTranscript } from '@/lib/rough-cut/workspace';
import {
  layoutFromEditMode,
  type EditWorkspaceMode,
  type LayoutGuessReason,
} from '@/lib/rough-cut/layout';

export type EditFolder = {
  id: string;
  name: string;
  parentId: string | null;
  editorialBriefId: string | null;
};

type WorkspaceBrief = {
  id: string;
  name: string;
  projectType: EditorialProjectType;
  isDefault: boolean;
};

export type EditBinClip = {
  id: string;
  title: string;
  durationSeconds: number | null;
  startTimecode: string | null;
  recordedAt: string | null;
  createdAt: string;
  position: number;
  providerId: string | null;
  cameraRole: string;
  metadata: Record<string, string>;
  importStatus: 'pending' | 'ready' | 'failed' | null;
  fileBacked: boolean;
  embedOnly: boolean;
};

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString();
}

function layoutLabel(layout?: string): string {
  if (layout === 'MULTICAM') return 'Multicam';
  if (layout === 'LINEAR') return 'Single camera';
  if (layout === 'SEQUENTIAL') return 'Single camera (sequential)';
  return layout ?? '—';
}

function guessCopy(
  reason: LayoutGuessReason,
  mode: EditWorkspaceMode,
  launchCount: number
): string {
  if (mode === 'multicam') {
    return launchCount < 2
      ? 'Multicam needs at least two file-backed clips in this folder.'
      : 'Switches between cameras from speech and roles.';
  }
  if (launchCount <= 1) {
    return reason === 'single-clip'
      ? 'One file-backed clip: a linear cut that drops silence.'
      : 'A linear cut on the clips that are ready.';
  }
  if (
    reason === 'overlapping-timecode' ||
    reason === 'overlapping-recorded-at' ||
    reason === 'distinct-camera-metadata' ||
    reason === 'distinct-camera-roles' ||
    reason === 'default-multicam'
  ) {
    return 'These clips look like overlapping cameras. Single camera still concatenates them in chronological order.';
  }
  return 'Assembled in chronological order from timecode, recorded-at, or numbered names.';
}

function sessionFolderName(): string {
  return `Session ${new Date().toISOString().slice(0, 10)}`;
}

function clipHasRecordingData(clip: EditBinClip): boolean {
  return Boolean(clip.startTimecode || clip.recordedAt);
}

function defaultCameraNames(clips: EditBinClip[]): Record<string, string> {
  const genericCount = clips.filter((clip) => clip.cameraRole === 'CAM').length;
  const names: Record<string, string> = {};
  let genericIndex = 0;
  for (const clip of clips) {
    if (clip.cameraRole !== 'CAM' || genericCount <= 1) {
      names[clip.id] = clip.cameraRole;
      continue;
    }
    genericIndex += 1;
    names[clip.id] = `CAM ${genericIndex}`;
  }
  return names;
}

function defaultFocusVideoId(clips: EditBinClip[], names: Record<string, string>): string | null {
  if (clips.length === 0) return null;
  const wide = clips.find((clip) => (names[clip.id] ?? clip.cameraRole).toUpperCase() === 'WIDE');
  return wide?.id ?? clips[0]!.id;
}

interface EditWorkspaceClientProps {
  projectId: string;
  projectName: string;
  workspaceId: string;
  /** The project's own brief binding, used for cuts at the project root. */
  projectBriefId: string | null;
  folders: EditFolder[];
  currentFolderId: string | null;
  clips: EditBinClip[];
  guessedMode: EditWorkspaceMode;
  guessReason: LayoutGuessReason;
  guessedOrderedIds: string[];
  launchCount: number;
  directUploadsEnabled: boolean;
  directUploadProvider: DirectUploadProvider;
  driveImportEnabled: boolean;
}

export function EditWorkspaceClient({
  projectId,
  projectName,
  workspaceId,
  projectBriefId,
  folders,
  currentFolderId,
  clips,
  guessedMode,
  guessReason,
  guessedOrderedIds,
  launchCount,
  directUploadsEnabled,
  directUploadProvider,
  driveImportEnabled,
}: EditWorkspaceClientProps) {
  const router = useRouter();
  const [modeOverride, setModeOverride] = useState<EditWorkspaceMode | null>(null);
  const mode = modeOverride ?? guessedMode;
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const [cameraOverride, setCameraOverride] = useState<Record<string, string>>({});
  const [focusOverride, setFocusOverride] = useState<string | null>(null);
  const [savingCameraId, setSavingCameraId] = useState<string | null>(null);

  const [driveUrl, setDriveUrl] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [newFolderName, setNewFolderName] = useState(sessionFolderName);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [workspaceBriefs, setWorkspaceBriefs] = useState<WorkspaceBrief[]>([]);
  const [boundBriefId, setBoundBriefId] = useState<string | null>(
    currentFolderId
      ? (folders.find((folder) => folder.id === currentFolderId)?.editorialBriefId ?? null)
      : projectBriefId
  );
  const [isBindingBrief, setIsBindingBrief] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/editorial-briefs`, {
          cache: 'no-store',
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) return;
        const list = (payload as { data?: { briefs?: WorkspaceBrief[] } }).data?.briefs;
        if (!cancelled && Array.isArray(list)) setWorkspaceBriefs(list);
      } catch {
        // The selector stays hidden; the run still inherits a brief.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // At the project root the binding lives on the project; inside a folder, on
  // that folder. Either way the next rough cut in this place picks it up.
  const bindBrief = async (value: string) => {
    const nextId = value === 'inherit' ? null : value;
    const previous = boundBriefId;
    setBoundBriefId(nextId);
    setIsBindingBrief(true);
    try {
      const url = currentFolderId
        ? `/api/projects/${projectId}/folders/${currentFolderId}`
        : `/api/projects/${projectId}`;
      const response = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editorialBriefId: nextId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setBoundBriefId(previous);
        toast.error(typeof payload?.error === 'string' ? payload.error : 'Failed to bind brief');
        return;
      }
      router.refresh();
    } catch {
      setBoundBriefId(previous);
      toast.error('Failed to bind brief');
    } finally {
      setIsBindingBrief(false);
    }
  };
  const history = useRoughCutHistory(projectId, currentFolderId);

  const libraryHref = currentFolderId
    ? `/projects/${projectId}?folder=${currentFolderId}`
    : `/projects/${projectId}`;

  const folderOptions = useMemo(
    () =>
      folders.map((folder) => ({
        id: folder.id,
        label: folderPath(folder.id, folders)
          .map((entry) => entry.name)
          .join(' / '),
      })),
    [folders]
  );

  const readyClips = useMemo(() => {
    const ready = clips.filter((clip) => clip.fileBacked);
    const byId = new Map(ready.map((clip) => [clip.id, clip]));
    const readyIds = ready.map((clip) => clip.id);
    const base = orderOverride ?? guessedOrderedIds;
    const ordered: EditBinClip[] = [];
    const seen = new Set<string>();
    for (const id of base) {
      const clip = byId.get(id);
      if (!clip || seen.has(id)) continue;
      seen.add(id);
      ordered.push(clip);
    }
    for (const id of readyIds) {
      const clip = byId.get(id);
      if (!clip || seen.has(id)) continue;
      ordered.push(clip);
    }
    return ordered;
  }, [clips, guessedOrderedIds, orderOverride]);
  const cameraNames = useMemo(() => {
    return { ...defaultCameraNames(readyClips), ...cameraOverride };
  }, [cameraOverride, readyClips]);
  const focusVideoId =
    focusOverride && readyClips.some((clip) => clip.id === focusOverride)
      ? focusOverride
      : defaultFocusVideoId(readyClips, cameraNames);
  const pendingClips = clips.filter(
    (clip) => clip.importStatus === 'pending' || clip.importStatus === 'failed'
  );
  const hiddenEmbeds = clips.filter((clip) => clip.embedOnly).length;
  const canLaunch = mode === 'multicam' ? readyClips.length >= 2 : readyClips.length >= 1;
  const recordingDataMissing =
    readyClips.length > 0 && readyClips.every((clip) => !clipHasRecordingData(clip));
  const canReorder = mode === 'single-camera' && readyClips.length > 1;
  const canNameCameras = mode === 'multicam' && readyClips.length > 1;

  const moveClip = (id: string, direction: -1 | 1) => {
    const ids = readyClips.map((clip) => clip.id);
    const index = ids.indexOf(id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
    const copy = [...ids];
    const [item] = copy.splice(index, 1);
    if (!item) return;
    copy.splice(nextIndex, 0, item);
    setOrderOverride(copy);
  };

  const saveCameraName = async (clip: EditBinClip, role: string) => {
    const cleaned = role.trim();
    const nextMetadata = upsertMetadataField(clip.metadata, 'camera', cleaned || null);
    setSavingCameraId(clip.id);
    try {
      const response = await fetch(`/api/projects/${projectId}/videos/${clip.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: nextMetadata }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(
          typeof payload?.error === 'string' ? payload.error : 'Failed to save camera name'
        );
      }
    } catch {
      toast.error('Failed to save camera name');
    } finally {
      setSavingCameraId(null);
    }
  };

  const selectFolder = (value: string) => {
    const href =
      value === 'root'
        ? `/projects/${projectId}/edit`
        : `/projects/${projectId}/edit?folder=${value}`;
    router.push(href);
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name || isCreatingFolder) return;
    setIsCreatingFolder(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId: currentFolderId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(typeof payload?.error === 'string' ? payload.error : 'Failed to create folder');
        return;
      }
      const createdId = (payload as { data?: { folder?: { id?: string } } })?.data?.folder?.id;
      toast.success('Folder created');
      if (typeof createdId === 'string') {
        router.push(`/projects/${projectId}/edit?folder=${createdId}`);
      } else {
        router.refresh();
      }
    } catch {
      toast.error('Failed to create folder');
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const importDrive = async () => {
    if (!driveUrl.trim() || isImporting) return;
    setIsImporting(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/videos/import-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: driveUrl.trim(), folderId: currentFolderId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(
          typeof payload?.error === 'string' ? payload.error : 'Failed to import Drive file'
        );
        return;
      }
      toast.success('Drive file queued for import');
      setDriveUrl('');
      router.refresh();
    } catch {
      toast.error('Failed to import Drive file');
    } finally {
      setIsImporting(false);
    }
  };

  const launch = async () => {
    const layout = layoutFromEditMode(mode, readyClips.length);
    const cameraRoles: Record<string, string> = {};
    for (const clip of readyClips) {
      const name = cameraNames[clip.id]?.trim();
      if (name) cameraRoles[clip.id] = name;
    }
    const focusRole =
      focusVideoId && cameraRoles[focusVideoId]
        ? cameraRoles[focusVideoId]
        : focusVideoId
          ? cameraNames[focusVideoId]
          : undefined;
    const message = await history.start(layout, {
      clipOrder: layout === 'SEQUENTIAL' ? readyClips.map((clip) => clip.id) : undefined,
      cameraRoles: layout === 'MULTICAM' ? cameraRoles : undefined,
      wideCameraRole: layout === 'MULTICAM' ? focusRole : undefined,
    });
    if (message) {
      toast.error(message);
      return;
    }
    toast.success('Rough cut queued');
  };

  return (
    <div className="px-6 lg:px-8 py-8 w-full space-y-8">
      <div>
        <Link
          href={libraryHref}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to library
        </Link>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-[27px] font-extrabold tracking-[-0.035em]">Edit</h1>
            <p className="text-sm text-muted-foreground">
              Source bin for {projectName}. Upload or import masters, then launch a single-camera or
              multicam cut.
            </p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Destination folder</CardTitle>
          <CardDescription>
            Uploads, Drive imports, and the cut all use this folder. Create a session folder or pick
            an existing one.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid gap-2 min-w-0 flex-1">
            <Label htmlFor="edit-folder">Bin folder</Label>
            <Select value={currentFolderId ?? 'root'} onValueChange={selectFolder}>
              <SelectTrigger id="edit-folder" className="w-full max-w-md">
                <SelectValue placeholder="Project root" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="root">Project root</SelectItem>
                {folderOptions.map((folder) => (
                  <SelectItem key={folder.id} value={folder.id}>
                    {folder.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {workspaceBriefs.length > 0 || boundBriefId ? (
            <div className="grid gap-2 min-w-0 flex-1">
              <Label htmlFor="edit-brief">
                Editorial brief {currentFolderId ? 'for this folder' : 'for the project'}
              </Label>
              <Select
                value={boundBriefId ?? 'inherit'}
                onValueChange={(value) => void bindBrief(value)}
                disabled={isBindingBrief}
              >
                <SelectTrigger id="edit-brief" className="w-full max-w-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">
                    {currentFolderId
                      ? 'Inherited from the parent folder or project'
                      : 'Workspace default for the project type'}
                  </SelectItem>
                  {workspaceBriefs.map((brief) => (
                    <SelectItem key={brief.id} value={brief.id}>
                      {brief.name} · {PROJECT_TYPE_LABELS[brief.projectType]}
                      {brief.isDefault ? ' (default)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex min-w-0 flex-1 gap-2">
            <Input
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              maxLength={100}
              aria-label="New folder name"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => void createFolder()}
              disabled={isCreatingFolder || !newFolderName.trim()}
            >
              {isCreatingFolder ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FolderPlus className="h-4 w-4 mr-2" />
              )}
              New folder
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Computer and camera card</CardTitle>
            <CardDescription>
              Direct upload into this bin. Use a card reader or disk the same way as a folder on
              this computer.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {directUploadsEnabled ? (
              <VideoDragDropUploader
                fixedProjectId={projectId}
                fixedProjectName={projectName}
                canUpload
                directUploadProvider={directUploadProvider}
                folderId={currentFolderId}
                showBinPicker
                pickerTitle="Drop files or browse a camera card"
                pickerDescription="MP4, MOV, and other review files land in the folder above."
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Direct file uploads are disabled on this host.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Google Drive file</CardTitle>
            <CardDescription>
              Paste a file share link (anyone with the link). The bytes are copied into object
              storage so the worker can cut them. Folders and private files are not imported.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {driveImportEnabled ? (
              <>
                <Label htmlFor="drive-url">Drive file link</Label>
                <div className="flex gap-2">
                  <Input
                    id="drive-url"
                    value={driveUrl}
                    onChange={(event) => setDriveUrl(event.target.value)}
                    placeholder="https://drive.google.com/file/d/…"
                  />
                  <Button
                    type="button"
                    onClick={() => void importDrive()}
                    disabled={isImporting || !driveUrl.trim()}
                  >
                    {isImporting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Import
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Object storage is not configured, so Drive links cannot be copied in.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Source bin</CardTitle>
          <CardDescription>
            Only file-backed masters can launch a cut. YouTube and Drive embeds stay in the library.
            {recordingDataMissing
              ? ' These files have no embedded timecode or recorded date — set the cut order or name cameras below.'
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {readyClips.length === 0 && pendingClips.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No file-backed clips in this folder yet.
              {hiddenEmbeds > 0
                ? ` ${hiddenEmbeds} embed link${hiddenEmbeds === 1 ? '' : 's'} hidden.`
                : ''}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    {canReorder ? <th className="py-2 pr-3 font-medium">Order</th> : null}
                    <th className="py-2 pr-3 font-medium">Clip</th>
                    <th className="py-2 pr-3 font-medium">Duration</th>
                    <th className="py-2 pr-3 font-medium">Timecode</th>
                    <th className="py-2 pr-3 font-medium">Recorded</th>
                    <th className="py-2 pr-3 font-medium">Camera</th>
                    {canNameCameras ? <th className="py-2 pr-3 font-medium">Focus</th> : null}
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...readyClips, ...pendingClips].map((clip) => {
                    const isReady = clip.fileBacked;
                    const orderIndex = isReady
                      ? readyClips.findIndex((entry) => entry.id === clip.id)
                      : -1;
                    return (
                      <tr key={clip.id} className="border-b last:border-0">
                        {canReorder ? (
                          <td className="py-2 pr-3">
                            {isReady ? (
                              <div className="flex items-center gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={`Move ${clip.title} earlier`}
                                  disabled={orderIndex <= 0}
                                  onClick={() => moveClip(clip.id, -1)}
                                >
                                  <ChevronUp className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={`Move ${clip.title} later`}
                                  disabled={orderIndex < 0 || orderIndex >= readyClips.length - 1}
                                  onClick={() => moveClip(clip.id, 1)}
                                >
                                  <ChevronDown className="h-3.5 w-3.5" />
                                </Button>
                                <span className="text-xs text-muted-foreground w-4">
                                  {orderIndex + 1}
                                </span>
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        ) : null}
                        <td className="py-2 pr-3 font-medium">{clip.title}</td>
                        <td className="py-2 pr-3">{formatDuration(clip.durationSeconds)}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{clip.startTimecode ?? '—'}</td>
                        <td className="py-2 pr-3">{formatTimestamp(clip.recordedAt)}</td>
                        <td className="py-2 pr-3">
                          {canNameCameras && isReady ? (
                            <Input
                              value={cameraNames[clip.id] ?? clip.cameraRole}
                              maxLength={40}
                              aria-label={`Camera name for ${clip.title}`}
                              className="h-8 min-w-28 max-w-40"
                              onChange={(event) => {
                                const next = event.target.value;
                                setCameraOverride((current) => ({ ...current, [clip.id]: next }));
                              }}
                              onBlur={(event) => {
                                void saveCameraName(clip, event.target.value);
                              }}
                              disabled={savingCameraId === clip.id}
                            />
                          ) : (
                            (cameraNames[clip.id] ?? clip.cameraRole)
                          )}
                        </td>
                        {canNameCameras ? (
                          <td className="py-2 pr-3">
                            {isReady ? (
                              <label className="inline-flex items-center gap-2 text-xs">
                                <input
                                  type="radio"
                                  name="focus-camera"
                                  checked={focusVideoId === clip.id}
                                  onChange={() => setFocusOverride(clip.id)}
                                />
                                Safety
                              </label>
                            ) : null}
                          </td>
                        ) : null}
                        <td className="py-2">
                          {clip.importStatus === 'pending'
                            ? 'Importing…'
                            : clip.importStatus === 'failed'
                              ? 'Import failed'
                              : clip.durationSeconds
                                ? 'Probed'
                                : 'Waiting for probe'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {canNameCameras ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Name each camera, then pick the safety camera to hold on when nobody is speaking.
            </p>
          ) : null}
          {canReorder ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Order is the sequence the cut concatenates when timecode or recorded-at is missing.
            </p>
          ) : null}
          {hiddenEmbeds > 0 && (readyClips.length > 0 || pendingClips.length > 0) ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {hiddenEmbeds} YouTube or Drive embed{hiddenEmbeds === 1 ? '' : 's'} excluded from
              launch. Import the file or upload a master instead.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Layout</CardTitle>
          <CardDescription>{guessCopy(guessReason, mode, launchCount)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={mode}
            onValueChange={(value) => {
              if (value === 'single-camera' || value === 'multicam') setModeOverride(value);
            }}
            className="grid gap-3 sm:grid-cols-2"
          >
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-4">
              <RadioGroupItem value="single-camera" />
              <div>
                <div className="text-sm font-medium">Single camera</div>
                <p className="text-xs text-muted-foreground">
                  One clip is linear. Several clips concatenate in the order shown in the bin.
                </p>
              </div>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-4">
              <RadioGroupItem value="multicam" />
              <div>
                <div className="text-sm font-medium">Multicam</div>
                <p className="text-xs text-muted-foreground">
                  Name each camera in the bin and pick which one to hold on as the safety shot.
                </p>
              </div>
            </label>
          </RadioGroup>
          <Button
            type="button"
            onClick={() => void launch()}
            disabled={!canLaunch || history.isStarting}
          >
            {history.isStarting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Clapperboard className="h-4 w-4 mr-2" />
            )}
            Launch rough cut
          </Button>
          {history.error ? <p className="text-sm text-destructive">{history.error}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            OTIO and FCP7 XML for Premiere, plus a reviewable proxy when the worker finishes
            concatenating the cut.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {history.cuts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No cuts in this folder yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Created</th>
                    <th className="py-2 pr-3 font-medium">Layout</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {history.cuts.map((cut) => {
                    const waiting = history.waitingForWorker(cut);
                    return (
                      <tr key={cut.id} className="border-b last:border-0 align-top">
                        <td className="py-2 pr-3">{formatTimestamp(cut.createdAt)}</td>
                        <td className="py-2 pr-3">{layoutLabel(cut.layout)}</td>
                        <td className="py-2 pr-3">
                          {waiting ? (
                            <span>Waiting for the media worker</span>
                          ) : cut.status === 'PENDING' ? (
                            'Queued…'
                          ) : cut.status === 'RUNNING' ? (
                            isWaitingForTranscript(cut.status, cut.warnings) ? (
                              'Waiting for the transcript…'
                            ) : (
                              'Running…'
                            )
                          ) : cut.status === 'READY' ? (
                            cut.outputVideoId ? (
                              'Ready'
                            ) : (
                              'Ready — building review proxy'
                            )
                          ) : (
                            cut.error || 'Failed'
                          )}
                        </td>
                        <td className="py-2">
                          <div className="flex flex-wrap gap-2">
                            {cut.status === 'READY' && cut.hasDecisions ? (
                              <>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void history.download(cut.id, 'otio')}
                                >
                                  <Download className="h-3 w-3 mr-1" />
                                  OTIO
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void history.download(cut.id, 'xml')}
                                >
                                  <Download className="h-3 w-3 mr-1" />
                                  XML
                                </Button>
                              </>
                            ) : null}
                            {cut.outputVideoId ? (
                              <Button type="button" variant="outline" size="sm" asChild>
                                <Link href={`/watch/${cut.outputVideoId}`}>Open in review</Link>
                              </Button>
                            ) : null}
                            {(cut.status === 'PENDING' || cut.status === 'RUNNING' || waiting) && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={history.isCancelingId === cut.id}
                                onClick={() => void history.cancel(cut.id)}
                              >
                                {history.isCancelingId === cut.id && (
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                )}
                                Cancel
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
