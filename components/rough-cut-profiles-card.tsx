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

type Profile = {
  id: string;
  name: string;
  minShotSeconds: number;
  safetyPauseSeconds: number;
  maxShotSeconds: number | null;
  overlapBehaviour: 'WIDE' | 'HOLD' | 'SPEAKER';
  isDefault: boolean;
};

function readError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as { error?: unknown }).error;
  return typeof error === 'string' && error.trim() ? error : fallback;
}

export function RoughCutProfilesCard({ workspaceId }: { workspaceId: string }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [minShotSeconds, setMinShotSeconds] = useState('1.5');
  const [safetyPauseSeconds, setSafetyPauseSeconds] = useState('2');
  const [overlapBehaviour, setOverlapBehaviour] = useState<Profile['overlapBehaviour']>('WIDE');
  const [isDefault, setIsDefault] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/rough-cut-profiles`, {
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(readError(payload, 'Failed to load profiles'));
        return;
      }
      const list = (payload as { data?: { profiles?: Profile[] } }).data?.profiles;
      setProfiles(Array.isArray(list) ? list : []);
    } catch {
      setError('Failed to load profiles');
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || isSaving) return;
    setIsSaving(true);
    setError('');
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/rough-cut-profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          minShotSeconds: Number(minShotSeconds),
          safetyPauseSeconds: Number(safetyPauseSeconds),
          overlapBehaviour,
          isDefault,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(readError(payload, 'Failed to create profile'));
        return;
      }
      setName('');
      setIsDefault(false);
      await load();
    } catch {
      setError('Failed to create profile');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (profileId: string) => {
    setError('');
    const response = await fetch(`/api/workspaces/${workspaceId}/rough-cut-profiles/${profileId}`, {
      method: 'DELETE',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setError(readError(payload, 'Failed to delete profile'));
      return;
    }
    await load();
  };

  return (
    <Card className="mb-8">
      <CardHeader>
        <CardTitle>Rough cut profiles</CardTitle>
        <CardDescription>
          Shot length and overlap behaviour for multicam rough cuts. A folder without a profile
          inherits from its parent, then the workspace default.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No profiles yet. The built-in default is used.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {profiles.map((profile) => (
              <li key={profile.id} className="flex items-start justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {profile.name}
                    {profile.isDefault ? (
                      <span className="ml-2 text-xs text-muted-foreground">default</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Min {profile.minShotSeconds}s · pause {profile.safetyPauseSeconds}s · overlap{' '}
                    {profile.overlapBehaviour}
                    {profile.maxShotSeconds != null ? ` · max ${profile.maxShotSeconds}s` : ''}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${profile.name}`}
                  onClick={() => void handleDelete(profile.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleCreate} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="rough-cut-profile-name">New profile</Label>
            <Input
              id="rough-cut-profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Interview"
              maxLength={80}
              disabled={isSaving}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="rough-cut-min-shot">Min shot (s)</Label>
              <Input
                id="rough-cut-min-shot"
                type="number"
                min={0.1}
                step={0.1}
                value={minShotSeconds}
                onChange={(event) => setMinShotSeconds(event.target.value)}
                disabled={isSaving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rough-cut-pause">Safety pause (s)</Label>
              <Input
                id="rough-cut-pause"
                type="number"
                min={0}
                step={0.1}
                value={safetyPauseSeconds}
                onChange={(event) => setSafetyPauseSeconds(event.target.value)}
                disabled={isSaving}
              />
            </div>
            <div className="space-y-2">
              <Label>Overlap</Label>
              <Select
                value={overlapBehaviour}
                onValueChange={(value) => setOverlapBehaviour(value as Profile['overlapBehaviour'])}
                disabled={isSaving}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="WIDE">Cut to wide</SelectItem>
                  <SelectItem value="HOLD">Hold current shot</SelectItem>
                  <SelectItem value="SPEAKER">Stay on speaker</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
              disabled={isSaving}
            />
            Workspace default
          </label>
          {error ? (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          ) : null}
          <Button type="submit" disabled={isSaving || !name.trim()}>
            {isSaving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-2" />
            )}
            Add profile
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
