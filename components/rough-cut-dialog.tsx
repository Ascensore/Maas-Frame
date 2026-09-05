'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
import {
  guessRoughCutLayout,
  type LayoutGuessClip,
  type LayoutGuessReason,
} from '@/lib/rough-cut/layout';
import type { RoughCutLayout } from '@/lib/rough-cut/types';
import type { EditorialProjectType } from '@/lib/rough-cut/brief';
import { PROJECT_TYPE_LABELS } from '@/components/editorial-briefs-card';
import { SCRIPT_MAX_CHARS } from '@/lib/rough-cut/script';
import { isWaitingForTranscript } from '@/lib/rough-cut/workspace';

export type RoughCutDialogVideo = {
  id: string;
  title: string;
  metadata?: unknown;
  position?: number;
  durationSeconds?: number | null;
  startTimecode?: string | null;
  recordedAt?: string | null;
  createdAt?: string | null;
};

export type RoughCutDialogBrief = {
  id: string;
  name: string;
  projectType: EditorialProjectType;
  isDefault: boolean;
  /** Only the part the dialog reads; the endpoint returns the whole config. */
  config?: { takeSelection?: { enabled?: boolean } };
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

function guessReasonLabel(
  reason: LayoutGuessReason,
  effectiveLayout: RoughCutLayout,
  override: RoughCutLayout | null
): string {
  if (override) {
    return effectiveLayout === 'SEQUENTIAL'
      ? 'Using your sequential order. Silence and short takes are dropped.'
      : effectiveLayout === 'LINEAR'
        ? 'Using a single-track linear edit. Silence and short takes are dropped.'
        : 'Using multicam switching from speaker and camera roles.';
  }
  if (reason === 'single-clip') {
    return 'Guessed a single-clip linear edit.';
  }
  if (reason === 'overlapping-timecode') {
    return 'Guessed multicam from overlapping start timecode.';
  }
  if (reason === 'overlapping-recorded-at') {
    return 'Guessed multicam from overlapping recorded-at timestamps.';
  }
  if (reason === 'distinct-camera-metadata') {
    return 'Guessed multicam from camera metadata.';
  }
  if (reason === 'sequential-timecode') {
    return 'Guessed sequential clips from non-overlapping start timecode.';
  }
  if (reason === 'sequential-recorded-at') {
    return 'Guessed sequential clips from recorded-at metadata.';
  }
  if (reason === 'sequential-filenames') {
    return 'Guessed sequential clips from numbered filenames.';
  }
  if (reason === 'distinct-camera-roles') {
    return 'Guessed multicam from camera names in the filenames.';
  }
  return 'Guessed multicam. Switch to sequential if these files are one camera in order.';
}

function orderPreviewCameras<T extends { id: string }>(cameras: T[], orderedIds: string[]): T[] {
  const byId = new Map(cameras.map((camera) => [camera.id, camera]));
  const ordered = orderedIds
    .map((id) => byId.get(id))
    .filter((camera): camera is T => Boolean(camera));
  const seen = new Set(ordered.map((camera) => camera.id));
  return [...ordered, ...cameras.filter((camera) => !seen.has(camera.id))];
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
  const {
    roughCut,
    cameras,
    error,
    isStarting,
    isDownloading,
    waitingForWorker,
    start,
    download,
    reset,
  } = useRoughCut();
  const [profiles, setProfiles] = useState<RoughCutDialogProfile[]>([]);
  const [profileId, setProfileId] = useState<string>('default');
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [briefs, setBriefs] = useState<RoughCutDialogBrief[]>([]);
  const [briefId, setBriefId] = useState<string>('inherit');
  const [script, setScript] = useState('');
  const [layout, setLayout] = useState<RoughCutLayout | null>(null);
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const [cameraOverride, setCameraOverride] = useState<Record<string, string>>({});
  const [focusOverride, setFocusOverride] = useState<string | null>(null);

  const guessClips: LayoutGuessClip[] = useMemo(
    () =>
      videos.map((video, index) => ({
        id: video.id,
        title: video.title,
        position: video.position ?? index,
        durationSeconds: video.durationSeconds ?? 0,
        startTimecode: video.startTimecode ?? null,
        recordedAt: video.recordedAt ?? null,
        createdAt: video.createdAt ?? null,
        metadata: metadataStringRecord(video.metadata),
      })),
    [videos]
  );
  const guess = useMemo(() => guessRoughCutLayout(guessClips), [guessClips]);
  const effectiveLayout: RoughCutLayout =
    layout ?? (videos.length > 0 ? guess.layout : videoCount <= 1 ? 'LINEAR' : 'MULTICAM');

  const defaultNames = useMemo(() => {
    const inferred: Record<string, string> = {};
    const generic = videos.filter(
      (video) =>
        inferCameraRole(video.title, metadataStringRecord(video.metadata), 'camera') === 'CAM'
    );
    let genericIndex = 0;
    for (const video of videos) {
      const role = inferCameraRole(video.title, metadataStringRecord(video.metadata), 'camera');
      if (role === 'CAM' && generic.length > 1) {
        genericIndex += 1;
        inferred[video.id] = `CAM ${genericIndex}`;
      } else {
        inferred[video.id] = role;
      }
    }
    return inferred;
  }, [videos]);
  const cameraNames = { ...defaultNames, ...cameraOverride };
  const clipOrder = useMemo(() => {
    const ids = videos.map((video) => video.id);
    const idSet = new Set(ids);
    const base = orderOverride ?? (guess.orderedIds.length > 0 ? guess.orderedIds : ids);
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const id of base) {
      if (!idSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
    for (const id of ids) {
      if (!seen.has(id)) ordered.push(id);
    }
    return ordered;
  }, [guess.orderedIds, orderOverride, videos]);
  const focusVideoId =
    focusOverride && videos.some((video) => video.id === focusOverride)
      ? focusOverride
      : (videos.find((video) => cameraNames[video.id] === 'WIDE')?.id ?? videos[0]?.id ?? null);

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

  // The brief is optional: when the list cannot be loaded the run simply
  // inherits one from the folder, the project or the workspace default.
  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/editorial-briefs`, {
          cache: 'no-store',
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) return;
        const list = (payload as { data?: { briefs?: RoughCutDialogBrief[] } }).data?.briefs;
        if (!cancelled && Array.isArray(list)) setBriefs(list);
      } catch {
        // see above
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

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
  // An ASCENSORE brief keeps a single take, so a script typed under it is
  // stored but never used to choose one. Say so before the run rather than
  // through a `script-ignored` warning after it.
  const selectedBrief =
    briefId === 'inherit' ? null : (briefs.find((brief) => brief.id === briefId) ?? null);
  const briefKeepsOneTake = selectedBrief?.config?.takeSelection?.enabled === false;
  const status = roughCut?.status ?? null;
  const busy = isStarting || status === 'PENDING' || status === 'RUNNING';

  const moveDialogClip = (index: number, direction: -1 | 1) => {
    const ids = orderPreviewCameras(previewCameras, clipOrder).map((entry) => entry.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
    const copy = [...ids];
    const [item] = copy.splice(index, 1);
    if (!item) return;
    copy.splice(nextIndex, 0, item);
    setOrderOverride(copy);
  };

  const handleGenerate = async () => {
    const roles: Record<string, string> = {};
    for (const video of videos) {
      const name = cameraNames[video.id]?.trim();
      if (name) roles[video.id] = name;
    }
    const focusRole = focusVideoId ? cameraNames[focusVideoId] : undefined;
    await start({
      projectId,
      folderId,
      profileId: profileId === 'default' ? null : profileId,
      briefId: briefId === 'inherit' ? null : briefId,
      layout: effectiveLayout,
      clipOrder: effectiveLayout === 'SEQUENTIAL' ? clipOrder : undefined,
      cameraRoles: effectiveLayout === 'MULTICAM' ? roles : undefined,
      wideCameraRole: effectiveLayout === 'MULTICAM' ? focusRole : undefined,
      script: script.trim() || undefined,
    });
  };

  const waitingForTranscript = isWaitingForTranscript(status ?? '', roughCut?.warnings);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setLayout(null);
          setBriefId('inherit');
          setScript('');
          setOrderOverride(null);
          setCameraOverride({});
          setFocusOverride(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate rough cut</DialogTitle>
          <DialogDescription>
            Build an OTIO and Premiere XML timeline from the {videoCount} video
            {videoCount === 1 ? '' : 's'} in {folderLabel}. Choose whether these files are
            simultaneous cameras, sequential takes, or a single clip. Analysis runs in the media
            worker; downloads are generated from the saved edit list.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">How these files relate</p>
            <Select
              value={effectiveLayout}
              onValueChange={(value) => setLayout(value as RoughCutLayout)}
              disabled={busy || !!status}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MULTICAM">Multicam (same moment, different cameras)</SelectItem>
                <SelectItem value="SEQUENTIAL">Sequential clips (one after another)</SelectItem>
                <SelectItem value="LINEAR">Single clip (drop silence and short takes)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {guessReasonLabel(guess.reason, effectiveLayout, layout)}
            </p>
          </div>

          {effectiveLayout !== 'LINEAR' && previewCameras.length > 1 ? (
            <div>
              <p className="text-sm font-medium mb-2">
                {effectiveLayout === 'SEQUENTIAL' ? 'Edit order' : 'Camera names and safety shot'}
              </p>
              <ul className="rounded-md border divide-y max-h-52 overflow-y-auto">
                {(effectiveLayout === 'SEQUENTIAL'
                  ? orderPreviewCameras(previewCameras, clipOrder)
                  : previewCameras
                ).map((camera, index, list) => (
                  <li key={camera.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    {effectiveLayout === 'SEQUENTIAL' ? (
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Move ${camera.title} earlier`}
                          disabled={busy || !!status || index === 0}
                          onClick={() => moveDialogClip(index, -1)}
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Move ${camera.title} later`}
                          disabled={busy || !!status || index >= list.length - 1}
                          onClick={() => moveDialogClip(index, 1)}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : null}
                    <span className="truncate min-w-0 flex-1">{camera.title}</span>
                    {effectiveLayout === 'MULTICAM' ? (
                      <>
                        <Input
                          value={cameraNames[camera.id] ?? camera.role}
                          maxLength={40}
                          aria-label={`Camera name for ${camera.title}`}
                          className="h-8 w-28 shrink-0"
                          disabled={busy || !!status}
                          onChange={(event) => {
                            const next = event.target.value;
                            setCameraOverride((current) => ({ ...current, [camera.id]: next }));
                          }}
                        />
                        <label className="inline-flex items-center gap-1 text-xs shrink-0">
                          <input
                            type="radio"
                            name="dialog-focus-camera"
                            checked={focusVideoId === camera.id}
                            disabled={busy || !!status}
                            onChange={() => setFocusOverride(camera.id)}
                          />
                          Safety
                        </label>
                      </>
                    ) : (
                      <span className="text-muted-foreground shrink-0">
                        {cameraNames[camera.id] ?? camera.role}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : previewCameras.length === 1 ? (
            <p className="text-sm text-muted-foreground">
              One file-backed clip. Silence and takes shorter than the profile minimum shot are
              dropped.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Uses every file-backed video in this folder. Camera roles come from the{' '}
              <code>camera</code> metadata field, then the filename. Sequential order prefers start
              timecode, then recorded-at metadata, then the filename.
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
              {waitingForWorker
                ? 'Waiting for the media worker…'
                : waitingForTranscript
                  ? 'Waiting for the transcript…'
                  : status === 'PENDING'
                    ? 'Queued…'
                    : 'Assembling the rough cut…'}
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
          {briefs.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Editorial brief</p>
              <Select value={briefId} onValueChange={setBriefId} disabled={busy || !!status}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">
                    Inherited from the folder, project or workspace default
                  </SelectItem>
                  {briefs.map((brief) => (
                    <SelectItem key={brief.id} value={brief.id}>
                      {brief.name} · {PROJECT_TYPE_LABELS[brief.projectType]}
                      {brief.isDefault ? ' (default)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-2">
            <label htmlFor="rough-cut-script" className="text-sm font-medium">
              Original script (optional)
            </label>
            <Textarea
              id="rough-cut-script"
              value={script}
              onChange={(event) => setScript(event.target.value)}
              maxLength={SCRIPT_MAX_CHARS}
              rows={5}
              placeholder="Paste the copy the speaker read, one line or sentence per beat."
              disabled={busy || !!status}
            />
            <p className="text-xs text-muted-foreground">
              {briefKeepsOneTake
                ? 'This brief keeps a single take, so the script is recorded but not used to pick takes.'
                : 'Takes are matched against the script: the take closest to each line is kept, and lines with no clean take are flagged after assembly.'}
            </p>
            <p className="text-xs text-muted-foreground">
              This script is what guides take selection. The project&apos;s editorial guidelines are
              recorded with the run for reviewers, but the assembler does not read them.
            </p>
          </div>

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
            <Button
              onClick={() => void handleGenerate()}
              disabled={busy || (effectiveLayout === 'MULTICAM' ? videoCount < 2 : videoCount < 1)}
            >
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Generate
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
