import { describe, expect, it } from 'vitest';
import { GET as listTokens, POST as createToken } from '@/app/api/settings/api-tokens/route';
import { DELETE as revokeToken } from '@/app/api/settings/api-tokens/[tokenId]/route';
import { GET as listV1Projects } from '@/app/api/v1/projects/route';
import {
  GET as listV1Comments,
  POST as createV1Comment,
} from '@/app/api/v1/versions/[versionId]/comments/route';
import { db } from '@/lib/db';
import { hashApiToken } from '@/lib/api-token';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  createProject,
  createUser,
  createVersion,
  createVideo,
  createWorkspace,
} from '../factories';

async function seedOwnedVersion() {
  const user = await createUser();
  const workspace = await createWorkspace({ ownerId: user.id });
  const project = await createProject({ ownerId: user.id, workspaceId: workspace.id });
  const video = await createVideo({ projectId: project.id });
  const version = await createVersion({ videoParentId: video.id, duration: 60 });
  return { user, project, version };
}

describe('API tokens', () => {
  it('refuses an anonymous caller', async () => {
    signedOut();
    const response = await callRoute(listTokens, apiRequest('/api/settings/api-tokens'));
    expect(response.status).toBe(401);
  });

  it('creates a token, returns the secret once, and authenticates v1 with it', async () => {
    const { user, project, version } = await seedOwnedVersion();
    signedInAs(user);

    const created = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', { method: 'POST', body: { name: 'panel' } })
    );
    expect(created.status).toBe(201);
    const payload = await readData<{ token: { id: string; secret: string; tokenPrefix: string } }>(
      created
    );
    expect(payload.token.secret.startsWith('of_live_')).toBe(true);

    const listed = await callRoute(listTokens, apiRequest('/api/settings/api-tokens'));
    const listedData = await readData<{ tokens: Array<{ id: string; tokenPrefix: string }> }>(
      listed
    );
    expect(listedData.tokens).toHaveLength(1);
    expect(listedData.tokens[0].tokenPrefix).toBe(payload.token.tokenPrefix);

    signedOut();
    const v1 = await callRoute(
      listV1Projects,
      apiRequest('/api/v1/projects', {
        headers: { authorization: `Bearer ${payload.token.secret}` },
      })
    );
    expect(v1.status).toBe(200);
    const projects = await readData<{ projects: Array<{ id: string }> }>(v1);
    expect(projects.projects.map((row) => row.id)).toContain(project.id);

    const commentRes = await callRoute(
      createV1Comment,
      apiRequest(`/api/v1/versions/${version.id}/comments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${payload.token.secret}` },
        body: { content: 'From the panel', timestamp: 1.25 },
      }),
      { versionId: version.id }
    );
    expect(commentRes.status).toBe(201);

    const listedComments = await callRoute(
      listV1Comments,
      apiRequest(`/api/v1/versions/${version.id}/comments`, {
        headers: { authorization: `Bearer ${payload.token.secret}` },
      }),
      { versionId: version.id }
    );
    expect(listedComments.status).toBe(200);
    const comments = await readData<{ comments: Array<{ content: string | null }> }>(
      listedComments
    );
    expect(comments.comments.some((row) => row.content === 'From the panel')).toBe(true);

    signedInAs(user);
    const revoked = await callRoute(
      revokeToken,
      apiRequest(`/api/settings/api-tokens/${payload.token.id}`, { method: 'DELETE' }),
      { tokenId: payload.token.id }
    );
    expect(revoked.status).toBe(200);

    signedOut();
    const afterRevoke = await callRoute(
      listV1Projects,
      apiRequest('/api/v1/projects', {
        headers: { authorization: `Bearer ${payload.token.secret}` },
      })
    );
    expect(afterRevoke.status).toBe(401);

    const stored = await db.apiToken.findUnique({ where: { id: payload.token.id } });
    expect(stored?.tokenHash).toBe(hashApiToken(payload.token.secret));
    expect(stored?.revokedAt).not.toBeNull();
  });

  it('does not mint a token with an empty name', async () => {
    const user = await createUser();
    signedInAs(user);
    const response = await callRoute(
      createToken,
      apiRequest('/api/settings/api-tokens', { method: 'POST', body: { name: '   ' } })
    );
    expect(response.status).toBe(400);
    expect(await readError(response)).toMatch(/name/i);
  });
});
