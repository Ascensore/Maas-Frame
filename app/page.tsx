import { after } from 'next/server';
import { LandingPage } from '@/components/LandingPage';
import { auth } from '@/lib/auth';
import { readPageVisitor, recordVisitorEvent } from '@/lib/analytics/visitor';

export default async function HomePage() {
  const session = await auth();
  const isLoggedIn = Boolean(session?.user);

  // Signed-in users land here too, and counting them would put existing
  // customers at the top of the acquisition funnel.
  if (!isLoggedIn) {
    const visitor = await readPageVisitor();
    after(() => recordVisitorEvent('LANDING_VIEW', visitor));
  }

  return <LandingPage isLoggedIn={isLoggedIn} />;
}
