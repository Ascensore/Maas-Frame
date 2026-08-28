export const FOLDER_NAME_MAX = 100;
export const FOLDER_DEPTH_MAX = 32;

export type FolderParentLink = {
  id: string;
  parentId: string | null;
};

export function parseFolderName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > FOLDER_NAME_MAX) return null;
  return name;
}

export function depthOf(folderId: string, folders: FolderParentLink[]): number {
  const byId = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  let depth = 0;
  let current: string | null = folderId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) return depth;
    seen.add(current);
    depth += 1;
    current = byId.has(current) ? (byId.get(current) ?? null) : null;
  }
  return depth;
}

export function depthAfterMove(newParentId: string | null, folders: FolderParentLink[]): number {
  if (!newParentId) return 1;
  return depthOf(newParentId, folders) + 1;
}

/** Height of `folderId` including itself (a leaf is 1). */
export function subtreeHeight(folderId: string, folders: FolderParentLink[]): number {
  const childrenByParent = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const list = childrenByParent.get(folder.parentId) ?? [];
    list.push(folder.id);
    childrenByParent.set(folder.parentId, list);
  }
  const heightOf = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 1;
    seen.add(id);
    const children = childrenByParent.get(id) ?? [];
    if (children.length === 0) return 1;
    return 1 + Math.max(...children.map((child) => heightOf(child, seen)));
  };
  return heightOf(folderId, new Set());
}

/** Deepest level the relocated tree would occupy after the move. */
export function depthAfterRelocate(
  folderId: string,
  newParentId: string | null,
  folders: FolderParentLink[]
): number {
  const parentDepth = newParentId ? depthOf(newParentId, folders) : 0;
  return parentDepth + subtreeHeight(folderId, folders);
}

export function wouldCreateCycle(
  folderId: string,
  newParentId: string | null,
  folders: FolderParentLink[]
): boolean {
  if (!newParentId) return false;
  if (newParentId === folderId) return true;
  const byId = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  let current: string | null = newParentId;
  const seen = new Set<string>();
  while (current) {
    if (current === folderId) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    current = byId.has(current) ? (byId.get(current) ?? null) : null;
  }
  return false;
}

export function folderPath(
  folderId: string,
  folders: Array<{ id: string; parentId: string | null; name: string }>
): Array<{ id: string; name: string }> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: Array<{ id: string; name: string }> = [];
  let current: string | null = folderId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const folder = byId.get(current);
    if (!folder) break;
    path.unshift({ id: folder.id, name: folder.name });
    current = folder.parentId;
  }
  return path;
}
