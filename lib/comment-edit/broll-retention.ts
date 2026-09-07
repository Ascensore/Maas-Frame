import { db } from '@/lib/db';
/** Current frames and immutable queued instructions both retain their sampled objects. */
export async function retainedBrollUrls(urls: string[]): Promise<string[]> {
  const prefix = '/api/upload/video/';
  const keys = urls
    .filter((url) => url.startsWith(prefix + 'broll-evidence/'))
    .map((url) => 'videos/' + url.slice(prefix.length));
  if (!keys.length) return [];
  const [versions, tasks] = await Promise.all([
    db.videoVersion.findMany({
      where: {
        OR: keys.map((key) => ({
          visualEvidence: { path: ['frames'], array_contains: [{ key }] },
        })),
      },
      select: { visualEvidence: true },
    }),
    db.commentEditTask.findMany({
      where: {
        OR: keys.map((key) => ({
          snapshot: {
            path: ['assets'],
            array_contains: [{ visualEvidence: { frames: [{ key }] } }],
          },
        })),
      },
      select: { snapshot: true },
    }),
  ]);
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) {
        if (key === 'key' && typeof v === 'string' && keys.includes(v)) found.add(v);
        else visit(v);
      }
    }
  };
  versions.forEach((v) => visit(v.visualEvidence));
  tasks.forEach((t) => visit(t.snapshot));
  return [...found].map((key) => prefix + key.slice('videos/'.length));
}
