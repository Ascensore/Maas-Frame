'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Clapperboard, FolderPlus, Loader2, Download } from 'lucide-react';
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
import {
  layoutFromEditMode,
  type EditWorkspaceMode,
  type LayoutGuessReason,
} from '@/lib/rough-cut/layout';

export type EditFolder = {
  id: string;
  name: string;
  parentId: string | null;
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

interface EditWorkspaceClientProps {
  projectId: string;
  projectName: string;
  folders: EditFolder[];
  currentFolderId: string | null;
  clips: EditBinClip[];
  guessedMode: EditWorkspaceMode;
  guessReason: LayoutGuessReason;
  launchCount: number;
  directUploadsEnabled: boolean;
  directUploadProvider: DirectUploadProvider;
  driveImportEnabled: boolean;
}

export function EditWorkspaceClient({
  projectId,
  projectName,
  folders,
  currentFolderId,
  clips,
  guessedMode,
  guessReason,
  launchCount,
  directUploadsEnabled,
  directUploadProvider,
  driveImportEnabled,
}: EditWorkspaceClientProps) {
  const router = useRouter();
  const [mode, setMode] = useState<EditWorkspaceMode>(guessedMode);
  useEffect(() => {
    setMode(guessedMode);
  }, [guessedMode, currentFolderId]);
  const [driveUrl, setDriveUrl] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [newFolderName, setNewFolderName] = useState(sessionFolderName);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
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

  const readyClips = clips.filter((clip) => clip.fileBacked);
  const pendingClips = clips.filter(
    (clip) => clip.importStatus === 'pending' || clip.importStatus === 'failed'
  );
  const hiddenEmbeds = clips.filter((clip) => clip.embedOnly).length;
  const canLaunch = mode === 'multicam' ? readyClips.length >= 2 : readyClips.length >= 1;

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
    const message = await history.start(layout);
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
                    <th className="py-2 pr-3 font-medium">Clip</th>
                    <th className="py-2 pr-3 font-medium">Duration</th>
                    <th className="py-2 pr-3 font-medium">Timecode</th>
                    <th className="py-2 pr-3 font-medium">Recorded</th>
                    <th className="py-2 pr-3 font-medium">Camera</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...readyClips, ...pendingClips].map((clip) => (
                    <tr key={clip.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium">{clip.title}</td>
                      <td className="py-2 pr-3">{formatDuration(clip.durationSeconds)}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{clip.startTimecode ?? '—'}</td>
                      <td className="py-2 pr-3">{formatTimestamp(clip.recordedAt)}</td>
                      <td className="py-2 pr-3">{clip.cameraRole}</td>
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
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
              if (value === 'single-camera' || value === 'multicam') setMode(value);
            }}
            className="grid gap-3 sm:grid-cols-2"
          >
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-4">
              <RadioGroupItem value="single-camera" />
              <div>
                <div className="text-sm font-medium">Single camera</div>
                <p className="text-xs text-muted-foreground">
                  One clip is linear. Several clips are concatenated in chronological order.
                </p>
              </div>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-4">
              <RadioGroupItem value="multicam" />
              <div>
                <div className="text-sm font-medium">Multicam</div>
                <p className="text-xs text-muted-foreground">
                  Needs two or more overlapping cameras in this folder.
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
                            'Running…'
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
