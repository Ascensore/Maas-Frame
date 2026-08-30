'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { parseVideoMetadata } from '@/lib/video-metadata';
import { apiRequestError } from '@/lib/client/api-error';

type Props = {
  projectId: string;
  videoId: string;
  metadata: Record<string, string>;
  canEdit: boolean;
  onSaved: (next: Record<string, string>) => void;
};

function rowsFrom(metadata: Record<string, string>): Array<{ key: string; value: string }> {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return [{ key: '', value: '' }];
  return entries.map(([key, value]) => ({ key, value }));
}

export function VideoMetadataFields({ projectId, videoId, metadata, canEdit, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>([]);
  const [saving, setSaving] = useState(false);
  const entries = Object.entries(metadata);

  const openEditor = () => {
    setRows(rowsFrom(metadata));
    setOpen(true);
  };

  const save = async () => {
    const draft: Record<string, string> = {};
    for (const row of rows) {
      if (!row.key.trim() && !row.value.trim()) continue;
      draft[row.key] = row.value;
    }
    const parsed = parseVideoMetadata(draft);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/videos/${videoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: parsed.value }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw apiRequestError(payload, 'Failed to save fields');
      }
      onSaved(parsed.value);
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save fields');
    } finally {
      setSaving(false);
    }
  };

  if (entries.length === 0 && !canEdit) return null;

  return (
    <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 border-b bg-background/50 min-h-8">
      <div className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
        {entries.length === 0 ? (
          <span className="text-xs text-muted-foreground">No custom fields</span>
        ) : (
          entries.map(([key, value]) => (
            <Badge key={key} variant="secondary" className="font-normal">
              <span className="text-muted-foreground mr-1">{key}</span>
              {value || '—'}
            </Badge>
          ))
        )}
      </div>
      {canEdit && (
        <>
          <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0" onClick={openEditor}>
            Edit fields
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Custom fields</DialogTitle>
              </DialogHeader>
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {rows.map((row, index) => (
                  <div key={index} className="flex gap-2">
                    <Input
                      placeholder="Field"
                      value={row.key}
                      onChange={(event) => {
                        const next = [...rows];
                        next[index] = { ...row, key: event.target.value };
                        setRows(next);
                      }}
                    />
                    <Input
                      placeholder="Value"
                      value={row.value}
                      onChange={(event) => {
                        const next = [...rows];
                        next[index] = { ...row, value: event.target.value };
                        setRows(next);
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={() => setRows(rows.filter((_, i) => i !== index))}
                      aria-label="Remove field"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {rows.length < 20 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRows([...rows, { key: '', value: '' }])}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add field
                  </Button>
                )}
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
                  Cancel
                </Button>
                <Button onClick={() => void save()} disabled={saving}>
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
