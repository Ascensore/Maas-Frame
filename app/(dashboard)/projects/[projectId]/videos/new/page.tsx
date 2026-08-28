import { requireProjectAccessOrRedirect } from '@/lib/route-access';
import { isDirectFileUploadEnabled, isS3VideoUploadsEnabled } from '@/lib/feature-flags';
import NewVideoPageClient from './new-video-page-client';

interface NewVideoPageProps {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ folder?: string }>;
}

export default async function NewVideoPage({ params, searchParams }: NewVideoPageProps) {
  const { projectId } = await params;
  const { folder: folderId = null } = await searchParams;

  await requireProjectAccessOrRedirect({
    projectId,
    intent: 'manage',
  });

  return (
    <NewVideoPageClient
      projectId={projectId}
      folderId={folderId}
      directUploadsEnabled={isDirectFileUploadEnabled()}
      directUploadProvider={isS3VideoUploadsEnabled() ? 'r2' : 'bunny'}
    />
  );
}
