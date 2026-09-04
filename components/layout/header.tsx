'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { User, Menu, LayoutDashboard, MessageSquareQuote, Search, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ThemeToggle } from '@/components/theme-toggle';
import { BrandLockup, BrandMark } from '@/components/brand/brand-mark';
import { APP_NAV_ITEMS, navItemActive } from '@/components/layout/app-sidebar';
import { UserAccountMenu } from '@/components/layout/user-account-menu';
import { cn } from '@/lib/utils';

const SearchModal = dynamic(
  () => import('@/components/search-modal').then((mod) => mod.SearchModal),
  { ssr: false }
);

interface HeaderProps {
  user?: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
    isAdmin?: boolean;
  } | null;
  showAppNavigation?: boolean;
  /** When true, desktop nav lives in the sidebar; this bar is search + actions only. */
  embedded?: boolean;
}

export function Header({ user, showAppNavigation = false, embedded = false }: HeaderProps) {
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        if (!user || !showAppNavigation) {
          return;
        }

        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showAppNavigation, user]);

  const isVideoPage =
    /\/videos\/[^/]+($|\/compare)/.test(pathname) || pathname.startsWith('/watch/');
  if (isVideoPage) return null;

  const mobileNav = (
    <nav className="mt-10 flex flex-col gap-1">
      {showAppNavigation &&
        APP_NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-sm font-medium transition-colors',
              navItemActive(pathname, item.href, item.match)
                ? 'border border-border bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        ))}
      {user?.isAdmin && (
        <Link
          href="/admin"
          className={cn(
            'flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-sm font-medium transition-colors',
            pathname.startsWith('/admin')
              ? 'border border-border bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          <LayoutDashboard className="h-4 w-4" />
          Admin Panel
        </Link>
      )}
    </nav>
  );

  return (
    <header
      className={cn(
        'sticky top-0 z-[60] w-full border-b border-border bg-sidebar',
        !embedded && 'bg-sidebar/95 backdrop-blur supports-[backdrop-filter]:bg-sidebar/80'
      )}
    >
      <div className="flex h-[62px] w-full items-center gap-3 px-4 md:px-6">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="mr-1 md:hidden">
              <Menu className="h-5 w-5" />
              <span className="sr-only">Toggle menu</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-64 flex-col bg-sidebar">
            <SheetTitle className="sr-only">Navigation Menu</SheetTitle>
            <SheetDescription className="sr-only">
              Access your projects and workspaces
            </SheetDescription>
            <div className="mt-2 px-1">
              <BrandLockup />
            </div>
            {mobileNav}
            {user ? (
              <div className="mt-auto px-1 pb-2">
                <UserAccountMenu user={user} />
              </div>
            ) : null}
          </SheetContent>
        </Sheet>

        {!embedded && (
          <Link href="/" className="mr-4 flex items-center gap-2">
            <BrandMark size="sm" />
            <span className="hidden text-[15px] font-extrabold tracking-[-0.02em] sm:inline-block">
              OpenFrame
            </span>
          </Link>
        )}

        {!embedded && (
          <nav className="hidden items-center gap-1 md:flex">
            {showAppNavigation &&
              APP_NAV_ITEMS.filter((item) => item.href !== '/feedback').map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-2 rounded-[10px] px-3 py-2 text-[13px] font-medium transition-colors',
                    navItemActive(pathname, item.href, item.match)
                      ? 'bg-card text-foreground shadow-sm ring-1 ring-border'
                      : 'text-muted-foreground hover:bg-accent'
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              ))}
            {user?.isAdmin && (
              <Link
                href="/admin"
                className={cn(
                  'flex items-center gap-2 rounded-[10px] px-3 py-2 text-[13px] font-medium transition-colors',
                  pathname.startsWith('/admin')
                    ? 'bg-card text-foreground shadow-sm ring-1 ring-border'
                    : 'text-muted-foreground hover:bg-accent'
                )}
              >
                <LayoutDashboard className="h-4 w-4" />
                Admin Panel
              </Link>
            )}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-2">
          {user && showAppNavigation && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Search"
                    onClick={() => setSearchOpen(true)}
                    className="hidden h-9 items-center gap-2 rounded-full border border-border bg-card px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground sm:flex sm:w-[240px]"
                  >
                    <Search className="h-3.5 w-3.5" />
                    <span className="flex-1 text-left">Search assets, notes, people</span>
                    <kbd className="font-mono text-[10px] text-muted-foreground/70">⌘K</kbd>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="flex items-center gap-1.5">
                  <span>Search</span>
                  <kbd className="inline-flex h-5 items-center rounded-md border border-background/30 bg-background/20 px-1 font-mono text-[10px] text-background">
                    Ctrl K
                  </kbd>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {user && showAppNavigation && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Search"
              className="sm:hidden"
              onClick={() => setSearchOpen(true)}
            >
              <Search className="h-4 w-4" />
            </Button>
          )}
          {user && showAppNavigation && !embedded && (
            <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
              <Link href="/feedback">
                <MessageSquareQuote className="h-4 w-4 mr-1.5" />
                Feedback
              </Link>
            </Button>
          )}
          {user && showAppNavigation && (
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="sm:hidden"
              aria-label="Feedback and reviews"
            >
              <Link href="/feedback">
                <MessageSquareQuote className="h-4 w-4" />
              </Link>
            </Button>
          )}

          {user && showAppNavigation && (
            <Button asChild size="sm" className="hidden rounded-full sm:inline-flex">
              <Link href="/projects/new">
                <Plus className="h-3.5 w-3.5" />
                New project
              </Link>
            </Button>
          )}

          <ThemeToggle />

          {!user && (
            <Button asChild variant="outline" size="sm" className="rounded-full">
              <Link href="/login">
                <User className="h-4 w-4 mr-1" />
                Sign in
              </Link>
            </Button>
          )}
        </div>
      </div>
      {user && showAppNavigation && <SearchModal open={searchOpen} onOpenChange={setSearchOpen} />}
    </header>
  );
}
