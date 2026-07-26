// Create, rename, change visibility, delete. The dashboard list has to reflect
// every step, because that list is the one page every user sees first.
import { test, expect } from './fixtures';

test('a project can be created, renamed, made public and deleted', async ({
  page,
  seed,
  seededUser,
}) => {
  const stamp = Date.now();
  const originalName = `Lifecycle Project ${stamp}`;
  const renamed = `Lifecycle Renamed ${stamp}`;

  // A project needs a workspace; /projects/new offers nothing without one.
  const workspace = await seed.workspace(seededUser);

  // --- create -------------------------------------------------------------
  await page.goto('/dashboard');
  await page.getByRole('link', { name: 'New Project' }).click();

  await expect(page.getByText('Create New Project')).toBeVisible();

  // A single workspace is auto-selected by the page, so assert that rather than
  // driving a combobox that may not need driving.
  await expect(page.getByRole('combobox')).toContainText(workspace.name);

  await page.getByLabel('Project Name').fill(originalName);
  await page.getByRole('button', { name: 'Private' }).click();
  await page.getByRole('button', { name: 'Create Project' }).click();

  // The form itself lives at /projects/new, which also matches
  // `/projects/<segment>`, so the wait has to exclude that one segment by name.
  // Without the exclusion the URL is read while the form is still on screen and
  // `projectId` comes out as the literal string `new`, which sends every later
  // step to a project that does not exist.
  await expect(page).toHaveURL(/\/projects\/(?!new$)[^/]+$/);
  const projectId = new URL(page.url()).pathname.split('/').pop() ?? '';
  expect(projectId).not.toEqual('');
  await expect(page.getByRole('heading', { name: originalName })).toBeVisible();

  await page.goto('/dashboard');
  const card = page.getByRole('link', { name: new RegExp(originalName) });
  await expect(card).toBeVisible();
  await expect(card).toContainText('private');

  // --- rename and change visibility --------------------------------------
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByText('Project Settings')).toBeVisible();

  await page.getByLabel('Project Name').fill(renamed);
  // Anchored, because the download toggle on this page carries "On public
  // projects this includes unauthenticated visitors." in its accessible name and
  // an unanchored 'Public' would match both buttons.
  await page.getByRole('button', { name: /^Public/ }).click();
  await page.getByRole('button', { name: 'Save Changes' }).click();

  await expect(page.getByText('Project settings saved successfully')).toBeVisible();

  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: new RegExp(originalName) })).toHaveCount(0);
  const renamedCard = page.getByRole('link', { name: new RegExp(renamed) });
  await expect(renamedCard).toBeVisible();
  await expect(renamedCard).toContainText('public');

  // --- delete -------------------------------------------------------------
  await page.goto(`/projects/${projectId}/settings`);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: `Delete "${renamed}"?` })).toBeVisible();

  // The confirm button stays disabled until the name is typed exactly.
  const confirm = dialog.getByRole('button', { name: 'Delete Project' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/Type .* to confirm/).fill(renamed);
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('link', { name: new RegExp(renamed) })).toHaveCount(0);

  // Gone from the app, not just from the list.
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByText('Project Not Found')).toBeVisible();
});
