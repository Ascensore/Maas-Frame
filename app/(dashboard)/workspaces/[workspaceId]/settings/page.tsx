import { requireWorkspaceAccessOrRedirect } from '@/lib/route-access';
import { isRoughCutFeatureEnabled } from '@/lib/feature-flags';
import WorkspaceSettingsPageClient from './workspace-settings-page-client';

interface WorkspaceSettingsPageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function WorkspaceSettingsPage({ params }: WorkspaceSettingsPageProps) {
  const { workspaceId } = await params;

  const { access } = await requireWorkspaceAccessOrRedirect({
    workspaceId,
    intent: 'manage',
  });

  return (
    <WorkspaceSettingsPageClient
      workspaceId={workspaceId}
      canDelete={access.canDelete}
      roughCutEnabled={isRoughCutFeatureEnabled()}
    />
  );
}
