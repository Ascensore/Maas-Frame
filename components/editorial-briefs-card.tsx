'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  BUILTIN_BRIEF_TEMPLATES,
  EDITORIAL_PROJECT_TYPES,
  SILENCE_AGGRESSIVENESS_LEVELS,
  type EditorialBrief,
  type EditorialProjectType,
  type SilenceAggressiveness,
} from '@/lib/rough-cut/brief';

type Brief = {
  id: string;
  name: string;
  projectType: EditorialProjectType;
  isDefault: boolean;
  config: EditorialBrief;
};

export const PROJECT_TYPE_LABELS: Record<EditorialProjectType, string> = {
  ASCENSORE: 'Ascensore show',
  TALKING_HEAD: 'Talking head',
  INTERVIEW: 'Interview / multi-person',
};

const SILENCE_LABELS: Record<SilenceAggressiveness, string> = {
  low: 'Low — keep most pauses',
  medium: 'Medium',
  high: 'High — cut dead air hard',
};

function readError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as { error?: unknown }).error;
  return typeof error === 'string' && error.trim() ? error : fallback;
}

function summarize(config: EditorialBrief): string {
  const parts = [
    `silence ${config.pacing.silenceAggressiveness}`,
    config.takeSelection.enabled ? 'picks takes' : 'one take',
    config.cameraGrammar.followSpeaker ? 'follows speaker' : 'holds A-cam',
  ];
  if (config.cameraGrammar.holdWideOnChaos) parts.push('wide on chaos');
  if (config.markers.infographicOnJargon) parts.push('infographic markers');
  if (config.markers.brollOnIllustration) parts.push('B-roll markers');
  return parts.join(' · ');
}

export function EditorialBriefsCard({ workspaceId }: { workspaceId: string }) {
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [projectType, setProjectType] = useState<EditorialProjectType>('TALKING_HEAD');
  const [silence, setSilence] = useState<SilenceAggressiveness>(
    BUILTIN_BRIEF_TEMPLATES.TALKING_HEAD.pacing.silenceAggressiveness
  );
  const [takeSelection, setTakeSelection] = useState(
    BUILTIN_BRIEF_TEMPLATES.TALKING_HEAD.takeSelection.enabled
  );
  const [followSpeaker, setFollowSpeaker] = useState(
    BUILTIN_BRIEF_TEMPLATES.TALKING_HEAD.cameraGrammar.followSpeaker
  );
  const [holdWideOnChaos, setHoldWideOnChaos] = useState(
    BUILTIN_BRIEF_TEMPLATES.TALKING_HEAD.cameraGrammar.holdWideOnChaos
  );
  const [isDefault, setIsDefault] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/editorial-briefs`, {
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(readError(payload, 'Failed to load briefs'));
        return;
      }
      const list = (payload as { data?: { briefs?: Brief[] } }).data?.briefs;
      setBriefs(Array.isArray(list) ? list : []);
    } catch {
      setError('Failed to load briefs');
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Picking a type resets the toggles to that template so the form shows
  // what the brief will start from.
  const chooseProjectType = (next: EditorialProjectType) => {
    const template = BUILTIN_BRIEF_TEMPLATES[next];
    setProjectType(next);
    setSilence(template.pacing.silenceAggressiveness);
    setTakeSelection(template.takeSelection.enabled);
    setFollowSpeaker(template.cameraGrammar.followSpeaker);
    setHoldWideOnChaos(template.cameraGrammar.holdWideOnChaos);
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || isSaving) return;
    setIsSaving(true);
    setError('');
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/editorial-briefs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          projectType,
          isDefault,
          config: {
            pacing: { silenceAggressiveness: silence },
            takeSelection: {
              enabled: takeSelection,
              groupBy: takeSelection ? 'semantic_beat' : 'none',
            },
            cameraGrammar: { followSpeaker, holdWideOnChaos },
          },
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(readError(payload, 'Failed to create brief'));
        return;
      }
      setName('');
      setIsDefault(false);
      await load();
    } catch {
      setError('Failed to create brief');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (briefId: string) => {
    setError('');
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/editorial-briefs/${briefId}`, {
        method: 'DELETE',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(readError(payload, 'Failed to delete brief'));
        return;
      }
      await load();
    } catch {
      setError('Failed to delete brief');
    }
  };

  const handleMakeDefault = async (briefId: string) => {
    setError('');
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/editorial-briefs/${briefId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(readError(payload, 'Failed to update brief'));
        return;
      }
      await load();
    } catch {
      setError('Failed to update brief');
    }
  };

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Editorial briefs</CardTitle>
        <CardDescription>
          What a good rough cut means for each kind of project. Bind a brief to a folder or a
          project, or mark one as the default for its type; the technical rough-cut profile still
          applies underneath.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading briefs…
          </div>
        ) : briefs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No briefs yet. Rough cuts use the built-in template for their project type.
          </p>
        ) : (
          <ul className="space-y-2">
            {briefs.map((brief) => (
              <li
                key={brief.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {brief.name}
                    {brief.isDefault ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        default for {PROJECT_TYPE_LABELS[brief.projectType].toLowerCase()}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {PROJECT_TYPE_LABELS[brief.projectType]} · {summarize(brief.config)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {!brief.isDefault ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleMakeDefault(brief.id)}
                    >
                      Make default
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete ${brief.name}`}
                    onClick={() => void handleDelete(brief.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleCreate} className="space-y-4 border-t pt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="brief-name">Name</Label>
              <Input
                id="brief-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Pitch night"
                maxLength={80}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="brief-type">Project type</Label>
              <Select
                value={projectType}
                onValueChange={(value) => chooseProjectType(value as EditorialProjectType)}
              >
                <SelectTrigger id="brief-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EDITORIAL_PROJECT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {PROJECT_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="brief-silence">Silence</Label>
              <Select
                value={silence}
                onValueChange={(value) => setSilence(value as SilenceAggressiveness)}
              >
                <SelectTrigger id="brief-silence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SILENCE_AGGRESSIVENESS_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {SILENCE_LABELS[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={takeSelection}
                  onChange={(event) => setTakeSelection(event.target.checked)}
                />
                Pick the best take when a beat was recorded more than once
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={followSpeaker}
                  onChange={(event) => setFollowSpeaker(event.target.checked)}
                />
                Follow the speaker across cameras
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={holdWideOnChaos}
                  onChange={(event) => setHoldWideOnChaos(event.target.checked)}
                />
                Hold the wide shot when several people talk at once
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(event) => setIsDefault(event.target.checked)}
                />
                Default for this project type
              </label>
            </div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" disabled={isSaving || !name.trim()}>
            {isSaving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-2" />
            )}
            Add brief
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
