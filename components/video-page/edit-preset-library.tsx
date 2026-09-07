'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { EditLibraryView } from '@/lib/comment-edit/types';
import { GRAPHIC_PRESETS } from '@/lib/rough-cut/effects';
import { GraphicPresetPreview } from '@/components/video-page/graphic-preset-preview';
type Preset = EditLibraryView['presets'][number];
export function EditPresetLibrary({
  library,
  selected,
  onSelect,
}: {
  library: EditLibraryView;
  selected: string;
  onSelect: (preset?: Preset) => void;
}) {
  const [custom, setCustom] = useState<Preset[] | null>(null);
  const [archived, setArchived] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Preset>(GRAPHIC_PRESETS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const presets = [
    ...new Map([...library.presets, ...(custom ?? [])].map((p) => [p.id, p])).values(),
  ].filter((p) => !archived.includes(p.id));
  async function save(method: 'POST' | 'PATCH' | 'DELETE') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/workspaces/' + library.workspaceId + '/edit-presets', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          template: form.template ?? (form.id === 'callout' ? 'callout' : 'lower-third'),
          revision: form.version,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not save preset');
      const preset: Preset = payload.data.preset;
      if (method === 'DELETE') {
        setArchived((prev) => [...prev, preset.id]);
        onSelect();
      } else {
        setCustom((prev) => [...(prev ?? []).filter((p) => p.id !== preset.id), preset]);
        onSelect(preset);
      }
      setEditing(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save preset');
    } finally {
      setBusy(false);
    }
  }
  const builtIn = GRAPHIC_PRESETS.some((p) => p.id === form.id);
  const previewPreset = editing ? form : presets.find((p) => p.id === selected);
  return (
    <div className="space-y-2">
      <label className="block">
        Graphic preset
        <select
          className="mt-1 w-full rounded border bg-background p-1"
          value={selected}
          onChange={(e) => onSelect(presets.find((p) => p.id === e.target.value))}
        >
          <option value="">AI chooses a preset</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {previewPreset && <GraphicPresetPreview preset={previewPreset} />}
      {library.canManagePresets && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setForm(presets.find((p) => p.id === selected) ?? GRAPHIC_PRESETS[0]);
            setEditing(!editing);
          }}
        >
          Customize workspace presets
        </Button>
      )}
      {editing && (
        <div className="space-y-2 rounded border p-2">
          <label className="block">
            Preset name
            <input
              className="w-full rounded border bg-background p-1"
              value={form.name}
              maxLength={80}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="block">
            Layout
            <select
              value={form.template ?? (form.id === 'callout' ? 'callout' : 'lower-third')}
              onChange={(e) => setForm({ ...form, template: e.target.value as Preset['template'] })}
            >
              <option value="lower-third">Lower third</option>
              <option value="callout">Callout</option>
              <option value="title-card">Title card</option>
            </select>
          </label>
          {(['accent', 'foreground', 'background'] as const).map((key) => (
            <label className="flex items-center gap-2" key={key}>
              {key}
              <input
                aria-label={'Preset ' + key}
                type="color"
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            </label>
          ))}
          <label className="block">
            Font
            <select
              value={form.font ?? 'DejaVu Sans'}
              onChange={(e) => setForm({ ...form, font: e.target.value as Preset['font'] })}
            >
              {['DejaVu Sans', 'Liberation Sans', 'Roboto', 'Open Sans'].map((font) => (
                <option key={font}>{font}</option>
              ))}
            </select>
          </label>
          <label className="block">
            Title size
            <input
              type="number"
              min={20}
              max={72}
              value={form.titleSize ?? 48}
              onChange={(e) => setForm({ ...form, titleSize: Number(e.target.value) })}
            />
          </label>
          <label className="block">
            Subtitle size
            <input
              type="number"
              min={14}
              max={40}
              value={form.subtitleSize ?? 32}
              onChange={(e) => setForm({ ...form, subtitleSize: Number(e.target.value) })}
            />
          </label>
          <p>Saved for this workspace. Queued feedback keeps its original preset revision.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => save('POST')}>
              Save as new preset
            </Button>
            {!builtIn && (
              <>
                <Button size="sm" disabled={busy} onClick={() => save('PATCH')}>
                  Update preset
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => save('DELETE')}>
                  Archive preset
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
