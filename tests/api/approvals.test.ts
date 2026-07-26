import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  GET as listApprovals,
  POST as requestApproval,
} from '@/app/api/versions/[versionId]/approvals/route';
import { POST as decideApproval } from '@/app/api/approvals/[requestId]/decision/route';
import { POST as cancelApproval } from '@/app/api/approvals/[requestId]/cancel/route';
import { GET as listCandidates } from '@/app/api/projects/[projectId]/approval-candidates/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createApprovalRequest,
  createUser,
  seedVersion,
} from '../factories';

function approvalsUrl(versionId: string): string {
  return `/api/versions/${versionId}/approvals`;
}

describe('GET /api/projects/[projectId]/approval-candidates', () => {
  it('returns 401 without a session', async () => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      listCandidates,
      apiRequest(`/api/projects/${scenario.project.id}/approval-candidates`),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 for a COMMENTATOR, who cannot request approvals', async () => {
    const scenario = await seedVersion();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      listCandidates,
      apiRequest(`/api/projects/${scenario.project.id}/approval-candidates`),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
  });

  it('lists the project owner, project members, workspace owner and workspace members once each', async () => {
    const scenario = await seedVersion();
    const projectMember = await createUser({ name: 'Bianca' });
    const workspaceMember = await createUser({ name: 'Cleo' });
    const both = await createUser({ name: 'Dana' });
    await addProjectMember({ projectId: scenario.project.id, userId: projectMember.id });
    await addWorkspaceMember({ workspaceId: scenario.workspace.id, userId: workspaceMember.id });
    await addProjectMember({ projectId: scenario.project.id, userId: both.id });
    await addWorkspaceMember({ workspaceId: scenario.workspace.id, userId: both.id });
    signedInAs(scenario.owner);

    const payload = await readData<{ candidates: Array<{ id: string }> }>(
      await callRoute(
        listCandidates,
        apiRequest(`/api/projects/${scenario.project.id}/approval-candidates`),
        { projectId: scenario.project.id }
      )
    );

    const ids = payload.candidates.map((entry) => entry.id).sort();
    expect(ids).toEqual([scenario.owner.id, projectMember.id, workspaceMember.id, both.id].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('POST /api/versions/[versionId]/approvals', () => {
  it('returns 401 without a session', async () => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      requestApproval,
      apiRequest(approvalsUrl(scenario.version.id), { body: { approverIds: ['x'] } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(401);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('returns 404 for an unknown version', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(
      requestApproval,
      apiRequest(approvalsUrl('nope'), { body: { approverIds: ['x'] } }),
      { versionId: 'nope' }
    );

    expect(response.status).toBe(404);
  });

  it('returns 403 for a COMMENTATOR', async () => {
    const scenario = await seedVersion();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      requestApproval,
      apiRequest(approvalsUrl(scenario.version.id), {
        body: { approverIds: [scenario.owner.id] },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it.each([
    [{}, 'no approverIds at all'],
    [{ approverIds: [] }, 'an empty approver list'],
    [{ approverIds: 'not-an-array' }, 'a non-array approverIds'],
    [{ approverIds: ['', '   '] }, 'blank approver ids'],
    [{ approverIds: [42, null] }, 'non-string approver ids'],
  ])('rejects %j with 400 (%s)', async (body, label) => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      requestApproval,
      apiRequest(approvalsUrl(scenario.version.id), { body }),
      { versionId: scenario.version.id }
    );

    expect(response.status, label).toBe(400);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('rejects a message longer than 2000 characters', async () => {
    const scenario = await seedVersion();
    const approver = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
    signedInAs(scenario.owner);

    const response = await callRoute(
      requestApproval,
      apiRequest(approvalsUrl(scenario.version.id), {
        body: { approverIds: [approver.id], message: 'x'.repeat(2001) },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('refuses to let the requester approve their own request', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);

    const response = await callRoute(
      requestApproval,
      apiRequest(approvalsUrl(scenario.version.id), {
        body: { approverIds: [scenario.owner.id] },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  // The candidate set is derived from project and workspace membership. Anyone
  // outside it cannot be nominated, which is what stops an arbitrary user id
  // being written into approval_decisions.
  it('refuses an approver who is not a candidate for the project', async () => {
    const scenario = await seedVersion();
    const outsider = await createUser();
    signedInAs(scenario.owner);

    const response = await callRoute(
      requestApproval,
      apiRequest(approvalsUrl(scenario.version.id), { body: { approverIds: [outsider.id] } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.approvalDecision.count()).toBe(0);
  });

  it('creates the request with one PENDING decision per de-duplicated approver', async () => {
    const scenario = await seedVersion();
    const first = await createUser();
    const second = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: first.id });
    await addWorkspaceMember({ workspaceId: scenario.workspace.id, userId: second.id });
    signedInAs(scenario.owner);

    const response = await callRoute(
      requestApproval,
      apiRequest(approvalsUrl(scenario.version.id), {
        body: {
          approverIds: [first.id, ` ${first.id} `, second.id],
          message: '  please review  ',
        },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const stored = await db.approvalRequest.findFirstOrThrow({ include: { decisions: true } });
    expect(stored.status).toBe('PENDING');
    expect(stored.requestedById).toBe(scenario.owner.id);
    expect(stored.message).toBe('please review');
    expect(stored.resolvedAt).toBeNull();
    expect(stored.decisions).toHaveLength(2);
    expect(stored.decisions.map((entry) => entry.approverId).sort()).toEqual(
      [first.id, second.id].sort()
    );
    expect(stored.decisions.every((entry) => entry.status === 'PENDING')).toBe(true);
    expect(stored.decisions.every((entry) => entry.respondedAt === null)).toBe(true);
  });

  it('returns 409 when a request is already pending on the version', async () => {
    const scenario = await seedVersion();
    const approver = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
    await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [approver.id],
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      requestApproval,
      apiRequest(approvalsUrl(scenario.version.id), { body: { approverIds: [approver.id] } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(409);
    expect(await db.approvalRequest.count()).toBe(1);
  });

  it('allows a new request once the previous one is resolved', async () => {
    const scenario = await seedVersion();
    const approver = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
    await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [approver.id],
      status: 'REJECTED',
      resolvedAt: new Date(),
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      requestApproval,
      apiRequest(approvalsUrl(scenario.version.id), { body: { approverIds: [approver.id] } }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    expect(await db.approvalRequest.count()).toBe(2);
  });
});

describe('GET /api/versions/[versionId]/approvals', () => {
  it('returns 403 for a signed-in stranger even on a PUBLIC project', async () => {
    const scenario = await seedVersion({ visibility: 'PUBLIC' });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(listApprovals, apiRequest(approvalsUrl(scenario.version.id)), {
      versionId: scenario.version.id,
    });

    // hasMembership is required, not just hasAccess, so a public project does
    // not expose its approval history to passers-by.
    expect(response.status).toBe(403);
  });

  it('lists requests newest first for a COMMENTATOR member', async () => {
    const scenario = await seedVersion();
    const approver = await createUser();
    const commentator = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    const older = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [approver.id],
      status: 'CANCELED',
      canceledAt: new Date(),
    });
    const newer = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [approver.id],
    });
    signedInAs(commentator);

    const payload = await readData<{ requests: Array<{ id: string }> }>(
      await callRoute(listApprovals, apiRequest(approvalsUrl(scenario.version.id)), {
        versionId: scenario.version.id,
      })
    );

    expect(payload.requests.map((entry) => entry.id)).toEqual([newer.id, older.id]);
  });
});

describe('POST /api/approvals/[requestId]/decision', () => {
  it('returns 401 without a session', async () => {
    const scenario = await seedVersion();
    const approver = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [approver.id],
    });
    signedOut();

    const response = await callRoute(
      decideApproval,
      apiRequest(`/api/approvals/${request.id}/decision`, { body: { decision: 'APPROVED' } }),
      { requestId: request.id }
    );

    expect(response.status).toBe(401);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe(
      'PENDING'
    );
  });

  it.each([['MAYBE'], [''], ['approved'], [null]])(
    'returns 400 for the decision %s',
    async (decision) => {
      const scenario = await seedVersion();
      const approver = await createUser();
      await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
      const request = await createApprovalRequest({
        versionId: scenario.version.id,
        requestedById: scenario.owner.id,
        approverIds: [approver.id],
      });
      signedInAs(approver);

      const response = await callRoute(
        decideApproval,
        apiRequest(`/api/approvals/${request.id}/decision`, { body: { decision } }),
        { requestId: request.id }
      );

      expect(response.status).toBe(400);
      expect(
        (await db.approvalDecision.findFirstOrThrow({ where: { requestId: request.id } })).status
      ).toBe('PENDING');
    }
  );

  // The core negative case for this route: having access to the project is not
  // the same as being nominated on the request.
  it('returns 403 for a project member who is not an approver on the request', async () => {
    const scenario = await seedVersion();
    const approver = await createUser();
    const bystander = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
    await addProjectMember({ projectId: scenario.project.id, userId: bystander.id });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [approver.id],
    });
    signedInAs(bystander);

    const response = await callRoute(
      decideApproval,
      apiRequest(`/api/approvals/${request.id}/decision`, { body: { decision: 'APPROVED' } }),
      { requestId: request.id }
    );

    expect(response.status).toBe(403);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe(
      'PENDING'
    );
    expect(await db.approvalDecision.count({ where: { status: 'APPROVED' } })).toBe(0);
  });

  it('returns 403 for the project owner who requested it but is not an approver', async () => {
    const scenario = await seedVersion();
    const approver = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [approver.id],
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      decideApproval,
      apiRequest(`/api/approvals/${request.id}/decision`, { body: { decision: 'APPROVED' } }),
      { requestId: request.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 for an approver who has lost project access', async () => {
    const scenario = await seedVersion();
    const approver = await createUser();
    const membership = await addProjectMember({
      projectId: scenario.project.id,
      userId: approver.id,
    });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [approver.id],
    });
    await db.projectMember.delete({ where: { id: membership.id } });
    signedInAs(approver);

    const response = await callRoute(
      decideApproval,
      apiRequest(`/api/approvals/${request.id}/decision`, { body: { decision: 'APPROVED' } }),
      { requestId: request.id }
    );

    expect(response.status).toBe(403);
  });

  it('keeps the request PENDING while other approvers have not answered', async () => {
    const scenario = await seedVersion();
    const first = await createUser();
    const second = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: first.id });
    await addProjectMember({ projectId: scenario.project.id, userId: second.id });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [first.id, second.id],
    });
    signedInAs(first);

    const response = await callRoute(
      decideApproval,
      apiRequest(`/api/approvals/${request.id}/decision`, {
        body: { decision: 'APPROVED', note: '  looks good  ' },
      }),
      { requestId: request.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.approvalRequest.findUniqueOrThrow({
      where: { id: request.id },
      include: { decisions: true },
    });
    expect(stored.status).toBe('PENDING');
    expect(stored.resolvedAt).toBeNull();

    const mine = stored.decisions.find((entry) => entry.approverId === first.id)!;
    expect(mine.status).toBe('APPROVED');
    expect(mine.note).toBe('looks good');
    expect(mine.respondedAt).toBeInstanceOf(Date);
    expect(stored.decisions.find((entry) => entry.approverId === second.id)?.status).toBe(
      'PENDING'
    );
  });

  it('resolves the request as APPROVED once the last approver approves', async () => {
    const scenario = await seedVersion();
    const first = await createUser();
    const second = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: first.id });
    await addProjectMember({ projectId: scenario.project.id, userId: second.id });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [first.id, second.id],
    });

    signedInAs(first);
    await callRoute(
      decideApproval,
      apiRequest(`/api/approvals/${request.id}/decision`, { body: { decision: 'APPROVED' } }),
      { requestId: request.id }
    );
    signedInAs(second);
    const response = await callRoute(
      decideApproval,
      apiRequest(`/api/approvals/${request.id}/decision`, { body: { decision: 'APPROVED' } }),
      { requestId: request.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(stored.status).toBe('APPROVED');
    expect(stored.resolvedAt).toBeInstanceOf(Date);
  });

  it('resolves the request as REJECTED on a single rejection', async () => {
    const scenario = await seedVersion();
    const first = await createUser();
    const second = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: first.id });
    await addProjectMember({ projectId: scenario.project.id, userId: second.id });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [first.id, second.id],
    });
    signedInAs(first);

    const response = await callRoute(
      decideApproval,
      apiRequest(`/api/approvals/${request.id}/decision`, { body: { decision: 'REJECTED' } }),
      { requestId: request.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.approvalRequest.findUniqueOrThrow({
      where: { id: request.id },
      include: { decisions: true },
    });
    expect(stored.status).toBe('REJECTED');
    expect(stored.resolvedAt).toBeInstanceOf(Date);
    // The second approver's row is left PENDING; the request is already decided.
    expect(stored.decisions.find((entry) => entry.approverId === second.id)?.status).toBe(
      'PENDING'
    );
  });

  it('returns 409 when the same approver answers twice', async () => {
    const scenario = await seedVersion();
    const first = await createUser();
    const second = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: first.id });
    await addProjectMember({ projectId: scenario.project.id, userId: second.id });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [first.id, second.id],
    });
    signedInAs(first);

    await callRoute(
      decideApproval,
      apiRequest(`/api/approvals/${request.id}/decision`, { body: { decision: 'APPROVED' } }),
      { requestId: request.id }
    );
    const second_attempt = await callRoute(
      decideApproval,
      apiRequest(`/api/approvals/${request.id}/decision`, { body: { decision: 'REJECTED' } }),
      { requestId: request.id }
    );

    expect(second_attempt.status).toBe(409);
    expect(
      (
        await db.approvalDecision.findFirstOrThrow({
          where: { requestId: request.id, approverId: first.id },
        })
      ).status
    ).toBe('APPROVED');
  });

  it.each([['APPROVED'], ['REJECTED'], ['CANCELED']] as const)(
    'returns 409 for a request already in the terminal status %s',
    async (status) => {
      const scenario = await seedVersion();
      const approver = await createUser();
      await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
      const request = await createApprovalRequest({
        versionId: scenario.version.id,
        requestedById: scenario.owner.id,
        approverIds: [approver.id],
        status,
        resolvedAt: new Date(),
      });
      signedInAs(approver);

      const response = await callRoute(
        decideApproval,
        apiRequest(`/api/approvals/${request.id}/decision`, { body: { decision: 'APPROVED' } }),
        { requestId: request.id }
      );

      expect(response.status).toBe(409);
      expect(
        (await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).status
      ).toBe(status);
    }
  );
});

describe('POST /api/approvals/[requestId]/cancel', () => {
  it('returns 401 without a session', async () => {
    const scenario = await seedVersion();
    const approver = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [approver.id],
    });
    signedOut();

    const response = await callRoute(
      cancelApproval,
      apiRequest(`/api/approvals/${request.id}/cancel`, { method: 'POST', body: {} }),
      { requestId: request.id }
    );

    expect(response.status).toBe(401);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe(
      'PENDING'
    );
  });

  it('returns 404 for an unknown request', async () => {
    const user = await createUser();
    signedInAs(user);

    const response = await callRoute(
      cancelApproval,
      apiRequest('/api/approvals/nope/cancel', { method: 'POST', body: {} }),
      { requestId: 'nope' }
    );

    expect(response.status).toBe(404);
  });

  // The nominated approver is not the requester and has no canEdit, so it
  // cannot cancel the request out from under the person who asked for it.
  it('returns 403 for the nominated approver', async () => {
    const scenario = await seedVersion();
    const approver = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: approver.id,
      role: 'COMMENTATOR',
    });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [approver.id],
    });
    signedInAs(approver);

    const response = await callRoute(
      cancelApproval,
      apiRequest(`/api/approvals/${request.id}/cancel`, { method: 'POST', body: {} }),
      { requestId: request.id }
    );

    expect(response.status).toBe(403);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe(
      'PENDING'
    );
  });

  it('returns 403 for a signed-in stranger', async () => {
    const scenario = await seedVersion();
    const approver = await createUser();
    await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: scenario.owner.id,
      approverIds: [approver.id],
    });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      cancelApproval,
      apiRequest(`/api/approvals/${request.id}/cancel`, { method: 'POST', body: {} }),
      { requestId: request.id }
    );

    expect(response.status).toBe(403);
  });

  it('lets the requester cancel and records who did it', async () => {
    const scenario = await seedVersion();
    const requester = await createUser();
    const approver = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: requester.id,
      role: 'ADMIN',
    });
    await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: requester.id,
      approverIds: [approver.id],
    });
    signedInAs(requester);

    const response = await callRoute(
      cancelApproval,
      apiRequest(`/api/approvals/${request.id}/cancel`, { method: 'POST', body: {} }),
      { requestId: request.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(stored.status).toBe('CANCELED');
    expect(stored.canceledById).toBe(requester.id);
    expect(stored.canceledAt).toBeInstanceOf(Date);
  });

  it('lets a project ADMIN cancel a request somebody else made', async () => {
    const scenario = await seedVersion();
    const requester = await createUser();
    const admin = await createUser();
    const approver = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: requester.id,
      role: 'ADMIN',
    });
    await addProjectMember({ projectId: scenario.project.id, userId: admin.id, role: 'ADMIN' });
    await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
    const request = await createApprovalRequest({
      versionId: scenario.version.id,
      requestedById: requester.id,
      approverIds: [approver.id],
    });
    signedInAs(admin);

    const response = await callRoute(
      cancelApproval,
      apiRequest(`/api/approvals/${request.id}/cancel`, { method: 'POST', body: {} }),
      { requestId: request.id }
    );

    expect(response.status).toBe(200);
    expect(
      (await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).canceledById
    ).toBe(admin.id);
  });

  it.each([['APPROVED'], ['REJECTED'], ['CANCELED']] as const)(
    'returns 409 for a request already %s',
    async (status) => {
      const scenario = await seedVersion();
      const approver = await createUser();
      await addProjectMember({ projectId: scenario.project.id, userId: approver.id });
      const request = await createApprovalRequest({
        versionId: scenario.version.id,
        requestedById: scenario.owner.id,
        approverIds: [approver.id],
        status,
        resolvedAt: new Date(),
      });
      signedInAs(scenario.owner);

      const response = await callRoute(
        cancelApproval,
        apiRequest(`/api/approvals/${request.id}/cancel`, { method: 'POST', body: {} }),
        { requestId: request.id }
      );

      expect(response.status).toBe(409);
      const stored = await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(stored.status).toBe(status);
      expect(stored.canceledById).toBeNull();
    }
  );
});
