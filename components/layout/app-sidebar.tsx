'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, FolderOpen, LayoutDashboard, MessageSquareQuote, Settings } from 'lucide-react';
import { BrandLockup } from '@/components/brand/brand-mark';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

export interface AppNavUser {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  isAdmin?: boolean;
}

export const APP_NAV_ITEMS = [
  {
    href: '/dashboard',
    label: 'Projects',
    icon: FolderOpen,
    match: (path: string) => path.startsWith('/dashboard') || path.startsWith('/projects'),
  },
  {
    href: '/workspaces',
    label: 'Workspaces',
    icon: Building2,
    match: (path: string) => path.startsWith('/workspaces'),
  },
  {
    href: '/feedback',
    label: 'Feedback',
    icon: MessageSquareQuote,
    match: (path: string) => path.startsWith('/feedback'),
  },
] as const;

export function navItemActive(pathname: string, href: string, match: (path: string) => boolean) {
  if (href === '/dashboard') {
    return pathname === '/dashboard' || pathname.startsWith('/projects');
  }
  return match(pathname);
}

export function AppSidebar({
  user,
  showAppNavigation,
}: {
  user?: AppNavUser | null;
  showAppNavigation?: boolean;
}) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-[220px] shrink-0 flex-col gap-5 border-r border-sidebar-border bg-sidebar px-3.5 py-4 md:flex">
      <Link href={showAppNavigation ? '/dashboard' : '/'} className="px-1">
        <BrandLockup />
      </Link>

      {showAppNavigation ? (
        <nav className="flex flex-col gap-0.5">
          {APP_NAV_ITEMS.map((item) => {
            const active = navItemActive(pathname, item.href, item.match);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2.5 rounded-[10px] px-2.5 py-2.5 text-[13px] transition-colors',
                  active
                    ? 'border border-border bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(20,22,26,0.05)]'
                    : 'font-medium text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <item.icon className="size-[15px]" />
                {item.label}
              </Link>
            );
          })}
          {user?.isAdmin ? (
            <Link
              href="/admin"
              className={cn(
                'flex items-center gap-2.5 rounded-[10px] px-2.5 py-2.5 text-[13px] transition-colors',
                pathname.startsWith('/admin')
                  ? 'border border-border bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(20,22,26,0.05)]'
                  : 'font-medium text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <LayoutDashboard className="size-[15px]" />
              Admin
            </Link>
          ) : null}
        </nav>
      ) : null}

      <div className="mt-auto flex flex-col gap-3 px-1">
        {user ? (
          <Link
            href="/settings"
            className="flex items-center gap-2.5 rounded-[10px] py-1 hover:bg-accent"
          >
            <Avatar className="h-[26px] w-[26px]">
              <AvatarImage src={user.image ?? undefined} alt={user.name ?? ''} />
              <AvatarFallback className="text-[10px]">
                {user.name?.charAt(0).toUpperCase() ?? 'U'}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold text-foreground">
                {user.name ?? 'Account'}
              </span>
              <span className="flex items-center gap-1 text-[10.5px] font-medium text-muted-foreground">
                <Settings className="size-3" />
                Settings
              </span>
            </span>
          </Link>
        ) : null}
      </div>
    </aside>
  );
}
