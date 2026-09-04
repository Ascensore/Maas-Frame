// The only spec in the `mobile-chrome` project (see playwright.config.ts).
// A smoke test, not a second full pass: the navigation opens, the project list
// renders, and the page does not scroll sideways.
import { test, expect } from './fixtures';

test('the dashboard is usable on a phone viewport', async ({ page, seed, seededUser }) => {
  const seeded = await seed.project(seededUser, { name: `Mobile Project ${Date.now()}` });

  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(seeded.project.name) })).toBeVisible();

  // No horizontal scroll. A single overflowing element makes the whole page pan,
  // which is the most common way a responsive layout breaks.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  // The desktop nav is collapsed behind the sheet trigger on this viewport.
  await expect(page.getByRole('link', { name: 'Workspaces' })).toHaveCount(0);

  await expect(page.getByRole('button', { name: 'Account menu' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Toggle menu' }).click();

  const menu = page.getByRole('dialog', { name: 'Navigation Menu' });
  await expect(menu.getByRole('link', { name: 'Projects' })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Workspaces' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Account menu' })).toBeVisible();

  await menu.getByRole('link', { name: 'Workspaces' }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
});
