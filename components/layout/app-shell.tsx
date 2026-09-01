'use client';

import { usePathname } from 'next/navigation';
import { AppSidebar, type AppNavUser } from '@/components/layout/app-sidebar';
import { Header } from '@/components/layout/header';
import { TrialBanner } from '@/components/layout/trial-banner';
import type { TrialNotice } from '@/lib/billing';

export function AppShell({
  user,
  showAppNavigation,
  trialNotice,
  children,
}: {
  user?: AppNavUser | null;
  showAppNavigation: boolean;
  trialNotice: TrialNotice | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isVideoPage =
    /\/videos\/[^/]+($|\/compare)/.test(pathname) || pathname.startsWith('/watch/');

  if (isVideoPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar user={user} showAppNavigation={showAppNavigation} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header user={user} showAppNavigation={showAppNavigation} embedded />
        {trialNotice ? <TrialBanner notice={trialNotice} /> : null}
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
