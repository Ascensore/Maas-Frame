'use client';

import { useMemo, useRef, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { VideoAsset } from '@/components/video-page/types';

type MentionRange = {
  start: number;
  end: number;
  query: string;
};

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  assets: VideoAsset[];
  placeholder?: string;
  rows?: number;
  className?: string;
  onPaste?: React.ClipboardEventHandler<HTMLTextAreaElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  autoFocus?: boolean;
  disabled?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

function findMentionRange(text: string, caret: number): MentionRange | null {
  const before = text.slice(0, caret);
  const atIndex = before.lastIndexOf('@');
  if (atIndex < 0) return null;

  const charBeforeAt = atIndex === 0 ? ' ' : before[atIndex - 1];
  if (charBeforeAt && !/\s/.test(charBeforeAt)) return null;

  const query = before.slice(atIndex + 1);
  if (query.length === 0) {
    return { start: atIndex, end: caret, query: '' };
  }

  if (/\s|\[|\]|\(|\)/.test(query)) return null;

  return { start: atIndex, end: caret, query };
}

export function MentionTextarea({
  value,
  onChange,
  assets,
  placeholder,
  rows = 2,
  className,
  onPaste,
  onKeyDown,
  autoFocus,
  disabled,
  textareaRef: textareaRefProp,
}: MentionTextareaProps) {
  const localTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = textareaRefProp ?? localTextareaRef;
  const [mentionRange, setMentionRange] = useState<MentionRange | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const searchableAssets = useMemo(() => {
    return assets
      .map((asset) => ({
        asset,
        displayNameLower: asset.displayName.toLowerCase(),
        createdAtMs: Date.parse(asset.createdAt),
      }))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  }, [assets]);

  const filteredAssets = useMemo(() => {
    if (!mentionRange) return [];
    const query = mentionRange.query.trim().toLowerCase();
    if (!query) return searchableAssets.slice(0, 8).map((entry) => entry.asset);
    return searchableAssets
      .filter((entry) => entry.displayNameLower.includes(query))
      .map((entry) => entry.asset)
      .slice(0, 8);
  }, [mentionRange, searchableAssets]);

  const closeMentions = () => {
    setMentionRange(null);
    setActiveIndex(0);
  };

  const insertAssetMention = (asset: VideoAsset) => {
    if (!mentionRange || !textareaRef.current) return;
    const mentionToken = `@[${asset.displayName}](asset:${asset.id}) `;
    const nextValue = `${value.slice(0, mentionRange.start)}${mentionToken}${value.slice(mentionRange.end)}`;
    onChange(nextValue);
    closeMentions();

    const nextCursor = mentionRange.start + mentionToken.length;
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    onChange(nextValue);

    const caret = event.target.selectionStart ?? nextValue.length;
    const range = findMentionRange(nextValue, caret);
    setMentionRange(range);
    setActiveIndex(0);
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (mentionRange) {
      if (filteredAssets.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActiveIndex((prev) => (prev + 1) % filteredAssets.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActiveIndex((prev) => (prev - 1 + filteredAssets.length) % filteredAssets.length);
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          const selected = filteredAssets[Math.min(activeIndex, filteredAssets.length - 1)];
          if (selected) insertAssetMention(selected);
          return;
        }
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closeMentions();
        return;
      }
    }

    onKeyDown?.(event);
  };

  return (
    <div className="relative">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        rows={rows}
        className={className}
        onPaste={onPaste}
        onKeyDown={handleKeyDown}
        autoFocus={autoFocus}
        disabled={disabled}
        onBlur={() => {
          window.setTimeout(closeMentions, 120);
        }}
      />

      {mentionRange && (
        <div className="absolute left-0 right-0 bottom-full mb-1 z-30 rounded-md border bg-popover shadow-md overflow-hidden">
          {filteredAssets.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No asset found</div>
          ) : (
            filteredAssets.map((asset, index) => (
              <button
                key={asset.id}
                type="button"
                className={cn(
                  'w-full text-left px-2 py-1.5 text-xs hover:bg-accent transition-colors',
                  index === activeIndex && 'bg-accent'
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertAssetMention(asset);
                }}
              >
                <span className="font-medium">@{asset.displayName}</span>
                <span className="ml-2 text-muted-foreground">{asset.provider}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
