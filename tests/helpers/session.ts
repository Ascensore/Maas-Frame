// Drives the `auth()` mock installed by tests/setup/api.ts.
//
// Only `auth` is faked. `checkProjectAccess`, `checkWorkspaceAccess` and
// `computeProjectAccess` are the real implementations running against the real
// test database, because they are the code under test: a suite that stubbed them
// out would assert nothing about authorization.

import type { Mock } from 'vitest';
import type { Session } from 'next-auth';
import { auth } from '@/lib/auth';

type AuthMock = Mock<() => Promise<Session | null>>;

/** The vi.fn() standing in for `auth()`. */
export function authMock(): AuthMock {
  const mock = auth as unknown as AuthMock;
  if (typeof mock?.mockResolvedValue !== 'function') {
    throw new Error(
      'auth() is not mocked. tests/helpers/session.ts only works inside the `api` ' +
        'Vitest project, whose setupFiles include tests/setup/api.ts.'
    );
  }
  return mock;
}

export interface SessionUserInput {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  isAdmin?: boolean;
}

/**
 * Makes every subsequent `auth()` call in the route under test resolve to a
 * session for this user. Accepts a factory-created user row directly.
 */
export function signedInAs(user: SessionUserInput): Session {
  const session = {
    user: {
      id: user.id,
      email: user.email ?? null,
      name: user.name ?? null,
      image: user.image ?? null,
      isAdmin: user.isAdmin ?? false,
    },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  } as unknown as Session;

  authMock().mockResolvedValue(session);
  return session;
}

/** Makes every subsequent `auth()` call resolve to null. */
export function signedOut(): void {
  authMock().mockResolvedValue(null);
}

/**
 * A session whose `user.id` points at no row in the database. Distinct from
 * signedOut(): it is the shape a route sees when a JWT outlives its user, and it
 * separates "no session" handling from "unknown user" handling.
 */
export function signedInAsGhost(id = 'ghost-user-id-that-does-not-exist'): Session {
  return signedInAs({ id, email: 'ghost@example.com', name: 'Ghost' });
}
