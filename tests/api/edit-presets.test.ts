import { describe, it, expect } from 'vitest';
import { listEditPresets } from '@/lib/comment-edit/library';
import { db } from '@/lib/db';
import { POST, PATCH, DELETE } from '@/app/api/workspaces/[workspaceId]/edit-presets/route';
import { seedProject, createUser } from '../factories';
import { signedInAs, signedOut } from '../helpers/session';
import { apiRequest, callRoute, readData } from '../helpers/request';
const definition = {
  name: 'Brand',
  template: 'lower-third',
  accent: '#123456',
  foreground: '#FFFFFF',
  background: '#000000',
  font: 'Roboto',
  titleSize: 60,
};
const call = (workspaceId: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown) =>
  callRoute(
    { POST, PATCH, DELETE }[method],
    apiRequest('/api/workspaces/' + workspaceId + '/edit-presets', { method, body }),
    { workspaceId }
  );
describe('workspace graphic presets', () => {
  it('bounds the active library and reuses an archived slot', async () => {
    const s = await seedProject();
    signedInAs(s.owner);
    await db.editPreset.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        workspaceId: s.workspace.id,
        name: 'Preset ' + i,
        definition,
      })),
    });
    expect((await call(s.workspace.id, 'POST', definition)).status).toBe(409);
    expect(await db.editPreset.count({ where: { workspaceId: s.workspace.id } })).toBe(50);
    const row = await db.editPreset.findFirstOrThrow({ where: { workspaceId: s.workspace.id } });
    expect((await call(s.workspace.id, 'DELETE', { id: row.id, revision: 1 })).status).toBe(200);
    expect((await call(s.workspace.id, 'POST', definition)).status).toBe(201);
    const library = await listEditPresets(s.project.id);
    expect(library).toHaveLength(52);
    expect(library.some((p) => p.id === row.id)).toBe(false);
  });
  it.each(['POST', 'PATCH', 'DELETE'] as const)(
    'refuses anonymous and unauthorized %s without changing rows',
    async (method) => {
      const s = await seedProject();
      const row = await db.editPreset.create({
        data: { workspaceId: s.workspace.id, name: 'Brand', definition },
      });
      const body = { ...definition, id: row.id, revision: 1 };
      signedOut();
      expect((await call(s.workspace.id, method, body)).status).toBe(401);
      signedInAs(await createUser());
      expect((await call(s.workspace.id, method, body)).status).toBe(403);
      expect(await db.editPreset.findUnique({ where: { id: row.id } })).toEqual(row);
      expect(await db.editPreset.count({ where: { workspaceId: s.workspace.id } })).toBe(1);
    }
  );
  it('creates, updates with a revision guard, and archives without deleting', async () => {
    const s = await seedProject();
    signedInAs(s.owner);
    const response = await call(s.workspace.id, 'POST', definition);
    expect(response.status).toBe(201);
    const { preset } = await readData<{ preset: { id: string; version: number } }>(response);
    expect(await db.editPreset.findUnique({ where: { id: preset.id } })).toMatchObject({
      workspaceId: s.workspace.id,
      revision: 1,
      definition,
    });
    expect(
      (
        await call(s.workspace.id, 'PATCH', {
          ...definition,
          id: preset.id,
          revision: 1,
          name: 'New',
          accent: '#ABCDEF',
          font: 'Open Sans',
          template: 'title-card',
        })
      ).status
    ).toBe(200);
    expect(
      (
        await call(s.workspace.id, 'PATCH', {
          ...definition,
          id: preset.id,
          revision: 1,
          name: 'Stale',
        })
      ).status
    ).toBe(409);
    expect(await db.editPreset.findUnique({ where: { id: preset.id } })).toMatchObject({
      name: 'New',
      revision: 2,
      definition: {
        ...definition,
        name: 'New',
        accent: '#ABCDEF',
        font: 'Open Sans',
        template: 'title-card',
      },
    });
    expect((await call(s.workspace.id, 'DELETE', { id: preset.id, revision: 2 })).status).toBe(200);
    expect(await db.editPreset.findUnique({ where: { id: preset.id } })).toMatchObject({
      archived: true,
      revision: 3,
    });
  });
  it('does not mutate another workspace preset and rejects renderer syntax', async () => {
    const a = await seedProject();
    const b = await seedProject();
    const row = await db.editPreset.create({
      data: { workspaceId: b.workspace.id, name: 'Brand', definition },
    });
    signedInAs(a.owner);
    expect(
      (await call(a.workspace.id, 'PATCH', { ...definition, id: row.id, revision: 1 })).status
    ).toBe(409);
    expect((await call(a.workspace.id, 'DELETE', { id: row.id, revision: 1 })).status).toBe(409);
    expect(await db.editPreset.findUnique({ where: { id: row.id } })).toEqual(row);
    expect(
      (await call(a.workspace.id, 'POST', { ...definition, font: 'Roboto;movie=/tmp/a' })).status
    ).toBe(400);
    expect(await db.editPreset.count({ where: { workspaceId: a.workspace.id } })).toBe(0);
  });
});
