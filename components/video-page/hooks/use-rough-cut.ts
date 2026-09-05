'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadNamedFile } from '@/lib/client/download-file';
import { isWaitingForMediaWorker } from '@/lib/rough-cut/workspace';

export const ROUGH_CUT_POLL_MS = 4000;

export type RoughCutStatus = 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';

export type RoughCutCamera = {
  videoId: string;
  versionId: string | null;
  title: string;
  role: string;
  providerId: string | null;
  fileBacked: boolean;
};

export type RoughCutWarning = {
  code: string;
  message: string;
};

export type RoughCutRecord = {
  id: string;
  status: RoughCutStatus;
  projectId: string;
  folderId: string | null;
  profileId: string | null;
  requestedById: string;
  layout?: string;
  warnings: RoughCutWarning[] | null;
  error: string | null;
  hasDecisions: boolean;
  outputVideoId: string | null;
  createdAt: string;
  updatedAt: string;
};

function readClientApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function parseWarnings(value: unknown): RoughCutWarning[] | null {
  if (!Array.isArray(value)) return null;
  const warnings: RoughCutWarning[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const code = (entry as { code?: unknown }).code;
    const message = (entry as { message?: unknown }).message;
    if (typeof code === 'string' && typeof message === 'string') {
      warnings.push({ code, message });
    }
  }
  return warnings;
}

function parseRoughCut(value: unknown): RoughCutRecord | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.status !== 'string') return null;
  if (
    row.status !== 'PENDING' &&
    row.status !== 'RUNNING' &&
    row.status !== 'READY' &&
    row.status !== 'FAILED'
  ) {
    return null;
  }
  return {
    id: row.id,
    status: row.status,
    projectId: typeof row.projectId === 'string' ? row.projectId : '',
    folderId: typeof row.folderId === 'string' ? row.folderId : null,
    profileId: typeof row.profileId === 'string' ? row.profileId : null,
    requestedById: typeof row.requestedById === 'string' ? row.requestedById : '',
    layout: typeof row.layout === 'string' ? row.layout : undefined,
    warnings: parseWarnings(row.warnings),
    error: typeof row.error === 'string' ? row.error : null,
    hasDecisions: row.hasDecisions === true,
    outputVideoId: typeof row.outputVideoId === 'string' ? row.outputVideoId : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
  };
}

function isTerminal(status: RoughCutStatus): boolean {
  return status === 'READY' || status === 'FAILED';
}

export function useRoughCut() {
  const [roughCut, setRoughCut] = useState<RoughCutRecord | null>(null);
  const [cameras, setCameras] = useState<RoughCutCamera[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const pollOnce = useCallback(
    async (roughCutId: string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const response = await fetch(`/api/rough-cuts/${roughCutId}`, { cache: 'no-store' });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setError(readClientApiError(payload, 'Failed to load rough cut'));
          return;
        }
        const next = parseRoughCut(
          payload && typeof payload === 'object'
            ? (payload as { data?: { roughCut?: unknown } }).data?.roughCut
            : null
        );
        if (!next) {
          setError('Failed to load rough cut');
          return;
        }
        setRoughCut(next);
        if (isTerminal(next.status)) {
          stopPolling();
        }
      } catch {
        setError('Failed to load rough cut');
      } finally {
        inFlightRef.current = false;
      }
    },
    [stopPolling]
  );

  const startPolling = useCallback(
    (roughCutId: string) => {
      stopPolling();
      intervalRef.current = setInterval(() => {
        void pollOnce(roughCutId);
      }, ROUGH_CUT_POLL_MS);
    },
    [pollOnce, stopPolling]
  );

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    setRoughCut(null);
    setCameras([]);
    setError(null);
    setIsStarting(false);
    setIsDownloading(false);
    setIsCanceling(false);
  }, [stopPolling]);

  const start = useCallback(
    async (options: {
      projectId: string;
      folderId: string | null;
      profileId?: string | null;
      briefId?: string | null;
      layout?: 'MULTICAM' | 'SEQUENTIAL' | 'LINEAR' | null;
      clipOrder?: string[];
      cameraRoles?: Record<string, string>;
      wideCameraRole?: string;
      script?: string;
    }) => {
      if (isStarting) return 'A rough cut is already running';
      setIsStarting(true);
      setError(null);
      try {
        const response = await fetch(`/api/projects/${options.projectId}/rough-cuts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folderId: options.folderId,
            ...(options.profileId ? { profileId: options.profileId } : {}),
            ...(options.briefId ? { briefId: options.briefId } : {}),
            ...(options.layout ? { layout: options.layout } : {}),
            ...(options.clipOrder && options.clipOrder.length > 0
              ? { clipOrder: options.clipOrder }
              : {}),
            ...(options.cameraRoles && Object.keys(options.cameraRoles).length > 0
              ? { cameraRoles: options.cameraRoles }
              : {}),
            ...(options.wideCameraRole ? { wideCameraRole: options.wideCameraRole } : {}),
            ...(options.script ? { script: options.script } : {}),
          }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const message = readClientApiError(payload, 'Failed to start rough cut');
          setError(message);
          return message;
        }
        const data = (payload as { data?: { roughCut?: unknown; cameras?: unknown } }).data;
        const created = parseRoughCut(data?.roughCut);
        if (!created) {
          const message = 'Failed to start rough cut';
          setError(message);
          return message;
        }
        const nextCameras = Array.isArray(data?.cameras) ? (data.cameras as RoughCutCamera[]) : [];
        setCameras(nextCameras);
        setRoughCut(created);
        if (!isTerminal(created.status)) {
          startPolling(created.id);
        }
        return null;
      } catch {
        const message = 'Failed to start rough cut';
        setError(message);
        return message;
      } finally {
        setIsStarting(false);
      }
    },
    [isStarting, startPolling]
  );

  const download = useCallback(
    async (format: 'otio' | 'xml') => {
      if (!roughCut || roughCut.status !== 'READY') {
        return 'Rough cut is not ready to download';
      }
      setIsDownloading(true);
      try {
        const fileName = `rough-cut.${format}`;
        const saved = await downloadNamedFile(
          `/api/rough-cuts/${roughCut.id}/download?format=${format}`,
          fileName
        );
        if (!saved) {
          const message = 'Failed to download rough cut';
          setError(message);
          return message;
        }
        return null;
      } finally {
        setIsDownloading(false);
      }
    },
    [roughCut]
  );

  const cancel = useCallback(async () => {
    if (!roughCut) return 'Rough cut is not running';
    if (isCanceling) return null;
    setIsCanceling(true);
    try {
      const response = await fetch(`/api/rough-cuts/${roughCut.id}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = readClientApiError(payload, 'Failed to cancel rough cut');
        setError(message);
        return message;
      }
      stopPolling();
      setRoughCut(null);
      setCameras([]);
      return null;
    } catch {
      const message = 'Failed to cancel rough cut';
      setError(message);
      return message;
    } finally {
      setIsCanceling(false);
    }
  }, [isCanceling, roughCut, stopPolling]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!roughCut || roughCut.status !== 'PENDING') return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [roughCut]);

  const waitingForWorker = Boolean(
    roughCut && isWaitingForMediaWorker(roughCut.status, roughCut.createdAt, nowMs)
  );

  return {
    roughCut,
    cameras,
    error,
    isStarting,
    isDownloading,
    isCanceling,
    isPolling: intervalRef.current !== null,
    waitingForWorker,
    start,
    download,
    cancel,
    reset,
  };
}

function folderQueryValue(folderId: string | null): string {
  return folderId ?? 'root';
}

function shouldKeepPolling(cuts: RoughCutRecord[]): boolean {
  const now = Date.now();
  return cuts.some((cut) => {
    if (cut.status === 'PENDING' || cut.status === 'RUNNING') return true;
    if (cut.status === 'READY' && !cut.outputVideoId) {
      const updated = Date.parse(cut.updatedAt || cut.createdAt);
      return Number.isFinite(updated) && now - updated < 15 * 60 * 1000;
    }
    return false;
  });
}

export function useRoughCutHistory(projectId: string, folderId: string | null) {
  const [cuts, setCuts] = useState<RoughCutRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelingId, setIsCancelingId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const response = await fetch(
        `/api/projects/${projectId}/rough-cuts?folderId=${encodeURIComponent(folderQueryValue(folderId))}`,
        { cache: 'no-store' }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(readClientApiError(payload, 'Failed to load rough cuts'));
        return;
      }
      const rows =
        payload && typeof payload === 'object'
          ? (payload as { data?: { roughCuts?: unknown } }).data?.roughCuts
          : null;
      const next = Array.isArray(rows)
        ? rows.map(parseRoughCut).filter((row): row is RoughCutRecord => Boolean(row))
        : [];
      setCuts(next);
      if (!shouldKeepPolling(next)) {
        stopPolling();
      }
    } catch {
      setError('Failed to load rough cuts');
    } finally {
      inFlightRef.current = false;
    }
  }, [folderId, projectId, stopPolling]);

  const startPolling = useCallback(() => {
    if (intervalRef.current !== null) return;
    intervalRef.current = setInterval(() => {
      void load();
    }, ROUGH_CUT_POLL_MS);
  }, [load]);

  useEffect(() => {
    setIsLoading(true);
    void load().finally(() => setIsLoading(false));
  }, [load]);

  useEffect(() => {
    if (shouldKeepPolling(cuts)) {
      startPolling();
    } else {
      stopPolling();
    }
  }, [cuts, startPolling, stopPolling]);

  useEffect(() => {
    if (!cuts.some((cut) => cut.status === 'PENDING')) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cuts]);

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const start = useCallback(
    async (
      layout: 'MULTICAM' | 'SEQUENTIAL' | 'LINEAR',
      options?: {
        clipOrder?: string[];
        cameraRoles?: Record<string, string>;
        wideCameraRole?: string;
      }
    ) => {
      if (isStarting) return 'A rough cut is already running';
      setIsStarting(true);
      setError(null);
      try {
        const response = await fetch(`/api/projects/${projectId}/rough-cuts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folderId,
            layout,
            ...(options?.clipOrder && options.clipOrder.length > 0
              ? { clipOrder: options.clipOrder }
              : {}),
            ...(options?.cameraRoles && Object.keys(options.cameraRoles).length > 0
              ? { cameraRoles: options.cameraRoles }
              : {}),
            ...(options?.wideCameraRole ? { wideCameraRole: options.wideCameraRole } : {}),
          }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const message = readClientApiError(payload, 'Failed to start rough cut');
          setError(message);
          return message;
        }
        const created = parseRoughCut(
          payload && typeof payload === 'object'
            ? (payload as { data?: { roughCut?: unknown } }).data?.roughCut
            : null
        );
        if (!created) {
          const message = 'Failed to start rough cut';
          setError(message);
          return message;
        }
        setCuts((current) => [created, ...current.filter((cut) => cut.id !== created.id)]);
        startPolling();
        return null;
      } catch {
        const message = 'Failed to start rough cut';
        setError(message);
        return message;
      } finally {
        setIsStarting(false);
      }
    },
    [folderId, isStarting, projectId, startPolling]
  );

  const cancel = useCallback(
    async (cutId: string) => {
      if (isCancelingId) return null;
      setIsCancelingId(cutId);
      try {
        const response = await fetch(`/api/rough-cuts/${cutId}`, { method: 'DELETE' });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const message = readClientApiError(payload, 'Failed to cancel rough cut');
          setError(message);
          return message;
        }
        setCuts((current) => current.filter((cut) => cut.id !== cutId));
        return null;
      } catch {
        const message = 'Failed to cancel rough cut';
        setError(message);
        return message;
      } finally {
        setIsCancelingId(null);
      }
    },
    [isCancelingId]
  );

  const download = useCallback(async (cutId: string, format: 'otio' | 'xml') => {
    const saved = await downloadNamedFile(
      `/api/rough-cuts/${cutId}/download?format=${format}`,
      `rough-cut.${format}`
    );
    if (!saved) {
      const message = 'Failed to download rough cut';
      setError(message);
      return message;
    }
    return null;
  }, []);

  return {
    cuts,
    error,
    isLoading,
    isStarting,
    isCancelingId,
    isPolling: intervalRef.current !== null,
    waitingForWorker: (cut: RoughCutRecord) =>
      isWaitingForMediaWorker(cut.status, cut.createdAt, nowMs),
    refresh: load,
    start,
    cancel,
    download,
  };
}
