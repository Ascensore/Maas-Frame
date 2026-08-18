import { after } from 'next/server';
import { readPageVisitor, recordVisitorEvent } from '@/lib/analytics/visitor';
import { isInviteCodeRequired, isStripeFeatureEnabled } from '@/lib/feature-flags';
import { getInvitationPreviewByToken } from '@/lib/invitations';
import { isInvitationPreviewAllowed } from '@/lib/invitation-preview-limit';
import RegisterPageClient from './register-page-client';

interface RegisterPageProps {
  searchParams: Promise<{ invitationToken?: string }>;
}

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  // Reaching this page is the funnel step. Recording it here rather than from the
  // browser also keeps it honest: a prefetch of this route is filtered out by
  // readPageVisitor, so signup starts can never outnumber the landing views
  // above them.
  const visitor = await readPageVisitor();
  after(() => recordVisitorEvent('SIGNUP_STARTED', visitor));

  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);

  const token = (await searchParams)?.invitationToken?.trim();

  // Unauthenticated invitation lookup — throttled per IP (and per token) before it can
  // touch the database. When throttled we skip the lookup instead of guessing at a verdict.
  const previewAllowed = token ? await isInvitationPreviewAllowed(token) : false;
  const preview = token && previewAllowed ? await getInvitationPreviewByToken(token) : null;
  const invitation =
    preview && preview.status === 'PENDING' && !preview.isExpired
      ? {
          email: preview.email,
          inviterName: preview.inviterName,
          roleLabel: preview.roleLabel,
          scopeLabel: preview.scopeLabel,
          targetName: preview.targetName,
        }
      : null;

  return (
    <RegisterPageClient
      requireInviteCode={isInviteCodeRequired()}
      trialOnSignup={isStripeFeatureEnabled()}
      googleEnabled={googleEnabled}
      githubEnabled={githubEnabled}
      invitation={invitation}
      invitationLookupThrottled={Boolean(token) && !previewAllowed}
    />
  );
}
