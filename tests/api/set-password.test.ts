import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { POST as setPassword } from '@/app/api/auth/set-password/route';
import {
  completeSetPassword,
  createSetPasswordToken,
  SET_PASSWORD_TOKEN_PREFIX,
} from '@/lib/account-invite';
import { createVerificationToken } from '@/lib/email-verification';
import { apiRequest, callRoute, readError } from '../helpers/request';
import { signedOut } from '../helpers/session';
import { createUser } from '../factories';

const PASSWORD = 'correct horse battery';
const MINUTE_MS = 60 * 1000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function setPasswordRequest(body: unknown) {
  signedOut();
  return callRoute(setPassword, apiRequest('/api/auth/set-password', { body }));
}

async function expireToken(tokenHash: string): Promise<void> {
  await db.verificationToken.update({
    where: { token: tokenHash },
    data: { expires: new Date(Date.now() - MINUTE_MS) },
  });
}

describe('POST /api/auth/set-password', () => {
  it('sets the password, verifies the address, and refuses a replay', async () => {
    const user = await createUser({
      email: 'ada@example.com',
      password: undefined,
      emailVerified: null,
      trialEndsAt: null,
      billingTrialConsumedAt: null,
    });
    const token = await createSetPasswordToken('ada@example.com');

    const response = await setPasswordRequest({ token, password: PASSWORD, name: 'Ada Lovelace' });
    expect(response.status).toBe(200);

    const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.password).toBeTruthy();
    expect(await bcrypt.compare(PASSWORD, updated.password as string)).toBe(true);
    expect(updated.emailVerified).not.toBeNull();
    expect(updated.name).toBe('Ada Lovelace');
    expect(updated.trialEndsAt).not.toBeNull();
    expect(await db.verificationToken.count()).toBe(0);

    const replay = await setPasswordRequest({ token, password: 'different horse battery' });
    expect(replay.status).toBe(400);
    const afterReplay = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(PASSWORD, afterReplay.password as string)).toBe(true);
  });

  it('returns 400 for an expired token and leaves the account pending', async () => {
    const user = await createUser({
      email: 'ada@example.com',
      password: undefined,
      emailVerified: null,
      trialEndsAt: null,
    });
    const token = await createSetPasswordToken('ada@example.com');
    await expireToken(sha256(token));

    const response = await setPasswordRequest({ token, password: PASSWORD });
    expect(response.status).toBe(400);
    expect(await readError(response)).toMatch(/invalid or has expired/i);

    const pending = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(pending.password).toBeNull();
    expect(pending.emailVerified).toBeNull();
  });

  it('does not accept an email-verification token as a set-password token', async () => {
    const user = await createUser({
      email: 'ada@example.com',
      password: undefined,
      emailVerified: null,
    });
    const verificationToken = await createVerificationToken('ada@example.com');

    const response = await setPasswordRequest({ token: verificationToken, password: PASSWORD });
    expect(response.status).toBe(400);

    const pending = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(pending.password).toBeNull();
    expect(await db.verificationToken.count({ where: { identifier: 'ada@example.com' } })).toBe(1);
  });

  it('returns 400 for a short password and does not consume the token', async () => {
    await createUser({ email: 'ada@example.com', password: undefined, emailVerified: null });
    const token = await createSetPasswordToken('ada@example.com');

    const response = await setPasswordRequest({ token, password: 'short' });
    expect(response.status).toBe(400);
    expect(await db.verificationToken.count({ where: { token: sha256(token) } })).toBe(1);
  });

  it('returns 400 when the token is missing', async () => {
    const response = await setPasswordRequest({ password: PASSWORD });
    expect(response.status).toBe(400);
  });
});

describe('createSetPasswordToken', () => {
  it('stores a digest under the set-password identifier, not the raw token', async () => {
    const token = await createSetPasswordToken('ada@example.com');
    const record = await db.verificationToken.findFirstOrThrow();
    expect(record.identifier).toBe(`${SET_PASSWORD_TOKEN_PREFIX}ada@example.com`);
    expect(record.token).toBe(sha256(token));
    expect(record.token).not.toBe(token);
  });
});

describe('completeSetPassword', () => {
  it('refuses a user who already has a password without changing it', async () => {
    const user = await createUser({ email: 'ada@example.com', password: PASSWORD });
    const token = await createSetPasswordToken('ada@example.com');
    const before = user.password;

    const result = await completeSetPassword({ token, password: 'brand new horse battery' });
    expect(result).toEqual({ ok: false, reason: 'already-active' });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).password).toBe(before);
    expect(await db.verificationToken.count()).toBe(0);
  });
});
