import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { POST as invite } from '@/app/api/admin/users/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { mailTo, sentMail } from '../helpers/mail';
import { signedInAs, signedOut } from '../helpers/session';
import { createUser } from '../factories';
import { SET_PASSWORD_TOKEN_PREFIX } from '@/lib/account-invite';

const PASSWORD = 'correct horse battery';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokenFromMail(html: string | undefined): string {
  const match = html?.match(/set-password\?token=([0-9a-f]+)/);
  if (!match) {
    throw new Error(`Invite mail did not contain a set-password token: ${html?.slice(0, 200)}`);
  }
  return match[1];
}

async function asAdmin() {
  const admin = await createUser({ name: 'Site Admin', email: 'admin-invite@example.com' });
  signedInAs({ id: admin.id, email: admin.email, name: admin.name, isAdmin: true });
  return admin;
}

describe('POST /api/admin/users', () => {
  it('returns 401 to an anonymous caller and creates no user', async () => {
    signedOut();
    const before = await db.user.count();

    const response = await callRoute(
      invite,
      apiRequest('/api/admin/users', { body: { email: 'ada@example.com' } })
    );

    expect(response.status).toBe(401);
    expect(await db.user.count()).toBe(before);
  });

  it('returns 403 to a signed-in non-admin and creates no user', async () => {
    const user = await createUser();
    signedInAs({ id: user.id, email: user.email, isAdmin: false });
    const before = await db.user.count();

    const response = await callRoute(
      invite,
      apiRequest('/api/admin/users', { body: { email: 'ada@example.com' } })
    );

    expect(response.status).toBe(403);
    expect(await db.user.count()).toBe(before);
    expect(await db.user.findUnique({ where: { email: 'ada@example.com' } })).toBeNull();
  });

  it('creates a pending account, stores only the token digest, and emails the raw token', async () => {
    await asAdmin();

    const response = await callRoute(
      invite,
      apiRequest('/api/admin/users', { body: { email: 'Ada@Example.com', name: 'Ada Lovelace' } })
    );

    expect(response.status).toBe(201);
    const data = await readData(response);
    expect(data.user.email).toBe('ada@example.com');
    expect(data.user.name).toBe('Ada Lovelace');
    expect(data.emailSent).toBe(true);
    expect(data.resent).toBe(false);
    expect(data.setupUrl).toBeNull();

    const created = await db.user.findUniqueOrThrow({ where: { email: 'ada@example.com' } });
    expect(created.password).toBeNull();
    expect(created.emailVerified).toBeNull();
    expect(created.trialEndsAt).toBeNull();
    expect(created.name).toBe('Ada Lovelace');

    const mail = mailTo('ada@example.com');
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe('Set up your OpenFrame account');
    const rawToken = tokenFromMail(mail[0].html);

    const stored = await db.verificationToken.findFirstOrThrow();
    expect(stored.identifier).toBe(`${SET_PASSWORD_TOKEN_PREFIX}ada@example.com`);
    expect(stored.token).not.toBe(rawToken);
    expect(stored.token).toBe(sha256(rawToken));
  });

  it('resends to a pending invitee and invalidates the previous link', async () => {
    await asAdmin();

    const first = await callRoute(
      invite,
      apiRequest('/api/admin/users', { body: { email: 'ada@example.com' } })
    );
    expect(first.status).toBe(201);
    const firstToken = tokenFromMail(mailTo('ada@example.com')[0].html);

    const second = await callRoute(
      invite,
      apiRequest('/api/admin/users', { body: { email: 'ada@example.com' } })
    );
    expect(second.status).toBe(200);
    const data = await readData(second);
    expect(data.resent).toBe(true);
    expect(await db.user.count({ where: { email: 'ada@example.com' } })).toBe(1);
    expect(await db.verificationToken.count()).toBe(1);

    const secondToken = tokenFromMail(mailTo('ada@example.com')[1].html);
    expect(secondToken).not.toBe(firstToken);
    expect(await db.verificationToken.count({ where: { token: sha256(firstToken) } })).toBe(0);
  });

  it('returns 409 when the address already has a password, and does not mail', async () => {
    const existing = await createUser({ email: 'ada@example.com', password: PASSWORD });
    const passwordBefore = existing.password;
    await asAdmin();

    const response = await callRoute(
      invite,
      apiRequest('/api/admin/users', { body: { email: 'ada@example.com' } })
    );

    expect(response.status).toBe(409);
    expect(await readError(response)).toMatch(/already exists/i);
    expect(sentMail()).toHaveLength(0);
    expect(await db.user.count({ where: { email: 'ada@example.com' } })).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: existing.id } })).password).toBe(
      passwordBefore
    );
  });

  it('returns 422 for a malformed address and creates no user', async () => {
    await asAdmin();

    const response = await callRoute(
      invite,
      apiRequest('/api/admin/users', { body: { email: 'not-an-email' } })
    );

    expect(response.status).toBe(422);
    expect(await db.user.findUnique({ where: { email: 'not-an-email' } })).toBeNull();
  });

  it('returns 400 for a one-character name and creates no user', async () => {
    await asAdmin();

    const response = await callRoute(
      invite,
      apiRequest('/api/admin/users', { body: { email: 'ada@example.com', name: 'A' } })
    );

    expect(response.status).toBe(400);
    expect(await db.user.findUnique({ where: { email: 'ada@example.com' } })).toBeNull();
  });
});
