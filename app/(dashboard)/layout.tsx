import { AppShell } from '@/components/layout/app-shell';
import { auth } from '@/lib/auth';
import { hasAppNavigationAccess } from '@/lib/route-access';
import { getTrialNotice } from '@/lib/billing';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const userId = session?.user?.id;
  const [hasNavAccess, trialNotice] = await Promise.all([
    userId ? hasAppNavigationAccess(userId) : false,
    userId ? getTrialNotice(userId) : null,
  ]);
  // Admins still need the app chrome on /admin even when they have no billing
  // of their own; hiding the sidebar is what used to shove them into a second,
  // top-of-page nav.
  const showAppNavigation = Boolean(session?.user?.isAdmin) || hasNavAccess;

  return (
    <AppShell
      user={session?.user ?? null}
      showAppNavigation={showAppNavigation}
      trialNotice={trialNotice}
    >
      {children}
    </AppShell>
  );
}
