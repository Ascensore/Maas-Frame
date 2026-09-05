import { describe, expect, it } from 'vitest';
import { GET as lookupSequenceLink } from '@/app/api/v1/sequence-link/lookup/route';
import { PUT as putSequenceLink } from '@/app/api/v1/versions/[versionId]/sequence-link/route';
import { generateApiToken } from '@/lib/api-token';
import { db } from '@/lib/db';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { createUser, seedVersion } from '../factories';

type LookupBody = { link: { versionId: string; sequenceId: string; sequenceName: string } | null };

const PUT_BODY = {
  nle: 'premiere',
  sequenceId: 'seq-original',
  sequenceName: 'Reel 1',
  startTimecode: '01:00:00:00',
  frameRateNum: 24,
  frameRateDen: 1,
  dropFrame: false,
};

function lookupUrl(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `/api/v1/sequence-link/lookup?${query}`;
}

async function mintApiToken(userId: string): Promise<string> {
  const token = generateApiToken();
  await db.apiToken.create({
    data: { userId, name: 'lookup-test', tokenHash: token.hash, tokenPrefix: token.prefix },
  });
  return token.raw;
}

async function bind(versionId: string, overrides: Partial<typeof PUT_BODY> = {}) {
  const response = await callRoute(
    putSequenceLink,
    apiRequest(`/api/v1/versions/${versionId}/sequence-link`, {
      method: 'PUT',
      body: { ...PUT_BODY, ...overrides },
    }),
    { versionId }
  );
  expect(response.status).toBe(200);
  return response;
}

describe('GET /api/v1/sequence-link/lookup', () => {
  it('refuses an anonymous caller', async () => {
    signedOut();
    const response = await callRoute(
      lookupSequenceLink,
      apiRequest(lookupUrl({ nle: 'premiere', sequenceId: 'seq-original' })),
      {}
    );
    expect(response.status).toBe(401);
  });

  it('requires both nle and sequenceId', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);

    expect(
      (await callRoute(lookupSequenceLink, apiRequest(lookupUrl({ nle: 'premiere' })), {})).status
    ).toBe(400);
    expect(
      (await callRoute(lookupSequenceLink, apiRequest(lookupUrl({ sequenceId: 'x' })), {})).status
    ).toBe(400);
    expect(
      (
        await callRoute(
          lookupSequenceLink,
          apiRequest(lookupUrl({ nle: 'NOT A NLE', sequenceId: 'x' })),
          {}
        )
      ).status
    ).toBe(400);
  });

  it('finds the version a sequence was bound to', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);
    await bind(scenario.version.id);

    // The write path has to persist the host id, or the lookup can never match.
    const stored = await db.sequenceLink.findFirst({ where: { versionId: scenario.version.id } });
    expect(stored?.sequenceId).toBe('seq-original');

    const response = await callRoute(
      lookupSequenceLink,
      apiRequest(lookupUrl({ nle: 'premiere', sequenceId: 'seq-original' })),
      {}
    );
    expect(response.status).toBe(200);
    const data = await readData<LookupBody>(response);
    expect(data.link?.versionId).toBe(scenario.version.id);
    expect(data.link?.sequenceName).toBe('Reel 1');
  });

  it('does not match a duplicated sequence that kept the name but got a new id', async () => {
    // This is the case a name match gets wrong: duplicating a sequence copies
    // its name and its markers, so a stale duplicate would sync as the original.
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);
    await bind(scenario.version.id);

    const response = await callRoute(
      lookupSequenceLink,
      apiRequest(lookupUrl({ nle: 'premiere', sequenceId: 'seq-duplicate' })),
      {}
    );
    expect(response.status).toBe(200);
    expect((await readData<LookupBody>(response)).link).toBeNull();
  });

  it('does not match the same sequence id under a different nle', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);
    await bind(scenario.version.id);

    const response = await callRoute(
      lookupSequenceLink,
      apiRequest(lookupUrl({ nle: 'resolve', sequenceId: 'seq-original' })),
      {}
    );
    expect((await readData<LookupBody>(response)).link).toBeNull();
  });

  it("never returns another user's link", async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);
    await bind(scenario.version.id);

    const stranger = await createUser();
    signedInAs(stranger);
    const response = await callRoute(
      lookupSequenceLink,
      apiRequest(lookupUrl({ nle: 'premiere', sequenceId: 'seq-original' })),
      {}
    );
    expect(response.status).toBe(200);
    expect((await readData<LookupBody>(response)).link).toBeNull();
  });

  it('refuses to name a version the caller has no access to, even from their own row', async () => {
    // A link row is written by the caller, but the version it names can stop
    // being theirs. Without the access re-check on read, a row pointing at
    // somebody else's version would hand back that version's id.
    const mine = await seedVersion({ visibility: 'PRIVATE' });
    const theirs = await seedVersion({ visibility: 'PRIVATE' });
    expect(theirs.owner.id).not.toBe(mine.owner.id);

    await db.sequenceLink.create({
      data: {
        userId: mine.owner.id,
        versionId: theirs.version.id,
        nle: 'premiere',
        sequenceId: 'seq-foreign',
        sequenceName: 'Reel 1',
        startTimecode: '01:00:00:00',
        frameRateNum: 24,
        frameRateDen: 1,
        dropFrame: false,
      },
    });

    signedInAs(mine.owner);
    const response = await callRoute(
      lookupSequenceLink,
      apiRequest(lookupUrl({ nle: 'premiere', sequenceId: 'seq-foreign' })),
      {}
    );
    expect(response.status).toBe(200);
    expect((await readData<LookupBody>(response)).link).toBeNull();
    // The row is untouched; only the answer changed.
    expect(await db.sequenceLink.count({ where: { versionId: theirs.version.id } })).toBe(1);
  });

  it('skips an inaccessible row and still finds an accessible one behind it', async () => {
    const mine = await seedVersion({ visibility: 'PRIVATE' });
    const theirs = await seedVersion({ visibility: 'PRIVATE' });
    const token = await mintApiToken(mine.owner.id);

    // Bind the reachable row FIRST so the unreachable one is newer and sorts
    // ahead of it. Written the other way round the reachable row comes first,
    // the skip branch never executes, and this test passes with the skip
    // replaced by a break.
    signedInAs(mine.owner);
    await bind(mine.version.id, { sequenceId: 'seq-shared' });

    await db.sequenceLink.create({
      data: {
        userId: mine.owner.id,
        versionId: theirs.version.id,
        nle: 'premiere',
        sequenceId: 'seq-shared',
        sequenceName: 'Reel 1',
        startTimecode: '01:00:00:00',
        frameRateNum: 24,
        frameRateDen: 1,
        dropFrame: false,
        updatedAt: new Date(Date.now() + 60_000),
      },
    });

    const rows = await db.sequenceLink.findMany({
      where: { userId: mine.owner.id, sequenceId: 'seq-shared' },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    // Guard the guard: if the unreachable row stops sorting first, this test
    // silently stops testing the skip.
    expect(rows[0]?.versionId).toBe(theirs.version.id);

    const response = await callRoute(
      lookupSequenceLink,
      apiRequest(lookupUrl({ nle: 'premiere', sequenceId: 'seq-shared' }), {
        headers: { authorization: `Bearer ${token}` },
      }),
      {}
    );
    expect(response.status).toBe(200);
    expect((await readData<LookupBody>(response)).link?.versionId).toBe(mine.version.id);
  });

  it('clears a stored sequence id when a sync sends null', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);
    await bind(scenario.version.id);

    const response = await callRoute(
      putSequenceLink,
      apiRequest(`/api/v1/versions/${scenario.version.id}/sequence-link`, {
        method: 'PUT',
        body: { ...PUT_BODY, sequenceId: null },
      }),
      { versionId: scenario.version.id }
    );
    expect(response.status).toBe(200);
    expect(
      (await db.sequenceLink.findFirst({ where: { versionId: scenario.version.id } }))?.sequenceId
    ).toBeNull();
  });

  it('clears a stored sequence id when a sync sends an empty string', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);
    await bind(scenario.version.id);

    const response = await callRoute(
      putSequenceLink,
      apiRequest(`/api/v1/versions/${scenario.version.id}/sequence-link`, {
        method: 'PUT',
        body: { ...PUT_BODY, sequenceId: '   ' },
      }),
      { versionId: scenario.version.id }
    );
    expect(response.status).toBe(200);
    expect(
      (await db.sequenceLink.findFirst({ where: { versionId: scenario.version.id } }))?.sequenceId
    ).toBeNull();
  });

  it('rejects a non-string sequence id instead of quietly keeping the old one', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);
    await bind(scenario.version.id);

    const response = await callRoute(
      putSequenceLink,
      apiRequest(`/api/v1/versions/${scenario.version.id}/sequence-link`, {
        method: 'PUT',
        body: { ...PUT_BODY, sequenceId: 123 },
      }),
      { versionId: scenario.version.id }
    );
    expect(response.status).toBe(400);
    expect(
      (await db.sequenceLink.findFirst({ where: { versionId: scenario.version.id } }))?.sequenceId
    ).toBe('seq-original');
  });

  it('skips a link whose version no longer exists and finds the live one behind it', async () => {
    // SequenceLink has no FK to VideoVersion, so a deleted version leaves the
    // row behind. Without the skip, the loop stops at the dangling row and the
    // reachable version behind it is never returned.
    const mine = await seedVersion({ visibility: 'PRIVATE' });
    const token = await mintApiToken(mine.owner.id);
    signedInAs(mine.owner);
    await bind(mine.version.id, { sequenceId: 'seq-dangling' });

    await db.sequenceLink.create({
      data: {
        userId: mine.owner.id,
        versionId: 'version-that-was-deleted',
        nle: 'premiere',
        sequenceId: 'seq-dangling',
        sequenceName: 'Reel 1',
        startTimecode: '01:00:00:00',
        frameRateNum: 24,
        frameRateDen: 1,
        dropFrame: false,
        updatedAt: new Date(Date.now() + 60_000),
      },
    });

    const rows = await db.sequenceLink.findMany({
      where: { userId: mine.owner.id, sequenceId: 'seq-dangling' },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    expect(rows[0]?.versionId).toBe('version-that-was-deleted');

    const response = await callRoute(
      lookupSequenceLink,
      apiRequest(lookupUrl({ nle: 'premiere', sequenceId: 'seq-dangling' }), {
        headers: { authorization: `Bearer ${token}` },
      }),
      {}
    );
    expect(response.status).toBe(200);
    expect((await readData<LookupBody>(response)).link?.versionId).toBe(mine.version.id);
  });

  it('leaves a stored sequence id alone when a later sync omits one', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);
    await bind(scenario.version.id);

    const withoutId = { ...PUT_BODY };
    delete (withoutId as Partial<typeof PUT_BODY>).sequenceId;
    const response = await callRoute(
      putSequenceLink,
      apiRequest(`/api/v1/versions/${scenario.version.id}/sequence-link`, {
        method: 'PUT',
        body: { ...withoutId, sequenceName: 'Reel 1 renamed' },
      }),
      { versionId: scenario.version.id }
    );
    expect(response.status).toBe(200);

    const stored = await db.sequenceLink.findFirst({ where: { versionId: scenario.version.id } });
    expect(stored?.sequenceId).toBe('seq-original');
    expect(stored?.sequenceName).toBe('Reel 1 renamed');
  });
});
