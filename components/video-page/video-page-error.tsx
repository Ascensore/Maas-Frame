'use client';

import { memo } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface VideoPageErrorProps {
  containerHeight: string;
  error: string;
  mode: 'dashboard' | 'watch';
  projectId?: string;
}

export const VideoPageError = memo(function VideoPageError({
  containerHeight,
  error,
  mode,
  projectId,
}: VideoPageErrorProps) {
  return (
    <div className={cn(containerHeight, 'dark flex items-center justify-center bg-[#0D0E11]')}>
      <div className="text-center">
        <p className="text-muted-foreground mb-4">{error || 'Video not found'}</p>
        <Button asChild variant="outline">
          <Link href={mode === 'dashboard' ? `/projects/${projectId}` : '/'}>
            {mode === 'dashboard' ? 'Back to Project' : 'Go Home'}
          </Link>
        </Button>
      </div>
    </div>
  );
});
