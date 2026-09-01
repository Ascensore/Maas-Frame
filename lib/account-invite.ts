import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import {
  brandedEmailTemplate,
  emailButton,
  emailHeading,
  emailRow,
  EMAIL_COLORS,
} from '@/lib/email-brand';
import { isValidEmailAddress, normalizeEmail } from '@/lib/email-validation';
import { sendTransactionalEmail } from '@/lib/mail';
import { startCardlessTrial } from '@/lib/billing';
import { logError } from '@/lib/logger';

export const SET_PASSWORD_TOKEN_PREFIX = 'set-password:';
export const SET_PASSWORD_TTL_DAYS = 7;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MIN_NAME_LENGTH = 2;
export const MAX_NAME_LENGTH = 100;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function setPasswordIdentifier(email: string): string {
  return `${SET_PASSWORD_TOKEN_PREFIX}${email}`;
}

function emailFromIdentifier(identifier: string): string | null {
  if (!identifier.startsWith(SET_PASSWORD_TOKEN_PREFIX)) return null;
  return identifier.slice(SET_PASSWORD_TOKEN_PREFIX.length);
}

export function isValidInviteName(name: string | undefined | null): boolean {
  if (name == null) return true;
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return (
    trimmed.length === 0 || (trimmed.length >= MIN_NAME_LENGTH && trimmed.length <= MAX_NAME_LENGTH)
  );
}

export function isValidPassword(password: string): boolean {
  return (
    typeof password === 'string' &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH
  );
}

export function buildSetPasswordUrl(token: string): string | null {
  const baseUrl = process.env.NEXTAUTH_URL?.trim();
  if (!baseUrl) return null;
  return `${baseUrl}/set-password?token=${encodeURIComponent(token)}`;
}

/** Raw token for the email; only the SHA-256 digest is stored. */
export async function createSetPasswordToken(email: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const identifier = setPasswordIdentifier(email);
  const expires = new Date(Date.now() + SET_PASSWORD_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.verificationToken.deleteMany({ where: { identifier } });
  await db.verificationToken.create({
    data: { identifier, token: tokenHash, expires },
  });

  return token;
}

export async function sendAccountInviteEmail(input: {
  to: string;
  inviterName: string;
  setupUrl: string;
}): Promise<boolean> {
  const html = brandedEmailTemplate(
    `
      <tr>${emailHeading('✉', 'You have been invited to OpenFrame')}</tr>
      <tr><td style="padding:20px;">
        <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;">
          ${emailRow('Invited by', input.inviterName, true)}
          ${emailRow('Account', input.to, true)}
          ${emailRow('Expires in', `${SET_PASSWORD_TTL_DAYS} days`)}
        </table>
        <p style="margin:0 0 20px;font-size:14px;color:${EMAIL_COLORS.textSecondary};line-height:1.6;">
          An administrator created an account for this address. Set a password to sign in.
        </p>
        ${emailButton('Set your password  →', input.setupUrl)}
      </td></tr>
    `,
    {
      footerText: `This link expires in ${SET_PASSWORD_TTL_DAYS} days.`,
    }
  );

  return sendTransactionalEmail({
    to: input.to,
    subject: 'Set up your OpenFrame account',
    html,
  });
}

export type InviteUserResult =
  | {
      ok: true;
      user: { id: string; name: string | null; email: string | null };
      emailSent: boolean;
      resent: boolean;
      setupUrl: string | null;
    }
  | { ok: false; reason: 'invalid-email' | 'invalid-name' | 'already-active' | 'missing-app-url' };

/**
 * Creates (or re-invites) a user who cannot yet sign in, and emails them a
 * one-time set-password link. An address that already has a password is refused.
 */
export async function inviteUser(input: {
  email: string;
  name?: string | null;
  inviterName: string;
}): Promise<InviteUserResult> {
  if (!process.env.NEXTAUTH_URL?.trim()) {
    logError(
      'NEXTAUTH_URL is not set — cannot build a set-password link.',
      new Error('Set NEXTAUTH_URL to your deployment origin.')
    );
    return { ok: false, reason: 'missing-app-url' };
  }

  if (typeof input.email !== 'string') {
    return { ok: false, reason: 'invalid-email' };
  }
  const email = normalizeEmail(input.email);
  if (!isValidEmailAddress(email)) {
    return { ok: false, reason: 'invalid-email' };
  }

  if (!isValidInviteName(input.name)) {
    return { ok: false, reason: 'invalid-name' };
  }
  const name =
    typeof input.name === 'string' && input.name.trim().length >= MIN_NAME_LENGTH
      ? input.name.trim()
      : null;

  const existing = await db.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, password: true },
  });

  if (existing?.password) {
    return { ok: false, reason: 'already-active' };
  }

  let user = existing
    ? existing
    : await db.user.create({
        data: {
          email,
          name,
          password: null,
          emailVerified: null,
        },
        select: { id: true, name: true, email: true, password: true },
      });

  if (existing && name && !existing.name) {
    user = await db.user.update({
      where: { id: existing.id },
      data: { name },
      select: { id: true, name: true, email: true, password: true },
    });
  }

  const token = await createSetPasswordToken(email);
  const setupUrl = buildSetPasswordUrl(token);
  if (!setupUrl) {
    return { ok: false, reason: 'missing-app-url' };
  }

  const emailSent = await sendAccountInviteEmail({
    to: email,
    inviterName: input.inviterName,
    setupUrl,
  });

  return {
    ok: true,
    user: { id: user.id, name: user.name, email: user.email },
    emailSent,
    resent: Boolean(existing),
    // Only returned when mail did not go out, so an admin can copy the link
    // rather than leave the invitee with nothing. The raw token is the secret.
    setupUrl: emailSent ? null : setupUrl,
  };
}

export type CompleteSetPasswordResult =
  | { ok: true; userId: string; email: string }
  | {
      ok: false;
      reason:
        | 'invalid-token'
        | 'invalid-password'
        | 'invalid-name'
        | 'already-active'
        | 'missing-user';
    };

/**
 * Consumes a set-password token and writes the password in one transaction, so
 * a replayed link cannot set the password twice.
 */
export async function completeSetPassword(input: {
  token: string;
  password: string;
  name?: string | null;
}): Promise<CompleteSetPasswordResult> {
  if (!isValidPassword(input.password)) {
    return { ok: false, reason: 'invalid-password' };
  }
  if (!isValidInviteName(input.name)) {
    return { ok: false, reason: 'invalid-name' };
  }

  const tokenHash = hashToken(input.token);
  const record = await db.verificationToken.findUnique({ where: { token: tokenHash } });
  if (!record || record.expires < new Date()) {
    if (record) {
      await db.verificationToken.delete({ where: { token: tokenHash } }).catch(() => null);
    }
    return { ok: false, reason: 'invalid-token' };
  }

  const email = emailFromIdentifier(record.identifier);
  if (!email) {
    return { ok: false, reason: 'invalid-token' };
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, password: true, name: true },
  });
  if (!user) {
    await db.verificationToken.delete({ where: { token: tokenHash } }).catch(() => null);
    return { ok: false, reason: 'missing-user' };
  }
  if (user.password) {
    await db.verificationToken.delete({ where: { token: tokenHash } }).catch(() => null);
    return { ok: false, reason: 'already-active' };
  }

  const hashedPassword = await bcrypt.hash(input.password, 12);
  const nextName =
    typeof input.name === 'string' && input.name.trim().length >= MIN_NAME_LENGTH
      ? input.name.trim()
      : undefined;

  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        emailVerified: new Date(),
        ...(nextName ? { name: nextName } : {}),
      },
    }),
    db.verificationToken.delete({ where: { token: tokenHash } }),
  ]);

  await startCardlessTrial(user.id);

  return { ok: true, userId: user.id, email };
}
