// Commenting on a version.
//
// One deliberate limitation, stated here rather than papered over. The seeded
// version uses the `youtube` provider, so the playhead lives inside a YouTube
// iframe. Whether that iframe loads depends on the container reaching
// youtube.com, and a spec that only means something with internet access is a
// spec that fails in a sealed CI runner. So nothing here moves the playhead:
// every comment is left at 0:00 and asserted at 0:00, which is true in both
// environments.
//
// The consequence is that "the timecode links back to the right frame" is
// verified only as far as the control existing, carrying the captured time and
// being clickable. Verifying a seek needs a decodable media file behind a real
// object-storage version, which is video-upload.spec.ts's territory.
import { test, expect } from './fixtures';

test('a comment is posted and rendered with its author and timecode', async ({
  page,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser);
  const body = `Colour grade looks warm ${Date.now()}`;

  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);

  const composer = page.getByPlaceholder('Add a comment...');
  await expect(composer).toBeVisible();
  await expect(page.getByText('No comments yet')).toBeVisible();

  await composer.fill(body);
  // The send button is an icon with no accessible name. Cmd/Ctrl+Enter is the
  // documented shortcut and the composer prints it under the field.
  await composer.press('Control+Enter');

  await expect(page.getByText(body)).toBeVisible();
  await expect(page.getByText(seededUser.name ?? '')).toBeVisible();
  await expect(page.getByText('No comments yet')).toHaveCount(0);

  // Every comment carries a jump-to-timestamp control, and the playhead is at
  // the start because the player never initialised (see the note above).
  const timecode = page.getByTitle('Jump to this timestamp');
  await expect(timecode).toBeVisible();
  await expect(timecode).toContainText('0:00');
  await timecode.click();

  // Survives a reload, i.e. it was persisted and not only inserted optimistically.
  await page.reload();
  await expect(page.getByText(body)).toBeVisible();
});

test('an annotation drawn on the video is stored with the comment', async ({
  page,
  seed,
  seededUser,
}) => {
  const seeded = await seed.version(seededUser);
  const body = `Fix this edge ${Date.now()}`;

  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
  await expect(page.getByPlaceholder('Add a comment...')).toBeVisible();

  await page.getByTitle('Draw annotation on video').click();

  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  // A stroke is only committed with at least two points, so there has to be a
  // move between the press and the release, and it has to stay inside the box
  // (leaving the canvas commits the stroke early).
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByText('Annotation attached')).toBeVisible();

  const composer = page.getByPlaceholder('Add a comment...');
  await composer.fill(body);
  await composer.press('Control+Enter');

  await expect(page.getByText(body)).toBeVisible();
  await expect(page.getByText('Annotated')).toBeVisible();

  await page.reload();
  await expect(page.getByText(body)).toBeVisible();
  await expect(page.getByText('Annotated')).toBeVisible();
});

test('a comment can be replied to and resolved', async ({ page, seed, seededUser }) => {
  const seeded = await seed.version(seededUser);
  const original = `Needs a tighter cut ${Date.now()}`;
  const reply = `Agreed, trimming it ${Date.now()}`;

  await seed.comment({
    versionId: seeded.versionId,
    authorId: seededUser.id,
    content: original,
    timestamp: 0,
  });

  await page.goto(`/projects/${seeded.project.id}/videos/${seeded.videoId}`);
  await expect(page.getByText(original)).toBeVisible();

  // --- reply --------------------------------------------------------------
  await page.getByRole('button', { name: 'Reply' }).click();
  const replyBox = page.getByPlaceholder('Write a reply...');
  await expect(replyBox).toBeVisible();
  await replyBox.fill(reply);
  await replyBox.press('Control+Enter');

  await expect(page.getByText(reply)).toBeVisible();

  // --- resolve ------------------------------------------------------------
  // The resolve control is the unnamed icon button that sits beside the
  // timecode in the comment's own header row.
  await page
    .getByTitle('Jump to this timestamp')
    .locator('xpath=following-sibling::button[1]')
    .click();

  // Resolved comments drop out of the default list.
  await expect(page.getByText(original)).toHaveCount(0);

  // And come back when the filter asks for them.
  await page.getByRole('button', { name: 'Resolved' }).click();
  await expect(page.getByText(original)).toBeVisible();
});
