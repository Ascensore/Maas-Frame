import { z } from 'zod';
import { graphicPresetSchema } from '@/lib/rough-cut/effects';
export const presetDefinitionSchema = graphicPresetSchema.omit({ id: true, version: true }).extend({
  name: z.string().trim().min(1).max(80),
  template: z.enum(['lower-third', 'callout', 'title-card']),
});
export function shapeEditPreset(row: {
  id: string;
  revision: number;
  definition: unknown;
  name: string;
}) {
  return {
    ...presetDefinitionSchema.parse(row.definition),
    id: row.id,
    name: row.name,
    version: row.revision,
  };
}
