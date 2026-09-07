import { z } from 'zod';
export const brollEvidenceSchema = z.object({
  version: z.literal(1),
  frames: z
    .array(z.object({ key: z.string(), seconds: z.number().finite().nonnegative() }))
    .length(3),
});
export type BrollEvidence = z.infer<typeof brollEvidenceSchema>;
export function parseBrollEvidence(value: unknown, versionId: string): BrollEvidence | null {
  const parsed = brollEvidenceSchema.safeParse(value);
  if (
    !parsed.success ||
    !parsed.data.frames.every(
      (f) =>
        f.key.startsWith('videos/broll-evidence/' + versionId + '/') &&
        /^videos\/broll-evidence\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[012]\.jpg$/.test(f.key)
    )
  )
    return null;
  return parsed.data;
}
