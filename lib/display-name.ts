/** First token of a display name, for compact chrome such as the sidebar. */
export function firstNameFromDisplayName(name: string | null | undefined): string | null {
  if (name == null) {
    return null;
  }

  const first = name.trim().split(/\s+/)[0];
  return first || null;
}
