import { db } from '@/lib/db';
import { readVideoObjectBytes } from '@/lib/r2';
import { parseBrollEvidence } from '@/lib/rough-cut/broll-evidence-schema';
import type { CommentEditSnapshot } from './plan';
import type { AgentImage } from '@/lib/agents/types';
export async function loadBrollImages(
  snapshot: CommentEditSnapshot,
  projectId: string
): Promise<AgentImage[]> {
  const assets = (snapshot.assets ?? []).filter((a) => a.visualEvidence).slice(0, 8);
  if (!assets.length) return [];
  const allowed = await db.videoVersion.findMany({
    where: { id: { in: assets.map((a) => a.versionId) }, providerId: 'r2', video: { projectId } },
    select: { id: true },
  });
  if (allowed.length !== assets.length)
    throw new Error('A visual source is no longer available in this project.');
  const images: AgentImage[] = [];
  for (const asset of assets) {
    const evidence = parseBrollEvidence(asset.visualEvidence, asset.versionId);
    if (!evidence) throw new Error('Invalid visual evidence source');
    for (const frame of evidence.frames) {
      const image = await readVideoObjectBytes(frame.key, 262145);
      if (
        !image ||
        image.byteLength > 262144 ||
        image.byteLength < 4 ||
        image[0] !== 255 ||
        image[1] !== 216 ||
        image.at(-2) !== 255 ||
        image.at(-1) !== 217
      )
        throw new Error(
          'B-roll frames are unavailable. Analyze the asset and queue the feedback again.'
        );
      images.push({ versionId: asset.versionId, seconds: frame.seconds, image });
    }
  }
  return images;
}
