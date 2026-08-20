'use client';

import { memo } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useObjectUrls } from '@/components/video-page/hooks/use-object-urls';
import type { CommentImage } from '@/components/video-page/types';

interface ImageAttachmentStripProps {
  /** Images already saved on the comment being edited, if any. */
  existingUrls?: string[];
  onRemoveExisting?: (url: string) => void;
  /** Files staged in this editor and not uploaded yet. */
  files: File[];
  onRemoveFile: (index: number) => void;
  compact?: boolean;
  className?: string;
}

/**
 * The row of thumbnails under an editor, showing what will be sent with it.
 * Saved images come first, then the ones staged in this session.
 */
export const ImageAttachmentStrip = memo(function ImageAttachmentStrip({
  existingUrls = [],
  onRemoveExisting,
  files,
  onRemoveFile,
  compact = false,
  className,
}: ImageAttachmentStripProps) {
  const previewUrls = useObjectUrls(files);

  if (existingUrls.length === 0 && previewUrls.length === 0) return null;

  const tileSize = compact ? 'h-14 w-14' : 'h-20 w-20';
  const buttonSize = compact ? 'h-5 w-5' : 'h-6 w-6';
  const iconSize = compact ? 'h-2.5 w-2.5' : 'h-3 w-3';

  const tile = (key: string, src: string, alt: string, onRemove: () => void) => (
    <div
      key={key}
      className={cn(
        'group/attachment relative shrink-0 overflow-hidden rounded-md border bg-muted',
        tileSize
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="h-full w-full object-cover" />
      <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover/attachment:opacity-100">
        <Button size="icon" variant="destructive" className={buttonSize} onClick={onRemove}>
          <Trash2 className={iconSize} />
        </Button>
      </div>
    </div>
  );

  return (
    <div className={cn('mb-2 flex flex-wrap gap-2', className)}>
      {existingUrls.map((url, index) =>
        tile(url, url, `Attachment ${index + 1}`, () => onRemoveExisting?.(url))
      )}
      {previewUrls.map((url, index) =>
        tile(`staged-${index}`, url, `Preview ${index + 1}`, () => onRemoveFile(index))
      )}
    </div>
  );
});

interface CommentImageGalleryProps {
  images: CommentImage[];
  onOpen: (url: string) => void;
  compact?: boolean;
  className?: string;
}

/** The images saved on a comment. One fills the width; several tile into a grid. */
export const CommentImageGallery = memo(function CommentImageGallery({
  images,
  onOpen,
  compact = false,
  className,
}: CommentImageGalleryProps) {
  if (images.length === 0) return null;

  if (images.length === 1) {
    return (
      <div
        className={cn(
          'flex cursor-pointer items-center justify-center overflow-hidden rounded-md bg-muted transition-opacity hover:opacity-90',
          compact ? 'max-h-40' : 'max-h-60',
          className
        )}
        onClick={() => onOpen(images[0].url)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={images[0].url}
          alt="Attachment"
          className={cn('w-auto object-contain', compact ? 'max-h-40' : 'max-h-60')}
        />
      </div>
    );
  }

  return (
    <div className={cn('grid grid-cols-2 gap-1.5', className)}>
      {images.map((image, index) => (
        <div
          key={image.id}
          className={cn(
            'cursor-pointer overflow-hidden rounded-md bg-muted transition-opacity hover:opacity-90',
            compact ? 'h-20' : 'h-24'
          )}
          onClick={() => onOpen(image.url)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.url}
            alt={`Attachment ${index + 1}`}
            className="h-full w-full object-cover"
          />
        </div>
      ))}
    </div>
  );
});
