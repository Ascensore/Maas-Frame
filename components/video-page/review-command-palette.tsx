'use client';

import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  filterReviewCommands,
  REVIEW_COMMAND_CATALOG,
  type ReviewCommand,
} from '@/lib/review-commands';

interface ReviewCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: (commandId: string) => void;
}

export function ReviewCommandPalette({ open, onOpenChange, onRun }: ReviewCommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const matches = useMemo(() => filterReviewCommands(REVIEW_COMMAND_CATALOG, query), [query]);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setQuery('');
      setActiveIndex(0);
    }
    onOpenChange(next);
  };

  const groups = useMemo(() => {
    const byGroup = new Map<string, ReviewCommand[]>();
    for (const command of matches) {
      const list = byGroup.get(command.group) ?? [];
      list.push(command);
      byGroup.set(command.group, list);
    }
    return Array.from(byGroup.entries());
  }, [matches]);

  const run = (id: string) => {
    handleOpenChange(false);
    onRun(id);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-sm">Actions</DialogTitle>
        </DialogHeader>
        <div className="px-4 pb-3">
          <Input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Mark In, play, annotate…"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, Math.max(matches.length - 1, 0)));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const selected = matches[activeIndex];
                if (selected) run(selected.id);
              }
            }}
          />
        </div>
        <div className="max-h-[min(60vh,22rem)] overflow-y-auto border-t pb-2">
          {matches.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No matching actions.</p>
          ) : (
            groups.map(([group, commands]) => (
              <div key={group} className="pt-2">
                <p className="px-4 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {group}
                </p>
                {commands.map((command) => {
                  const index = matches.indexOf(command);
                  return (
                    <button
                      key={command.id}
                      type="button"
                      onClick={() => run(command.id)}
                      onMouseEnter={() => setActiveIndex(index)}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm',
                        index === activeIndex ? 'bg-accent' : 'hover:bg-muted/60'
                      )}
                    >
                      <span>{command.label}</span>
                      {command.shortcut && (
                        <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {command.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
