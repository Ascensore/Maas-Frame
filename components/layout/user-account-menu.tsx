'use client';

import { useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { Keyboard, LayoutDashboard, LogOut, Settings } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { firstNameFromDisplayName } from '@/lib/display-name';

export interface AppNavUser {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  isAdmin?: boolean;
}

const KeyboardShortcutsModal = dynamic(
  () => import('@/components/keyboard-shortcuts-modal').then((mod) => mod.KeyboardShortcutsModal),
  { ssr: false }
);

export function UserAccountMenu({ user }: { user: AppNavUser }) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const firstName = firstNameFromDisplayName(user.name) ?? 'Account';

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            className="flex w-full items-center gap-2.5 rounded-[10px] py-1 text-left hover:bg-accent"
          >
            <Avatar className="h-[26px] w-[26px]">
              <AvatarImage src={user.image ?? undefined} alt={firstName} />
              <AvatarFallback className="text-[10px]">
                {firstName.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 truncate text-xs font-semibold text-foreground">
              {firstName}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={8}
          className="w-64 min-w-64 rounded-xl border bg-popover/98 p-1 shadow-2xl backdrop-blur-md"
        >
          <div className="rounded-lg px-3 py-2.5">
            <div className="flex flex-col space-y-1 leading-none">
              {user.name && <p className="font-medium">{user.name}</p>}
              {user.email && <p className="truncate text-sm text-muted-foreground">{user.email}</p>}
            </div>
          </div>
          <DropdownMenuSeparator />
          {user.isAdmin && (
            <DropdownMenuItem asChild>
              <Link href="/admin">
                <LayoutDashboard className="h-4 w-4 mr-2" />
                Admin Panel
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <Settings className="h-4 w-4 mr-2" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setShortcutsOpen(true)}>
            <Keyboard className="h-4 w-4 mr-2" />
            Shortcuts
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/signout">
              <LogOut className="h-4 w-4 mr-2" />
              Sign out
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <KeyboardShortcutsModal open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}
