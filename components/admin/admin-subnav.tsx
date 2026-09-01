'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, MessageSquareQuote, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

const ADMIN_SECTIONS = [
  {
    href: '/admin',
    label: 'Overview',
    icon: LayoutDashboard,
    match: (path: string) => path === '/admin',
  },
  {
    href: '/admin/users',
    label: 'Users',
    icon: Users,
    match: (path: string) => path.startsWith('/admin/users'),
  },
  {
    href: '/admin/feedback',
    label: 'Feedback',
    icon: MessageSquareQuote,
    match: (path: string) => path.startsWith('/admin/feedback'),
  },
] as const;

export function AdminSubnav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Admin sections"
      className="mb-6 flex items-center gap-1 overflow-x-auto border-b border-border pb-px"
    >
      {ADMIN_SECTIONS.map((section) => {
        const active = section.match(pathname);
        return (
          <Link
            key={section.href}
            href={section.href}
            className={cn(
              'flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-foreground font-semibold text-foreground'
                : 'border-transparent font-medium text-muted-foreground hover:text-foreground'
            )}
          >
            <section.icon className="h-4 w-4" />
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
