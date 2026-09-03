'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useRoughCut } from '@/components/video-page/hooks/use-rough-cut';
import { inferCameraRole, metadataStringRecord } from '@/lib/rough-cut/camera-roles';

export type RoughCutDialogVideo = {
  id: string;
  title: string;
  metadata?: unknown;
};

export type RoughCutDialogProfile = {
  id: string;
  name: string;
  isDefault: boolean;
  minShotSeconds: number;
  safetyPauseSeconds: number;
  overlapBehaviour: string;
};

interface RoughCutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  workspaceId: string | null;
  folderId: string | null;
  folderLabel: string;
  videoCount: number;
  videos: RoughCutDialogVideo[];
}

export function RoughCutDialog({
  open,
  onOpenChange,
  projectId,
  workspaceId,
  folderId,
  folderLabel,
  videoCount,
  videos,
}: RoughCutDialogProps) {
  const { roughCut, cameras, error, isStarting, isDownloading, start, download, reset } =
    useRoughCut();
  const [profiles, setProfiles] = useState<RoughCutDialogProfile[]>([]);
  const [profileId, setProfileId] = useState<string>('default');
  const [profilesError, setProfilesError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/rough-cut-profiles`, {
          cache: 'no-store',
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          if (!cancelled) setProfilesError('Could not load rough-cut profiles');
          return;
        }
        const list = (payload as { data?: { profiles?: RoughCutDialogProfile[] } }).data?.profiles;
        if (cancelled || !Array.isArray(list)) return;
        setProfiles(list);
        const preferred = list.find((profile) => profile.isDefault) ?? list[0];
        if (preferred) setProfileId(preferred.id);
      } catch {
        if (!cancelled) setProfilesError('Could not load rough-cut profiles');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, reset, workspaceId]);

  const previewCameras = useMemo(() => {
    if (cameras.length > 0) {
      return cameras.map((camera) => ({
        id: camera.videoId,
        title: camera.title,
        role: camera.role,
      }));
    }
    return videos.map((video) => ({
      id: video.id,
      title: video.title,
      role: inferCameraRole(video.title, metadataStringRecord(video.metadata), 'camera'),
    }));
  }, [cameras, videos]);

  const selectedProfile = profiles.find((profile) => profile.id === profileId) ?? null;
  const status = roughCut?.status ?? null;
  const busy = isStarting || status === 'PENDING' || status === 'RUNNING';

  const handleGenerate = async () => {
    await start({
      projectId,
      folderId,
      profileId: profileId === 'default' ? null : profileId,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate rough cut</DialogTitle>
          <DialogDescription>
            Build an OTIO and Premiere XML timeline from the {videoCount} video
            {videoCount === 1 ? '' : 's'} in {folderLabel}. Analysis runs in the media worker;
            downloads are generated from the saved edit list.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {previewCameras.length > 0 ? (
            <div>
              <p className="text-sm font-medium mb-2">Detected camera roles</p>
              <ul className="rounded-md border divide-y max-h-40 overflow-y-auto">
                {previewCameras.map((camera) => (
                  <li
                    key={camera.id}
                    className="flex items-center justify-between px-3 py-2 text-sm"
                  >
                    <span className="truncate pr-3">{camera.title}</span>
                    <span className="text-muted-foreground shrink-0">{camera.role}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Uses every file-backed video in this folder. Camera roles come from the{' '}
              <code>camera</code> metadata field, then the filename.
            </p>
          )}

          {profiles.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Edit profile</p>
              <Select value={profileId} onValueChange={setProfileId} disabled={busy || !!status}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Workspace default" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name}
                      {profile.isDefault ? ' (default)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedProfile ? (
                <p className="text-xs text-muted-foreground">
                  Min shot {selectedProfile.minShotSeconds}s · pause{' '}
                  {selectedProfile.safetyPauseSeconds}s · overlap {selectedProfile.overlapBehaviour}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No workspace profile yet. The built-in default is used (1.5s minimum shot, cut to wide
              on overlap).
            </p>
          )}

          {status === 'PENDING' || status === 'RUNNING' ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {status === 'PENDING' ? 'Queued…' : 'Assembling the rough cut…'}
            </div>
          ) : null}

          {status === 'READY' ? (
            <p className="text-sm">Ready. Download OTIO for most NLEs, or FCP7 XML for Premiere.</p>
          ) : null}

          {status === 'FAILED' ? (
            <p className="text-sm text-destructive">{roughCut?.error || 'Rough cut failed'}</p>
          ) : null}

          {roughCut?.warnings && roughCut.warnings.length > 0 ? (
            <ul className="text-xs text-amber-700 dark:text-amber-400 space-y-1">
              {roughCut.warnings.map((warning) => (
                <li key={`${warning.code}-${warning.message}`}>{warning.message}</li>
              ))}
            </ul>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {profilesError ? <p className="text-sm text-muted-foreground">{profilesError}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {status === 'READY' ? (
            <>
              <Button
                variant="outline"
                onClick={() => void download('otio')}
                disabled={isDownloading}
              >
                {isDownloading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Download OTIO
              </Button>
              <Button onClick={() => void download('xml')} disabled={isDownloading}>
                {isDownloading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Download XML
              </Button>
            </>
          ) : (
            <Button onClick={() => void handleGenerate()} disabled={busy || videoCount < 2}>
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Generate
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
