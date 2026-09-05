import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { db } from '@/lib/db';
import { createFolder } from '../factories';
import { REPO_ROOT } from '../helpers/env';

test.use({ timezoneId: 'UTC', locale: 'en-US' });

test('uploads continue across edit folders, warn on reload, and clips and scripts can be managed', async ({
  page,
  seed,
  seededUser,
}) => {
  test.setTimeout(120_000);
  const { project } = await seed.project(seededUser);
  const folder = await createFolder({ projectId: project.id, name: 'Second session' });
  const bytes = await readFile(path.join(REPO_ROOT, 'tests/fixtures/sample.mp4'));
  let interceptedPuts = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.searchParams.has('X-Amz-Signature'),
    async (route) => {
      if (route.request().method() === 'PUT') {
        interceptedPuts += 1;
        await held;
      }
      await route.continue();
    }
  );
  try {
    await page.goto(`/projects/${project.id}/edit`);
    await page.getByLabel('Upload source files').setInputFiles([
      { name: 'Opening.mp4', mimeType: 'video/mp4', buffer: bytes },
      { name: 'Closing.mp4', mimeType: 'video/mp4', buffer: bytes },
    ]);
    await expect.poll(() => interceptedPuts).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Continue editing' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Second session', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`folder=${folder.id}`));
    await expect(page.getByRole('button', { name: 'View uploads' })).toBeVisible();
    // A reload really would discard the browser's File objects: refusal must retain the queue.
    const warning = page.waitForEvent('dialog');
    const reload = page.reload().catch(() => null);
    const dialog = await warning;
    expect(dialog.type()).toBe('beforeunload');
    await dialog.dismiss();
    await reload;
    await expect(page.getByRole('button', { name: 'View uploads' })).toBeVisible();
    release();
    await expect.poll(() => db.video.count({ where: { projectId: project.id } })).toBe(2);
    const videos = await db.video.findMany({
      where: { projectId: project.id },
      orderBy: { title: 'asc' },
    });
    expect(videos.map((video) => ({ title: video.title, folderId: video.folderId }))).toEqual([
      { title: 'Closing', folderId: null },
      { title: 'Opening', folderId: null },
    ]);
    expect(interceptedPuts).toBeGreaterThanOrEqual(2);
    await page
      .getByLabel('Project script', { exact: true })
      .fill('Keep the opening promise and the closing call to action.');
    await page.getByRole('button', { name: 'Save script', exact: true }).click();
    await expect(page.getByText('Saved · shared with project editors')).toBeVisible();
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Project root', exact: true }).click();
    await expect(page.getByLabel('Project script', { exact: true })).toHaveValue(
      'Keep the opening promise and the closing call to action.'
    );
    await expect(
      page.getByRole('columnheader', { name: 'Recorded at', exact: true })
    ).toBeVisible();
    // Simulate the worker completing after the upload, then observe polling without a reload.
    const opening = videos.find((video) => video.title === 'Opening')!;
    const version = await db.videoVersion.findFirstOrThrow({
      where: { videoParentId: opening.id },
    });
    await db.videoVersion.update({
      where: { id: version.id },
      data: { recordedAt: new Date('2026-03-15T13:22:01Z') },
    });
    await db.mediaJob.updateMany({
      where: { versionId: version.id, kind: 'PROBE_MEDIA' },
      data: { status: 'SUCCEEDED' },
    });
    await expect(
      page
        .getByRole('row')
        .filter({ hasText: 'Opening' })
        .getByRole('cell', { name: '3/15/2026, 1:22:01 PM', exact: true })
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('edit-workspace.png'), fullPage: true });
    await page.getByRole('checkbox', { name: 'Select all clips' }).check();
    await page.getByRole('button', { name: 'Remove selected (2)' }).click();
    await page.getByRole('button', { name: 'Keep clips', exact: true }).click();
    expect(await db.video.count({ where: { projectId: project.id } })).toBe(2);
    await page.getByRole('button', { name: 'Remove selected (2)' }).click();
    await page.getByRole('button', { name: 'Remove clips', exact: true }).click();
    await expect.poll(() => db.video.count({ where: { projectId: project.id } })).toBe(0);
    await expect(page.getByText('No file-backed clips in this folder yet.')).toBeVisible();
  } finally {
    release();
  }
});
