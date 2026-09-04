'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, FolderOpen, LayoutDashboard, MessageSquareQuote } from 'lucide-react';
import { BrandLockup } from '@/components/brand/brand-mark';
import { UserAccountMenu, type AppNavUser } from '@/components/layout/user-account-menu';
import { cn } from '@/lib/utils';

export type { AppNavUser };

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
        {user ? <UserAccountMenu user={user} /> : null}
      </div>
    </aside>
  );
}
