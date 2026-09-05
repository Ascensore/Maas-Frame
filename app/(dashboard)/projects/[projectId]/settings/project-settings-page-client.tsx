'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Loader2,
  Globe,
  Lock,
  UserPlus,
  Trash2,
  AlertTriangle,
  Settings,
  Save,
  Tag,
  Plus,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { folderPath } from '@/lib/folders';
import { PROJECT_GUIDELINES_MAX, type EditorialProjectType } from '@/lib/rough-cut/brief';
import { PROJECT_TYPE_LABELS } from '@/components/editorial-briefs-card';

type Visibility = 'PRIVATE' | 'INVITE' | 'PUBLIC';

const visibilityOptions: {
  value: Visibility;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    value: 'PRIVATE',
    label: 'Private',
    description: 'Only you can access this project',
    icon: <Lock className="h-5 w-5" />,
  },
  {
    value: 'INVITE',
    label: 'Invite Only',
    description: 'Share with specific people via email',
    icon: <UserPlus className="h-5 w-5" />,
  },
  {
    value: 'PUBLIC',
    label: 'Public',
    description: 'Anyone with the link can view',
    icon: <Globe className="h-5 w-5" />,
  },
];

interface ProjectSettingsPageProps {
  projectId: string;
}

interface CommentTag {
  id: string;
  name: string;
  color: string;
  position: number;
}

interface WorkspaceBrief {
  id: string;
  name: string;
  projectType: EditorialProjectType;
  isDefault: boolean;
}

export default function ProjectSettingsPageClient({ projectId }: ProjectSettingsPageProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    visibility: 'PRIVATE' as Visibility,
    allowDownloads: false,
    watermarkReviews: false,
    editorialBriefId: null as string | null,
    editorialGuidelines: '',
  });
  const [workspaceBriefs, setWorkspaceBriefs] = useState<WorkspaceBrief[]>([]);

  // Tag management state
  const [tags, setTags] = useState<CommentTag[]>([]);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#3B82F6');
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState('');
  const [editTagColor, setEditTagColor] = useState('');
  const [c2cConnections, setC2cConnections] = useState<
    Array<{ id: string; name: string; tokenPrefix: string; folderId: string | null }>
  >([]);
  const [c2cFolders, setC2cFolders] = useState<
    Array<{ id: string; name: string; parentId: string | null }>
  >([]);
  const [newConnectionName, setNewConnectionName] = useState('');
  const [newConnectionFolderId, setNewConnectionFolderId] = useState('root');
  const [createdConnectionSecret, setCreatedConnectionSecret] = useState('');
  const [connectionBusy, setConnectionBusy] = useState(false);

  useEffect(() => {
    // Fetch project data
    fetch(`/api/projects/${projectId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          const project = data.data;
          setFormData({
            name: project.name || '',
            description: project.description || '',
            visibility: project.visibility || 'PRIVATE',
            allowDownloads: project.allowDownloads ?? false,
            watermarkReviews: project.watermarkReviews ?? false,
            editorialBriefId: project.editorialBriefId ?? null,
            editorialGuidelines: project.editorialGuidelines ?? '',
          });
          // The brief list is optional: without it the section simply stays hidden.
          if (typeof project.workspaceId === 'string') {
            fetch(`/api/workspaces/${project.workspaceId}/editorial-briefs`)
              .then((res) => res.json())
              .then((payload) => {
                const list = payload?.data?.briefs;
                if (Array.isArray(list)) setWorkspaceBriefs(list);
              })
              .catch(() => undefined);
          }
        }
      })
      .catch(() => setError('Failed to load project'))
      .finally(() => setIsLoading(false));

    // Fetch tags
    fetch(`/api/projects/${projectId}/tags`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.data)) {
          setTags(data.data);
        }
      })
      .catch(() => {
        /* Silent fail - tags are optional */
      });

    fetch(`/api/projects/${projectId}/c2c-connections`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.data?.connections)) {
          setC2cConnections(data.data.connections);
        }
      })
      .catch(() => {
        /* Silent fail - ingest connections are optional */
      });

    fetch(`/api/projects/${projectId}/folders`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.data?.folders)) {
          setC2cFolders(data.data.folders);
        }
      })
      .catch(() => {
        /* Silent fail - folders are optional for ingest tokens */
      });
  }, [projectId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError('');
    setSuccess('');

    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to update project');
        return;
      }

      setSuccess('Project settings saved successfully');
      setTimeout(() => setSuccess(''), 3000);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateConnection = async () => {
    if (!newConnectionName.trim()) return;
    setConnectionBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/c2c-connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newConnectionName.trim(),
          ...(newConnectionFolderId !== 'root' ? { folderId: newConnectionFolderId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create ingest connection');
        return;
      }
      setCreatedConnectionSecret(data.data.connection.secret);
      setC2cConnections((current) => [
        {
          id: data.data.connection.id,
          name: data.data.connection.name,
          tokenPrefix: data.data.connection.tokenPrefix,
          folderId: data.data.connection.folderId ?? null,
        },
        ...current,
      ]);
      setNewConnectionName('');
    } catch {
      setError('Failed to create ingest connection');
    } finally {
      setConnectionBusy(false);
    }
  };

  const handleRevokeConnection = async (connectionId: string) => {
    setConnectionBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/c2c-connections/${connectionId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setC2cConnections((current) => current.filter((row) => row.id !== connectionId));
      }
    } finally {
      setConnectionBusy(false);
    }
  };

  const handleAddTag = async () => {
    if (!newTagName.trim()) return;
    setIsAddingTag(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTagName.trim(), color: newTagColor }),
      });
      if (res.ok) {
        const data = await res.json();
        const newTag = data.data;
        setTags([...tags, newTag]);
        setNewTagName('');
        setNewTagColor('#3B82F6');
      }
    } catch {
      // Silent fail
    } finally {
      setIsAddingTag(false);
    }
  };

  const handleUpdateTag = async (tagId: string) => {
    if (!editTagName.trim()) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/tags/${tagId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editTagName.trim(), color: editTagColor }),
      });
      if (res.ok) {
        const data = await res.json();
        const updated = data.data;
        setTags(tags.map((t) => (t.id === tagId ? updated : t)));
        setEditingTagId(null);
      }
    } catch {
      // Silent fail
    }
  };

  const handleDeleteTag = async (tagId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/tags/${tagId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setTags(tags.filter((t) => t.id !== tagId));
      }
    } catch {
      // Silent fail
    }
  };

  const handleDelete = async () => {
    if (deleteConfirmation !== formData.name) {
      setError('Project name does not match');
      return;
    }

    setIsDeleting(true);
    setError('');

    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || 'Failed to delete project');
        return;
      }

      router.push('/dashboard');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-start justify-center py-12 px-4">
      <div className="w-full max-w-xl">
        <div className="mb-8">
          <Link
            href={`/projects/${projectId}`}
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Project
          </Link>
        </div>

        <div className="space-y-6">
          {/* General Settings */}
          <Card className="border-border/50 shadow-lg">
            <CardHeader className="text-center pb-2">
              <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <Settings className="h-7 w-7 text-primary" />
              </div>
              <CardTitle className="text-2xl">Project Settings</CardTitle>
              <CardDescription className="text-base">
                Update your project details and access settings
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <form onSubmit={handleSave} className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-sm font-medium">
                    Project Name
                  </Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                    required
                    disabled={isSaving}
                    className="h-11"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description" className="text-sm font-medium">
                    Description
                  </Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, description: e.target.value }))
                    }
                    rows={3}
                    disabled={isSaving}
                    className="resize-none"
                  />
                </div>

                <div className="space-y-3">
                  <Label className="text-sm font-medium">Who can access?</Label>
                  <div className="grid gap-3">
                    {visibilityOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() =>
                          setFormData((prev) => ({ ...prev, visibility: option.value }))
                        }
                        disabled={isSaving}
                        className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                          formData.visibility === option.value
                            ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                            : 'border-border hover:border-border/80 hover:bg-accent/50'
                        }`}
                      >
                        <div
                          className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${
                            formData.visibility === option.value
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {option.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium">{option.label}</div>
                          <div className="text-sm text-muted-foreground">{option.description}</div>
                        </div>
                        <div
                          className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                            formData.visibility === option.value
                              ? 'border-primary bg-primary'
                              : 'border-muted-foreground/30'
                          }`}
                        >
                          {formData.visibility === option.value && (
                            <div className="w-2 h-2 rounded-full bg-primary-foreground" />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {workspaceBriefs.length > 0 || formData.editorialBriefId ? (
                  <div className="space-y-3 rounded-xl border p-4">
                    <div>
                      <Label htmlFor="project-brief" className="text-sm font-medium">
                        Editorial brief
                      </Label>
                      <p className="text-sm text-muted-foreground mt-1">
                        The brief rough cuts follow for this project. A folder can bind its own
                        brief, which wins over this one; without either, the workspace default for
                        the project type applies.
                      </p>
                    </div>
                    <Select
                      value={formData.editorialBriefId ?? 'inherit'}
                      onValueChange={(value) =>
                        setFormData((prev) => ({
                          ...prev,
                          editorialBriefId: value === 'inherit' ? null : value,
                        }))
                      }
                      disabled={isSaving}
                    >
                      <SelectTrigger id="project-brief" className="w-full max-w-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">
                          Workspace default for the project type
                        </SelectItem>
                        {workspaceBriefs.map((brief) => (
                          <SelectItem key={brief.id} value={brief.id}>
                            {brief.name} · {PROJECT_TYPE_LABELS[brief.projectType]}
                            {brief.isDefault ? ' (default)' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}

                <div className="space-y-3 rounded-xl border p-4">
                  <div>
                    <Label htmlFor="project-guidelines" className="text-sm font-medium">
                      Editorial guidelines
                    </Label>
                    <p className="text-sm text-muted-foreground mt-1">
                      Free text for this project&apos;s rough cuts: what to keep, what to drop, the
                      tone, anything the brief does not say. Every rough cut records the text it was
                      made with.
                    </p>
                  </div>
                  <Textarea
                    id="project-guidelines"
                    value={formData.editorialGuidelines}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, editorialGuidelines: e.target.value }))
                    }
                    rows={5}
                    maxLength={PROJECT_GUIDELINES_MAX}
                    placeholder="Keep the founder's origin story in full. Drop any mention of the old pricing. Short, punchy pacing."
                    disabled={isSaving}
                  />
                </div>

                <div className="space-y-3 rounded-xl border p-4">
                  <div>
                    <Label className="text-sm font-medium">Project downloads</Label>
                    <p className="text-sm text-muted-foreground mt-1">
                      Allow viewers to download project files. Project admins can always download.
                      When enabled on a public project, anyone with the link can download files
                      without signing in.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setFormData((prev) => ({ ...prev, allowDownloads: !prev.allowDownloads }))
                    }
                    disabled={isSaving}
                    className={`w-full flex items-center justify-between gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                      formData.allowDownloads
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                        : 'border-border hover:border-border/80 hover:bg-accent/50'
                    }`}
                  >
                    <div>
                      <div className="font-medium">Allow viewer downloads</div>
                      <div className="text-sm text-muted-foreground">
                        Public and invited viewers can download files when enabled. On public
                        projects this includes unauthenticated visitors.
                      </div>
                    </div>
                    <div
                      className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                        formData.allowDownloads
                          ? 'border-primary bg-primary'
                          : 'border-muted-foreground/30'
                      }`}
                    >
                      {formData.allowDownloads && (
                        <div className="w-2 h-2 rounded-full bg-primary-foreground" />
                      )}
                    </div>
                  </button>
                </div>

                <div className="space-y-3 rounded-xl border p-4">
                  <div>
                    <Label className="text-sm font-medium">Review watermark</Label>
                    <p className="text-sm text-muted-foreground mt-1">
                      Overlay each viewer&apos;s name or email on the review player. Review proxies
                      also get a burned-in CONFIDENTIAL mark so a downloaded proxy still shows it.
                      This is not a forensic watermark.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setFormData((prev) => ({
                        ...prev,
                        watermarkReviews: !prev.watermarkReviews,
                      }))
                    }
                    disabled={isSaving}
                    className={`w-full flex items-center justify-between gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                      formData.watermarkReviews
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                        : 'border-border hover:border-border/80 hover:bg-accent/50'
                    }`}
                  >
                    <div>
                      <div className="font-medium">Show a viewer watermark</div>
                      <div className="text-sm text-muted-foreground">
                        Repeats the viewer&apos;s identity over video, stills, and PDFs in this
                        project.
                      </div>
                    </div>
                    <div
                      className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                        formData.watermarkReviews
                          ? 'border-primary bg-primary'
                          : 'border-muted-foreground/30'
                      }`}
                    >
                      {formData.watermarkReviews && (
                        <div className="w-2 h-2 rounded-full bg-primary-foreground" />
                      )}
                    </div>
                  </button>
                </div>

                <div className="space-y-3 rounded-xl border p-4">
                  <div>
                    <Label className="text-sm font-medium">Camera ingest</Label>
                    <p className="text-sm text-muted-foreground mt-1">
                      Project-scoped tokens for field uploaders and watch-folder scripts. This is
                      not a vendor Camera-to-Cloud protocol. Pick the Edit bin folder so CLI watch
                      lands with the rest of the session.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_minmax(12rem,16rem)_auto] sm:items-end">
                    <div className="grid gap-2">
                      <Label htmlFor="c2c-name">Connection name</Label>
                      <Input
                        id="c2c-name"
                        value={newConnectionName}
                        onChange={(event) => setNewConnectionName(event.target.value)}
                        placeholder="Connection name"
                        disabled={isSaving || connectionBusy}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="c2c-folder">Destination folder</Label>
                      <Select
                        value={newConnectionFolderId}
                        onValueChange={setNewConnectionFolderId}
                        disabled={isSaving || connectionBusy}
                      >
                        <SelectTrigger id="c2c-folder" className="w-full">
                          <SelectValue placeholder="Project root" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="root">Project root</SelectItem>
                          {c2cFolders.map((folder) => (
                            <SelectItem key={folder.id} value={folder.id}>
                              {folderPath(folder.id, c2cFolders)
                                .map((entry) => entry.name)
                                .join(' / ')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      type="button"
                      disabled={isSaving || connectionBusy || !newConnectionName.trim()}
                      onClick={handleCreateConnection}
                    >
                      Create
                    </Button>
                  </div>
                  {createdConnectionSecret && (
                    <div className="rounded-md border bg-muted/40 p-3 text-sm break-all">
                      <p className="font-medium mb-1">Copy this now. It will not be shown again.</p>
                      <code>{createdConnectionSecret}</code>
                      <p className="text-muted-foreground mt-2">
                        <span className="font-mono">
                          bun run c2c:ingest -- --base-url … --token this-value --file clip.mov
                        </span>
                      </p>
                    </div>
                  )}
                  <ul className="space-y-2">
                    {c2cConnections.map((connection) => (
                      <li
                        key={connection.id}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span>
                          {connection.name}{' '}
                          <span className="text-muted-foreground">{connection.tokenPrefix}…</span>
                          <span className="text-muted-foreground">
                            {' '}
                            ·{' '}
                            {connection.folderId
                              ? (c2cFolders.find((folder) => folder.id === connection.folderId)
                                  ?.name ?? 'Folder')
                              : 'Project root'}
                          </span>
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={isSaving || connectionBusy}
                          onClick={() => handleRevokeConnection(connection.id)}
                        >
                          Revoke
                        </Button>
                      </li>
                    ))}
                    {c2cConnections.length === 0 && (
                      <li className="text-sm text-muted-foreground">
                        No active ingest connections.
                      </li>
                    )}
                  </ul>
                </div>

                {error && (
                  <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                    {error}
                  </div>
                )}

                {success && (
                  <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/20 text-green-500 text-sm flex items-center gap-2">
                    <Save className="h-4 w-4" />
                    {success}
                  </div>
                )}

                <Button type="submit" disabled={isSaving || !formData.name.trim()} className="h-11">
                  {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Save Changes
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Comment Tags */}
          <Card id="comment-tags" className="border-border/50 shadow-lg">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Tag className="h-5 w-5" />
                Comment Tags
              </CardTitle>
              <CardDescription>Customize tags for categorizing comments on videos</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Existing tags */}
              <div className="space-y-2">
                {tags.map((tag) => (
                  <div
                    key={tag.id}
                    className="flex flex-wrap items-center gap-2 p-2 rounded-lg border bg-card"
                  >
                    {editingTagId === tag.id ? (
                      <>
                        <input
                          type="color"
                          value={editTagColor}
                          aria-label={`Tag colour for ${tag.name}`}
                          onChange={(e) => setEditTagColor(e.target.value)}
                          className="w-8 h-8 rounded cursor-pointer border-0"
                        />
                        <Input
                          value={editTagName}
                          aria-label={`Tag name for ${tag.name}`}
                          onChange={(e) => setEditTagName(e.target.value)}
                          className="flex-1 h-8"
                          onKeyDown={(e) => e.key === 'Enter' && handleUpdateTag(tag.id)}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Save tag ${tag.name}`}
                          onClick={() => handleUpdateTag(tag.id)}
                        >
                          <Save className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Cancel editing tag ${tag.name}`}
                          onClick={() => setEditingTagId(null)}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <div
                          className="w-6 h-6 rounded-full shrink-0"
                          style={{ backgroundColor: tag.color }}
                        />
                        <span className="flex-1 text-sm font-medium">{tag.name}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingTagId(tag.id);
                            setEditTagName(tag.name);
                            setEditTagColor(tag.color);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          aria-label={`Delete tag ${tag.name}`}
                          onClick={() => handleDeleteTag(tag.id)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </div>

              {/* Add new tag */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
                <input
                  type="color"
                  value={newTagColor}
                  onChange={(e) => setNewTagColor(e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer border-0"
                />
                <Input
                  placeholder="New tag name..."
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  className="flex-1 h-8"
                  onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                />
                <Button
                  size="sm"
                  onClick={handleAddTag}
                  disabled={!newTagName.trim() || isAddingTag}
                >
                  {isAddingTag ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Danger Zone */}
          <Card className="border-destructive/30 shadow-lg">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Danger Zone
              </CardTitle>
              <CardDescription>
                Irreversible actions that will permanently affect your project
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between p-4 rounded-xl border border-destructive/20 bg-destructive/5">
                <div>
                  <h4 className="font-medium">Delete this project</h4>
                  <p className="text-sm text-muted-foreground">This action cannot be undone</p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm">
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete &quot;{formData.name}&quot;?</AlertDialogTitle>
                      <AlertDialogDescription asChild>
                        <div className="space-y-4">
                          <p>
                            This will permanently delete this project and all of its videos,
                            versions, and comments. This action cannot be undone.
                          </p>
                          <div className="space-y-2">
                            <Label htmlFor="delete-confirm">
                              Type <strong className="text-foreground">{formData.name}</strong> to
                              confirm
                            </Label>
                            <Input
                              id="delete-confirm"
                              value={deleteConfirmation}
                              onChange={(e) => setDeleteConfirmation(e.target.value)}
                              placeholder="Project name"
                              className="h-11"
                            />
                          </div>
                        </div>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel onClick={() => setDeleteConfirmation('')}>
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDelete}
                        disabled={deleteConfirmation !== formData.name || isDeleting}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        {isDeleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        Delete Project
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
