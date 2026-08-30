export type ReviewWatermarkViewer = {
  name?: string | null;
  email?: string | null;
  guestName?: string | null;
  guestIdentityId?: string | null;
};

export function reviewWatermarkLabel(viewer: ReviewWatermarkViewer): string {
  const name = viewer.name?.trim() || viewer.guestName?.trim() || '';
  const email = viewer.email?.trim() || '';
  if (name && email) return `${name} · ${email}`;
  if (email) return email;
  if (name) return name;
  const guestIdentityId = viewer.guestIdentityId?.trim() || '';
  if (guestIdentityId) return `Guest ${guestIdentityId.slice(0, 8)}`;
  return 'Guest';
}

export function reviewWatermarkForProject(
  watermarkReviews: boolean,
  viewer: ReviewWatermarkViewer
): string | null {
  if (!watermarkReviews) return null;
  return reviewWatermarkLabel(viewer);
}
