'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EDIT_SCRIPT_MAX_LENGTH } from '@/lib/rough-cut/script';

export function EditScriptCard({
  projectId,
  initialScript,
  onDirtyChange,
}: {
  projectId: string;
  initialScript: string | null;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const [text, setText] = useState(initialScript ?? '');
  const [saved, setSaved] = useState(initialScript ?? '');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const change = (value: string) => {
    setText(value);
    onDirtyChange(value.trim() !== saved.trim());
  };
  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editScript: text }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          typeof payload?.error === 'string' ? payload.error : 'Could not save script'
        );
      setSaved(text.trim());
      setText(text.trim());
      onDirtyChange(false);
      router.refresh();
      toast.success(text.trim() ? 'Script saved for this project' : 'Script removed');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save script');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Script &amp; editor guidelines</CardTitle>
        <CardDescription>
          Share the script with your project editors. It applies to every folder. New cuts use the
          saved script to prefer matching dialogue when choosing between repeated takes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="edit-script">Project script</Label>
        <Textarea
          id="edit-script"
          rows={8}
          value={text}
          disabled={saving}
          maxLength={EDIT_SCRIPT_MAX_LENGTH}
          onChange={(event) => change(event.target.value)}
          placeholder="Paste the script, then add notes about key lines to keep and sections to remove…"
        />
        <p className="text-xs text-muted-foreground">
          Guidelines are shared for editors to follow. Automatic matching compares dialogue in
          repeated takes; it does not interpret free-form instructions.
        </p>
        <input
          ref={input}
          type="file"
          aria-label="Import script file"
          className="hidden"
          accept=".txt,.md,text/plain,text/markdown"
          disabled={saving}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            if (file.size > EDIT_SCRIPT_MAX_LENGTH * 4) {
              toast.error('Script file is too large');
              return;
            }
            try {
              const value = await file.text();
              if (value.length > EDIT_SCRIPT_MAX_LENGTH) {
                toast.error('Script must be 50,000 characters or fewer');
                return;
              }
              change(value);
            } catch {
              toast.error('Could not read script file');
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void save()} disabled={saving || text.trim() === saved.trim()}>
            {saving ? 'Saving…' : 'Save script'}
          </Button>
          <Button variant="outline" disabled={saving} onClick={() => input.current?.click()}>
            Import TXT or Markdown
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  `${window.location.origin}/projects/${projectId}/edit#script`
                );
                toast.success('Edit link copied. Editors need project access.');
              } catch {
                toast.error('Could not copy the edit link');
              }
            }}
          >
            Copy edit link
          </Button>
          <span className="text-xs text-muted-foreground">
            {text.trim() !== saved.trim()
              ? 'Unsaved changes — save before starting a cut'
              : saved
                ? 'Saved · shared with project editors'
                : 'Optional'}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
