import { z } from 'zod';

/** Versioned, code-owned templates. Stored with every draft so later changes cannot restyle it. */
export const graphicPresetSchema = z.object({
  id: z.enum(['lower-third', 'callout']),
  version: z.literal(1),
  name: z.string(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  foreground: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export const GRAPHIC_PRESETS: z.infer<typeof graphicPresetSchema>[] = [
  {
    id: 'lower-third',
    version: 1,
    name: 'Ascensore lower third',
    accent: '#D7FF3F',
    foreground: '#FFFFFF',
    background: '#161616',
  },
  {
    id: 'callout',
    version: 1,
    name: 'Editorial callout',
    accent: '#D7FF3F',
    foreground: '#FFFFFF',
    background: '#161616',
  },
];

const timing = { start: z.number().finite().nonnegative(), end: z.number().finite().positive() };
export const timelineEffectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('graphic'),
    ...timing,
    preset: graphicPresetSchema,
    title: z.string().trim().min(1).max(90),
    subtitle: z.string().trim().max(140),
  }),
  z.object({
    kind: z.literal('broll'),
    ...timing,
    sourceVersionId: z.string().min(1),
    sourceIn: z.number().finite().nonnegative(),
    preset: z.literal('cover-muted-v1'),
  }),
]);
export type TimelineEffect = z.infer<typeof timelineEffectSchema>;

export type TimelineMapping = { start: number; end: number; output: number };
/** Split overlays at removals, carrying the B-roll's source position through each split. */
export function remapEffects(
  effects: TimelineEffect[],
  mapping: TimelineMapping[]
): TimelineEffect[] {
  return effects.flatMap((effect) =>
    mapping.flatMap((part) => {
      const from = Math.max(effect.start, part.start);
      const to = Math.min(effect.end, part.end);
      if (to <= from + 1e-6) return [];
      return [
        {
          ...effect,
          start: part.output + from - part.start,
          end: part.output + to - part.start,
          ...(effect.kind === 'broll' ? { sourceIn: effect.sourceIn + from - effect.start } : {}),
        },
      ];
    })
  );
}
