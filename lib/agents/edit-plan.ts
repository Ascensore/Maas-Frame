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
  operations: z.array(timedOp).max(100),
});

export function parseEditPlan(value: unknown): EditPlan {
  const parsed = editPlanSchema.parse(value);
  return {
    version: 1,
    operations: parsed.operations.map((operation) => ({
      op: operation.op,
      start: operation.start,
      end: operation.end,
    })),
  };
}

export function emptyEditPlan(): EditPlan {
  return { version: 1, operations: [] };
}
