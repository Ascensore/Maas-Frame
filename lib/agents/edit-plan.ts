import { z } from 'zod';
import type { EditPlan } from '@/lib/agents/types';

const timedOp = z
  .object({
    op: z.enum(['cut', 'keep']),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
  })
  .refine((value) => value.end >= value.start, {
    message: 'end must be greater than or equal to start',
  });

export const editPlanSchema = z.object({
  version: z.literal(1),
  operations: z
    .array(
      z.union([
        timedOp,
        z.object({
          op: z.literal('graphic'),
          start: z.number().finite().nonnegative(),
          end: z.number().finite().positive(),
          presetId: z.enum(['lower-third', 'callout']),
          title: z.string().trim().min(1).max(90),
          subtitle: z.string().trim().max(140),
        }),
        z.object({
          op: z.literal('broll'),
          start: z.number().finite().nonnegative(),
          end: z.number().finite().positive(),
          assetVersionId: z.string().min(1),
          sourceIn: z.number().finite().nonnegative(),
        }),
      ])
    )
    .max(100),
});

export function parseEditPlan(value: unknown): EditPlan {
  const parsed = editPlanSchema.parse(value);
  return {
    version: 1,
    operations: parsed.operations,
  };
}

export function emptyEditPlan(): EditPlan {
  return { version: 1, operations: [] };
}
