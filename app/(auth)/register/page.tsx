import { isInviteCodeRequired } from '@/lib/feature-flags';
import { getInvitationPreviewByToken } from '@/lib/invitations';
import RegisterPageClient from './register-page-client';

interface RegisterPageProps {
  searchParams: Promise<{ invitationToken?: string }>;
}

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);

  const token = (await searchParams)?.invitationToken?.trim();
  const preview = token ? await getInvitationPreviewByToken(token) : null;
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
      googleEnabled={googleEnabled}
      githubEnabled={githubEnabled}
      invitation={invitation}
    />
  );
}
