'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Scissors, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readClientApiError } from '@/lib/client/api-error';
import { cropFocusAt, type CropPoint } from '@/lib/short-form/crop';
import {
  BURN_IN_FONTS,
  type BurnInStyle,
  type BurnInPosition,
} from '@/lib/rough-cut/subtitle-style';

export type Candidate = {
  id: string;
  rank: number;
  sourceStartSec: number;
  sourceEndSec: number;
  title: string;
  socialCaption: string;
  hashtags: string[];
  cropMode: 'AUTO' | 'MANUAL' | 'PADDED';
  cropTrack: CropPoint[] | null;
  focusX: number | null;
  focusY: number | null;
  captionStyle: BurnInStyle;
  status: string;
  error: string | null;
  outputVideo?: { id: string; versions: Array<{ originalUrl: string }> } | null;
};

type Batch = {
  id: string;
  status: string;
  warnings: string[];
  error: string | null;
  candidates: Candidate[];
};

export const SHORT_FORM_POLL_MS = 3000;

export function shortPreviewObjectPosition(candidate: Candidate, sourceTime: number): string {
  if (candidate.cropMode === 'MANUAL') {
    return `${(candidate.focusX ?? 0.5) * 100}% ${(candidate.focusY ?? 0.4) * 100}%`;
  }
  if (candidate.cropMode === 'AUTO') {
    const focus = cropFocusAt(
      candidate.cropTrack ?? [],
      Math.max(0, sourceTime - candidate.sourceStartSec)
    );
    if (focus) return `${focus.x * 100}% ${focus.y * 100}%`;
  }
  return '50% 50%';
}

export function ShortFormPanel({ roughCutId }: { roughCutId: string }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [boundaries, setBoundaries] = useState<number[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewTimes, setPreviewTimes] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadBatch = useCallback(async (batchId: string) => {
    const response = await fetch(`/api/short-form-batches/${batchId}`, { cache: 'no-store' });
    const payload = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(readClientApiError(payload, 'Failed to load short-form batch'));
    const data = payload.data as {
      batch: Batch;
      canEdit: boolean;
      sourceUrl: string;
      sentenceBoundaries: number[];
    };
    setBatch(data.batch);
    setCanEdit(data.canEdit);
    setSourceUrl(data.sourceUrl);
    setBoundaries(data.sentenceBoundaries);
  }, []);

  const loadBatches = useCallback(async () => {
    const response = await fetch(`/api/rough-cuts/${roughCutId}/shorts`, { cache: 'no-store' });
    if (response.status === 404) {
      setAvailable(false);
      return;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(readClientApiError(payload, 'Failed to load short-form batches'));
    const next = (payload.data?.batches ?? []) as Batch[];
    setAvailable(true);
    setCanEdit(Boolean(payload.data?.canEdit));
    setBatches(next);
    if (next[0]) await loadBatch(next[0].id);
  }, [loadBatch, roughCutId]);

  useEffect(() => {
    void loadBatches().catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause))
    );
  }, [loadBatches]);

  useEffect(() => {
    const batchActive = batch && ['PENDING', 'ANALYZING', 'RANKING'].includes(batch.status);
    const renderActive = batch?.candidates.some((candidate) =>
      ['APPROVED', 'RENDERING'].includes(candidate.status)
    );
    if (!batch || (!batchActive && !renderActive)) return;
    const timer = window.setInterval(() => {
      void loadBatch(batch.id).catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      );
    }, SHORT_FORM_POLL_MS);
    return () => window.clearInterval(timer);
  }, [batch, loadBatch]);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/rough-cuts/${roughCutId}/shorts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          count: 8,
          minDurationSeconds: 15,
          maxDurationSeconds: 45,
          useAi: true,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(readClientApiError(payload, 'Could not create short-form batch'));
      await loadBatches();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const patchCandidate = async (candidate: Candidate, update: Record<string, unknown>) => {
    const response = await fetch(`/api/shorts/${candidate.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(readClientApiError(payload, 'Could not update short'));
    if (batch) await loadBatch(batch.id);
  };

  const render = async () => {
    if (!batch || selected.size === 0) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/short-form-batches/${batch.id}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidateIds: [...selected] }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readClientApiError(payload, 'Could not render shorts'));
      setSelected(new Set());
      await loadBatch(batch.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const boundaryOptions = useMemo(
    () => boundaries.map((value) => Number(value.toFixed(3))),
    [boundaries]
  );
  if (available === false) return null;
  return (
    <section className="space-y-3 border-t pt-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
            <Smartphone className="h-3.5 w-3.5" /> Vertical shorts
          </p>
          <p className="text-muted-foreground text-xs">
            Sentence-aligned 9:16 clips from this exact version.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void create()}
          disabled={busy || !canEdit}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Scissors className="h-3.5 w-3.5" />
          )}
          Find clips
        </Button>
      </div>
      {batches.length > 1 && (
        <select
          className="border-input bg-background rounded-md border px-2 py-1 text-xs"
          value={batch?.id ?? ''}
          onChange={(event) => void loadBatch(event.target.value)}
        >
          {batches.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.status} · {entry.id.slice(-6)}
            </option>
          ))}
        </select>
      )}
      {batch && ['PENDING', 'ANALYZING', 'RANKING'].includes(batch.status) && (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Analyzing transcript, scenes, and faces…
        </p>
      )}
      {batch?.warnings.map((warning) => (
        <p key={warning} className="flex gap-1.5 text-xs text-amber-700">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {warning}
        </p>
      ))}
      {batch?.error && <p className="text-destructive text-xs">{batch.error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {batch?.candidates.map((candidate) => (
          <article key={candidate.id} className="space-y-2 rounded-lg border p-2">
            <div className="bg-muted relative mx-auto aspect-[9/16] max-h-80 overflow-hidden rounded-md">
              {sourceUrl && (
                <video
                  className={
                    candidate.cropMode === 'PADDED'
                      ? 'h-full w-full object-contain'
                      : 'h-full w-full object-cover'
                  }
                  src={`${sourceUrl}#t=${candidate.sourceStartSec},${candidate.sourceEndSec}`}
                  style={{
                    objectPosition: shortPreviewObjectPosition(
                      candidate,
                      previewTimes[candidate.id] ?? candidate.sourceStartSec
                    ),
                  }}
                  onTimeUpdate={(event) => {
                    const currentTime = event.currentTarget.currentTime;
                    setPreviewTimes((current) => ({
                      ...current,
                      [candidate.id]: currentTime,
                    }));
                  }}
                  controls
                  preload="metadata"
                />
              )}
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-[18%] border-t border-dashed border-white/50 bg-black/10"
                aria-label="Platform overlay safe area"
              />
            </div>
            <fieldset className="min-w-0 space-y-2" disabled={!canEdit}>
              <Input
                value={candidate.title}
                maxLength={120}
                onChange={(event) =>
                  setBatch((current) =>
                    current
                      ? {
                          ...current,
                          candidates: current.candidates.map((item) =>
                            item.id === candidate.id ? { ...item, title: event.target.value } : item
                          ),
                        }
                      : current
                  )
                }
                onBlur={(event) =>
                  void patchCandidate(candidate, { title: event.target.value }).catch((cause) =>
                    setError(String(cause))
                  )
                }
              />
              <textarea
                className="border-input bg-background min-h-16 w-full rounded-md border px-2 py-1 text-xs"
                value={candidate.socialCaption}
                maxLength={2200}
                aria-label="Social caption"
                onChange={(event) =>
                  setBatch((current) =>
                    current
                      ? {
                          ...current,
                          candidates: current.candidates.map((item) =>
                            item.id === candidate.id
                              ? { ...item, socialCaption: event.target.value }
                              : item
                          ),
                        }
                      : current
                  )
                }
                onBlur={(event) =>
                  void patchCandidate(candidate, { socialCaption: event.target.value }).catch(
                    (cause) => setError(String(cause))
                  )
                }
              />
              <Input
                value={candidate.hashtags.join(' ')}
                aria-label="Hashtags"
                placeholder="#topic #insight"
                onChange={(event) => {
                  const hashtags = event.target.value.split(/\s+/).filter(Boolean);
                  setBatch((current) =>
                    current
                      ? {
                          ...current,
                          candidates: current.candidates.map((item) =>
                            item.id === candidate.id ? { ...item, hashtags } : item
                          ),
                        }
                      : current
                  );
                }}
                onBlur={(event) =>
                  void patchCandidate(candidate, {
                    hashtags: event.target.value.split(/\s+/).filter(Boolean),
                  }).catch((cause) => setError(String(cause)))
                }
              />
              <div className="flex gap-2 text-xs">
                <select
                  className="border-input bg-background flex-1 rounded-md border px-2"
                  value={candidate.sourceStartSec}
                  onChange={(event) =>
                    void patchCandidate(candidate, { start: Number(event.target.value) }).catch(
                      (cause) => setError(String(cause))
                    )
                  }
                >
                  {boundaryOptions
                    .filter((value) => value < candidate.sourceEndSec)
                    .map((value) => (
                      <option key={value} value={value}>
                        {value.toFixed(1)}s
                      </option>
                    ))}
                </select>
                <select
                  className="border-input bg-background flex-1 rounded-md border px-2"
                  value={candidate.sourceEndSec}
                  onChange={(event) =>
                    void patchCandidate(candidate, { end: Number(event.target.value) }).catch(
                      (cause) => setError(String(cause))
                    )
                  }
                >
                  {boundaryOptions
                    .filter((value) => value > candidate.sourceStartSec)
                    .map((value) => (
                      <option key={value} value={value}>
                        {value.toFixed(1)}s
                      </option>
                    ))}
                </select>
              </div>
              <select
                className="border-input bg-background w-full rounded-md border px-2 py-1 text-xs"
                value={candidate.cropMode}
                onChange={(event) =>
                  void patchCandidate(candidate, {
                    cropMode: event.target.value,
                    ...(event.target.value === 'MANUAL' ? { focusX: 0.5, focusY: 0.4 } : {}),
                  }).catch((cause) => setError(String(cause)))
                }
              >
                <option value="AUTO">Follow active face</option>
                <option value="MANUAL">Fixed focal point</option>
                <option value="PADDED">Centered with padding</option>
              </select>
              {candidate.cropMode === 'MANUAL' && (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <label>
                    Focus X
                    <input
                      className="w-full"
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={candidate.focusX ?? 0.5}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          focusX: Number(event.target.value),
                          focusY: candidate.focusY ?? 0.4,
                        }).catch((cause) => setError(String(cause)))
                      }
                    />
                  </label>
                  <label>
                    Focus Y
                    <input
                      className="w-full"
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={candidate.focusY ?? 0.4}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          focusX: candidate.focusX ?? 0.5,
                          focusY: Number(event.target.value),
                        }).catch((cause) => setError(String(cause)))
                      }
                    />
                  </label>
                </div>
              )}
              <details className="rounded border p-2 text-xs">
                <summary className="cursor-pointer font-medium">Caption style</summary>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label>
                    Font
                    <select
                      className="border-input bg-background w-full rounded border px-1 py-0.5"
                      value={candidate.captionStyle.font}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          captionStyle: { ...candidate.captionStyle, font: event.target.value },
                        }).catch((cause) => setError(String(cause)))
                      }
                    >
                      {BURN_IN_FONTS.map((font) => (
                        <option key={font.id} value={font.id}>
                          {font.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Position
                    <select
                      className="border-input bg-background w-full rounded border px-1 py-0.5"
                      value={candidate.captionStyle.position}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          captionStyle: {
                            ...candidate.captionStyle,
                            position: event.target.value as BurnInPosition,
                          },
                        }).catch((cause) => setError(String(cause)))
                      }
                    >
                      <option value="bottom">Bottom</option>
                      <option value="center">Center</option>
                      <option value="top">Top</option>
                    </select>
                  </label>
                  <label>
                    Font size
                    <input
                      className="border-input bg-background w-full rounded border px-1 py-0.5"
                      type="number"
                      min={16}
                      max={120}
                      value={candidate.captionStyle.fontSize}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          captionStyle: {
                            ...candidate.captionStyle,
                            fontSize: Number(event.target.value),
                          },
                        }).catch((cause) => setError(String(cause)))
                      }
                    />
                  </label>
                  <label>
                    Safe margin
                    <input
                      className="border-input bg-background w-full rounded border px-1 py-0.5"
                      type="number"
                      min={0}
                      max={400}
                      value={candidate.captionStyle.marginVertical}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          captionStyle: {
                            ...candidate.captionStyle,
                            marginVertical: Number(event.target.value),
                          },
                        }).catch((cause) => setError(String(cause)))
                      }
                    />
                  </label>
                  <label>
                    Words per cue
                    <input
                      className="border-input bg-background w-full rounded border px-1 py-0.5"
                      type="number"
                      min={1}
                      max={14}
                      value={candidate.captionStyle.maxWordsPerCue}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          captionStyle: {
                            ...candidate.captionStyle,
                            maxWordsPerCue: Number(event.target.value),
                          },
                        }).catch((cause) => setError(String(cause)))
                      }
                    />
                  </label>
                  <label>
                    Cue seconds
                    <input
                      className="border-input bg-background w-full rounded border px-1 py-0.5"
                      type="number"
                      min={0.5}
                      max={10}
                      step={0.1}
                      value={candidate.captionStyle.maxCueSeconds}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          captionStyle: {
                            ...candidate.captionStyle,
                            maxCueSeconds: Number(event.target.value),
                          },
                        }).catch((cause) => setError(String(cause)))
                      }
                    />
                  </label>
                  <label>
                    Text color
                    <input
                      className="h-8 w-full"
                      type="color"
                      value={candidate.captionStyle.textColor}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          captionStyle: {
                            ...candidate.captionStyle,
                            textColor: event.target.value.toUpperCase(),
                          },
                        }).catch((cause) => setError(String(cause)))
                      }
                    />
                  </label>
                  <label>
                    Outline color
                    <input
                      className="h-8 w-full"
                      type="color"
                      value={candidate.captionStyle.outlineColor}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          captionStyle: {
                            ...candidate.captionStyle,
                            outlineColor: event.target.value.toUpperCase(),
                          },
                        }).catch((cause) => setError(String(cause)))
                      }
                    />
                  </label>
                  <label>
                    Outline width
                    <input
                      className="border-input bg-background w-full rounded border px-1 py-0.5"
                      type="number"
                      min={0}
                      max={6}
                      step={0.5}
                      value={candidate.captionStyle.outlineWidth}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          captionStyle: {
                            ...candidate.captionStyle,
                            outlineWidth: Number(event.target.value),
                          },
                        }).catch((cause) => setError(String(cause)))
                      }
                    />
                  </label>
                  <label>
                    Background opacity
                    <input
                      className="border-input bg-background w-full rounded border px-1 py-0.5"
                      type="number"
                      min={0}
                      max={1}
                      step={0.1}
                      value={candidate.captionStyle.backgroundOpacity}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          captionStyle: {
                            ...candidate.captionStyle,
                            backgroundOpacity: Number(event.target.value),
                          },
                        }).catch((cause) => setError(String(cause)))
                      }
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={candidate.captionStyle.bold}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          captionStyle: { ...candidate.captionStyle, bold: event.target.checked },
                        }).catch((cause) => setError(String(cause)))
                      }
                    />
                    Bold
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={candidate.captionStyle.uppercase}
                      onChange={(event) =>
                        void patchCandidate(candidate, {
                          captionStyle: {
                            ...candidate.captionStyle,
                            uppercase: event.target.checked,
                          },
                        }).catch((cause) => setError(String(cause)))
                      }
                    />
                    Uppercase
                  </label>
                </div>
              </details>
              <div className="flex items-center justify-between gap-2 text-xs">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={selected.has(candidate.id)}
                    disabled={!['PROPOSED', 'APPROVED', 'FAILED'].includes(candidate.status)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(candidate.id);
                        else next.delete(candidate.id);
                        return next;
                      })
                    }
                  />
                  Render
                </label>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    void patchCandidate(candidate, {
                      rejected: candidate.status !== 'REJECTED',
                    }).catch((cause) => setError(String(cause)))
                  }
                >
                  {candidate.status === 'REJECTED' ? 'Restore' : 'Reject'}
                </Button>
                <span className="text-muted-foreground">{candidate.status}</span>
              </div>
            </fieldset>
            {candidate.error && <p className="text-destructive text-xs">{candidate.error}</p>}
          </article>
        ))}
      </div>
      {selected.size > 0 && (
        <Button size="sm" onClick={() => void render()} disabled={busy || !canEdit}>
          Render {selected.size} selected
        </Button>
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </section>
  );
}
