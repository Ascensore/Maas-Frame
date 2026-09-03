'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadNamedFile } from '@/lib/client/download-file';

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
  }, [stopPolling]);

  const start = useCallback(
    async (options: {
      projectId: string;
      folderId: string | null;
      profileId?: string | null;
      layout?: 'MULTICAM' | 'SEQUENTIAL' | 'LINEAR' | null;
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
            ...(options.layout ? { layout: options.layout } : {}),
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

  return {
    roughCut,
    cameras,
    error,
    isStarting,
    isDownloading,
    isPolling: intervalRef.current !== null,
    start,
    download,
    reset,
  };
}
