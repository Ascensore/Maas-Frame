import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { BillingSubscriptionStatus } from '@prisma/client';
import { MAX_SHARE_PASSWORD_LENGTH, validateShareLinkAccess } from '@/lib/share-links';

const dbMock = vi.hoisted(() => ({
  shareLink: { findUnique: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db: dbMock, default: dbMock, disconnectDb: vi.fn() }));

const NOW = new Date('2026-01-15T00:00:00.000Z');
const PASSWORD = 'correct horse battery staple';
// Cost 4 keeps the suite fast; the comparison logic is identical at any cost.
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const LONG_PASSWORD = 'a'.repeat(MAX_SHARE_PASSWORD_LENGTH + 1);
const LONG_PASSWORD_HASH = bcrypt.hashSync(LONG_PASSWORD, 4);

type OwnerBilling = {
  subscriptionStatus: BillingSubscriptionStatus;
  trialEndsAt: Date | null;
  stripeCurrentPeriodEnd: Date | null;
  billingAccessEndedAt: Date | null;
};

const ACTIVE_OWNER: OwnerBilling = {
  subscriptionStatus: BillingSubscriptionStatus.ACTIVE,
  trialEndsAt: null,
  stripeCurrentPeriodEnd: null,
  billingAccessEndedAt: null,
};

const EXPIRED_OWNER: OwnerBilling = {
  subscriptionStatus: BillingSubscriptionStatus.CANCELED,
  trialEndsAt: new Date('2025-12-01T00:00:00.000Z'),
  stripeCurrentPeriodEnd: new Date('2025-12-01T00:00:00.000Z'),
  billingAccessEndedAt: new Date('2025-12-01T00:00:00.000Z'),
};

type LinkOverrides = {
  projectId?: string;
  videoId?: string | null;
  permission?: 'VIEW' | 'COMMENT';
  expiresAt?: Date | null;
  passwordHash?: string | null;
  allowGuests?: boolean;
  allowDownloads?: boolean;
  owner?: OwnerBilling | null;
  project?: unknown;
};

function mockLink(overrides: LinkOverrides = {}) {
  const { owner = ACTIVE_OWNER, project, ...rest } = overrides;

  dbMock.shareLink.findUnique.mockResolvedValue({
    id: 'link-1',
    token: 'tok_abc',
    projectId: 'project-1',
    videoId: null,
    permission: 'VIEW',
    expiresAt: null,
    passwordHash: null,
    allowGuests: true,
    allowDownloads: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    project: project !== undefined ? project : { workspace: { owner } },
    ...rest,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
  dbMock.shareLink.findUnique.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('validateShareLinkAccess', () => {
  it('denies access and returns no link for an unknown token', async () => {
    dbMock.shareLink.findUnique.mockResolvedValue(null);

    await expect(
      validateShareLinkAccess({ token: 'nope', projectId: 'project-1' })
    ).resolves.toEqual({
      hasAccess: false,
      canComment: false,
      canDownload: false,
      allowGuests: false,
      requiresPassword: false,
      link: null,
    });
  });

  it('grants read access for a matching project-scoped VIEW link', async () => {
    mockLink();

    const result = await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' });

    expect(result.hasAccess).toBe(true);
    expect(result.canComment).toBe(false);
    expect(result.canDownload).toBe(false);
    expect(result.allowGuests).toBe(true);
    expect(result.requiresPassword).toBe(false);
  });

  it('denies access when the link belongs to a different project', async () => {
    mockLink({ projectId: 'project-other' });

    const result = await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' });

    expect(result.hasAccess).toBe(false);
    expect(result.link).not.toBeNull();
  });

  it('denies a project-wide request when the link is scoped to a single video', async () => {
    mockLink({ videoId: 'video-1' });

    const result = await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' });

    expect(result.hasAccess).toBe(false);
  });

  it('grants access when the requested video matches the link scope', async () => {
    mockLink({ videoId: 'video-1' });

    const result = await validateShareLinkAccess({
      token: 'tok_abc',
      projectId: 'project-1',
      videoId: 'video-1',
    });

    expect(result.hasAccess).toBe(true);
  });

  it('denies a video request against a project-wide link', async () => {
    mockLink({ videoId: null });

    const result = await validateShareLinkAccess({
      token: 'tok_abc',
      projectId: 'project-1',
      videoId: 'video-1',
    });

    expect(result.hasAccess).toBe(false);
  });

  it('denies a video request against a link scoped to another video', async () => {
    mockLink({ videoId: 'video-2' });

    const result = await validateShareLinkAccess({
      token: 'tok_abc',
      projectId: 'project-1',
      videoId: 'video-1',
    });

    expect(result.hasAccess).toBe(false);
  });

  it.each([
    ['VIEW', 'VIEW', true, false],
    ['COMMENT', 'VIEW', true, true],
    ['VIEW', 'COMMENT', false, false],
    ['COMMENT', 'COMMENT', true, true],
  ] as const)(
    'a %s link asked for %s permission grants access=%s and comment=%s',
    async (linkPermission, required, expectedAccess, expectedComment) => {
      mockLink({ permission: linkPermission });

      const result = await validateShareLinkAccess({
        token: 'tok_abc',
        projectId: 'project-1',
        requiredPermission: required,
      });

      expect(result.hasAccess).toBe(expectedAccess);
      expect(result.canComment).toBe(expectedComment);
    }
  );

  it('defaults the required permission to VIEW', async () => {
    mockLink({ permission: 'VIEW' });

    expect(
      (await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' })).hasAccess
    ).toBe(true);
  });

  it('treats a link with no expiry as permanent', async () => {
    mockLink({ expiresAt: null });

    expect(
      (await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' })).hasAccess
    ).toBe(true);
  });

  it('grants access one millisecond before expiry', async () => {
    mockLink({ expiresAt: new Date(NOW.getTime() + 1) });

    expect(
      (await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' })).hasAccess
    ).toBe(true);
  });

  it('denies access at the exact expiry instant', async () => {
    mockLink({ expiresAt: new Date(NOW.getTime()) });

    expect(
      (await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' })).hasAccess
    ).toBe(false);
  });

  it('denies access after expiry', async () => {
    mockLink({ expiresAt: new Date(NOW.getTime() - 1000) });

    const result = await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' });

    expect(result.hasAccess).toBe(false);
    expect(result.requiresPassword).toBe(false);
  });

  it('denies access when the workspace owner has lost billing access', async () => {
    mockLink({ owner: EXPIRED_OWNER });

    const result = await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' });

    expect(result.hasAccess).toBe(false);
    expect(result.canDownload).toBe(false);
  });

  it('grants access to an expired-billing workspace when Stripe is disabled', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
    mockLink({ owner: EXPIRED_OWNER });

    expect(
      (await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' })).hasAccess
    ).toBe(true);
  });

  it('denies access when the workspace owner row is missing', async () => {
    mockLink({ owner: null });

    expect(
      (await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' })).hasAccess
    ).toBe(false);
  });

  it('denies access when the included project relation is missing', async () => {
    mockLink({ project: null });

    expect(
      (await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' })).hasAccess
    ).toBe(false);
  });

  it('asks for a password when the link is protected and none was presented', async () => {
    mockLink({ passwordHash: PASSWORD_HASH });

    const result = await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' });

    expect(result.hasAccess).toBe(false);
    expect(result.requiresPassword).toBe(true);
  });

  it('rejects a wrong password and keeps asking', async () => {
    mockLink({ passwordHash: PASSWORD_HASH });

    const result = await validateShareLinkAccess({
      token: 'tok_abc',
      projectId: 'project-1',
      presentedPassword: 'wrong password',
    });

    expect(result.hasAccess).toBe(false);
    expect(result.requiresPassword).toBe(true);
  });

  it('accepts the correct password', async () => {
    mockLink({ passwordHash: PASSWORD_HASH, permission: 'COMMENT', allowDownloads: true });

    const result = await validateShareLinkAccess({
      token: 'tok_abc',
      projectId: 'project-1',
      requiredPermission: 'COMMENT',
      presentedPassword: PASSWORD,
    });

    expect(result).toMatchObject({
      hasAccess: true,
      canComment: true,
      canDownload: true,
      requiresPassword: false,
    });
  });

  it('rejects a correct but over-long password before hashing it', async () => {
    mockLink({ passwordHash: LONG_PASSWORD_HASH });

    const result = await validateShareLinkAccess({
      token: 'tok_abc',
      projectId: 'project-1',
      presentedPassword: LONG_PASSWORD,
    });

    expect(result.hasAccess).toBe(false);
    expect(result.requiresPassword).toBe(true);
  });

  it('skips the password check when the session already verified it', async () => {
    mockLink({ passwordHash: PASSWORD_HASH });

    const result = await validateShareLinkAccess({
      token: 'tok_abc',
      projectId: 'project-1',
      passwordVerified: true,
    });

    expect(result.hasAccess).toBe(true);
    expect(result.requiresPassword).toBe(false);
  });

  it('does not ask for a password on an unprotected link even when one is presented', async () => {
    mockLink({ passwordHash: null });

    const result = await validateShareLinkAccess({
      token: 'tok_abc',
      projectId: 'project-1',
      presentedPassword: 'anything',
    });

    expect(result.hasAccess).toBe(true);
    expect(result.requiresPassword).toBe(false);
  });

  it('reports allowGuests and allowDownloads straight from the link row', async () => {
    mockLink({ allowGuests: false, allowDownloads: true });

    const result = await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' });

    expect(result.allowGuests).toBe(false);
    expect(result.canDownload).toBe(true);
  });

  it('suppresses allowGuests and allowDownloads on every denial path', async () => {
    mockLink({ allowGuests: true, allowDownloads: true, expiresAt: new Date(NOW.getTime() - 1) });

    const result = await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' });

    expect(result.allowGuests).toBe(false);
    expect(result.canDownload).toBe(false);
  });

  it('looks the link up by token alone', async () => {
    mockLink();

    await validateShareLinkAccess({ token: 'tok_abc', projectId: 'project-1' });

    expect(dbMock.shareLink.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { token: 'tok_abc' } })
    );
  });
});
