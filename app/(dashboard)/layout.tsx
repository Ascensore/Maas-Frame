import { AppShell } from '@/components/layout/app-shell';
import { auth } from '@/lib/auth';
import { hasAppNavigationAccess } from '@/lib/route-access';
import { getTrialNotice } from '@/lib/billing';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const userId = session?.user?.id;
  const [showAppNavigation, trialNotice] = await Promise.all([
    userId ? hasAppNavigationAccess(userId) : false,
    userId ? getTrialNotice(userId) : null,
  ]);

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
