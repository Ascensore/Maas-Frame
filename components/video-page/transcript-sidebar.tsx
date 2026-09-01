'use client';

import type { ReactNode } from 'react';
import { Captions, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface TranscriptSidebarProps {
  open: boolean;
  onClose: () => void;
  isFullscreen: boolean;
  children: ReactNode;
}

export function TranscriptSidebar({
  open,
  onClose,
  isFullscreen,
  children,
}: TranscriptSidebarProps) {
  if (isFullscreen) return null;

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden transition-opacity duration-300',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
        onClick={onClose}
      />
      <aside
        className={cn(
          'bg-card flex flex-col overflow-hidden z-50',
          'fixed inset-y-0 left-0 w-[85%] sm:w-[400px] shadow-2xl transition-transform duration-300',
          open ? 'translate-x-0' : '-translate-x-full',
          'lg:static lg:w-[360px] lg:shrink-0 lg:border-r lg:border-white/10 lg:shadow-none lg:z-auto lg:transition-none',
          !open && 'lg:hidden'
        )}
      >
        <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b">
          <div className="flex items-center gap-2 min-w-0">
            <Captions className="h-4 w-4 shrink-0" />
            <h2 className="text-sm font-medium truncate">Transcript</h2>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
            <span className="sr-only">Close transcript</span>
          </Button>
        </div>
        <div className="flex-1 min-h-0 p-4">{children}</div>
      </aside>
    </>
  );
}
