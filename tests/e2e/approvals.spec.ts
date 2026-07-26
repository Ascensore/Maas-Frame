// Two users, two browser contexts: the project owner asks for approval and a
// project member grants it. Both sides then have to agree on what happened.
import { test, expect, storageStateFor } from './fixtures';

test('an approval request is raised by the owner and approved by a member', async ({
  page,
  browser,
  playwright,
  baseURL,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser);
  const approver = await seed.user({ name: 'Approving Member' });
  await seed.member(seeded.project.id, approver.id, 'COMMENTATOR');

  const videoUrl = `/projects/${seeded.project.id}/videos/${seeded.videoId}`;

  // --- the owner raises the request ---------------------------------------
  await page.goto(videoUrl);

  await page.getByRole('button', { name: 'Approvals' }).click();
  const panel = page.getByRole('dialog', { name: 'Approvals' });
  await expect(panel.getByText('No approval requests yet.')).toBeVisible();

  await panel.getByRole('button', { name: 'Request Approval' }).click();

  const dialog = page.getByRole('dialog', { name: 'Request Approval' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: new RegExp(approver.email ?? '') }).click();
  await expect(dialog.getByText('Approvers (1 selected)')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create Request' }).click();
  await expect(dialog).toHaveCount(0);

  // The sheet is still open behind the dialog, so there is nothing to reopen.
  // The owner sees a pending request and can withdraw it, but cannot decide it:
  // the owner is not on the approver list.
  await expect(panel.getByText('1 request(s)')).toBeVisible();
  // Exact, because `getByText('Pending')` is a case-insensitive substring match
  // and the sheet also carries "respond to pending approvals" and a "Cancel
  // Pending Request" button. What is left is the two labels this assertion is
  // actually about: the request's own status badge and the single approver's
  // decision row, both of which read Pending and nothing else.
  const pendingLabels = panel.getByText('Pending', { exact: true });
  await expect(pendingLabels).toHaveCount(2);
  await expect(pendingLabels.first()).toBeVisible();
  await expect(pendingLabels.last()).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Cancel Pending Request' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  // --- the member approves it ---------------------------------------------
  const approverState = await storageStateFor(
    playwright.request,
    baseURL ?? '',
    approver.email ?? ''
  );
  const approverContext = await browser.newContext({ baseURL, storageState: approverState });
  try {
    const approverPage = await approverContext.newPage();
    await approverPage.goto(videoUrl);

    await approverPage.getByRole('button', { name: 'Approvals' }).click();
    const approverPanel = approverPage.getByRole('dialog', { name: 'Approvals' });
    await expect(approverPanel.getByText('Your response is required')).toBeVisible();

    await approverPanel.getByPlaceholder('Optional note').fill('Looks good to me.');
    await approverPanel.getByRole('button', { name: 'Approve' }).click();

    // Same two labels as above, now flipped: the request badge and the
    // approver's own decision row.
    const approvedLabels = approverPanel.getByText('Approved', { exact: true });
    await expect(approvedLabels).toHaveCount(2);
    await expect(approvedLabels.first()).toBeVisible();
    await expect(approvedLabels.last()).toBeVisible();
    await expect(approverPanel.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  } finally {
    await approverContext.close();
  }

  // --- and the owner sees the decision ------------------------------------
  await page.reload();
  await page.getByRole('button', { name: 'Approvals' }).click();
  await expect(panel.getByText('Approved', { exact: true })).toHaveCount(2);
  // Exact again: the sheet description mentions pending approvals whatever the
  // state of the request, so an unanchored match can never reach zero.
  await expect(panel.getByText('Pending', { exact: true })).toHaveCount(0);
});
